import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	createModels,
	createProvider,
	fauxAssistantMessage,
	isRetryableAssistantError,
	lazyStream,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { OAuthRefreshUnavailableError } from "@earendil-works/pi-ai/utils/oauth-refresh-error";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalFailureAssistantMessage } from "../../../agent/src/assistant-terminal-state.ts";
import { OAuthRefreshExchangeError } from "../../../ai/src/auth/oauth-refresh.ts";
import { oauthRefreshModelsError } from "../../../ai/src/auth/resolve.ts";
import { classifyCredentialFailure } from "../../src/core/credential-pool/classify.ts";
import { streamWithCredentialRotation } from "../../src/core/credential-pool/rotation-stream.ts";
import { CredentialSlotRepository } from "../../src/core/credential-pool/state-store.ts";
import {
	createSpeculativeCompactionSnapshot,
	runExtensionCompaction,
	type SpeculativeCompactionContext,
} from "../../src/core/extensions/builtin/compaction/speculative.ts";
import { getModelRuntime } from "../model-runtime-test-utils.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const refused = () => Object.assign(new TypeError("opaque transport failure"), { code: "ConnectionRefused" });
const stale = { type: "oauth" as const, access: "fixture-access", refresh: "fixture-refresh", expires: 1 };
const recoveryOperations = [
	"turn",
	"compaction",
	"extension compaction",
	"provider authentication",
	"exhausted pool",
	"exhausted extension compaction",
] as const;
let home: string;

function extensionCompactionContext(harness: Harness): SpeculativeCompactionContext {
	return {
		model: harness.getModel(),
		modelRegistry: harness.modelRegistry,
		sessionManager: harness.sessionManager,
		getContextUsage: () => undefined,
		getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 }),
		getMessageRevision: () => 1,
		applyCompaction: async () => ({ applied: true, reason: "ok" }),
	};
}

async function refusedTransport(): Promise<Error> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	try {
		await fetch(`http://127.0.0.1:${address.port}`, { signal: AbortSignal.timeout(1_000) });
	} catch (error) {
		expect(error).toMatchObject({ cause: { code: "ECONNREFUSED" } });
		return new Error("opaque transport failure", { cause: error });
	}
	throw new Error("Expected the closed local endpoint to refuse the connection");
}

async function fixture() {
	const harness = await createHarness({
		models: [{ id: "faux-1" }, { id: "faux-2" }],
		settings: {
			compaction: { enabled: false, keepRecentTokens: 1, speculativeEnabled: false, idleCompactionEnabled: false },
			retry: { enabled: true, maxRetries: 2, baseDelayMs: 10, fallbackChains: { "faux/faux-1": ["faux/faux-2"] } },
		},
	});
	harnesses.push(harness);
	let refreshes = 0;
	const provider = createProvider({
		id: "faux",
		name: "fixture",
		api: { stream: streamSimple, streamSimple },
		baseUrl: "https://fixture.example",
		models: [],
		auth: {
			oauth: {
				name: "fixture",
				login: async () => stale,
				refresh: async () => {
					if (++refreshes === 1) throw await refusedTransport();
					return { ...stale, access: "fixture-next", expires: Date.now() + 3_600_000 };
				},
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
	});
	await harness.authStorage.modify("faux", async () => stale);
	const models = createModels({ credentials: harness.authStorage });
	models.setProvider(provider);
	vi.spyOn(getModelRuntime(harness.modelRegistry), "getAuth").mockImplementation(async (_model, overrides) =>
		models.getAuth("faux", overrides),
	);
	return { harness, models, refreshes: () => refreshes };
}

/** Arm the exact retry event before the operation, then advance its backoff clock. */
async function withRetryClock(
	harness: Harness,
	eventType: "auto_retry_start" | "summarization_retry_scheduled",
	operation: () => Promise<unknown>,
) {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	let release!: (delay: number) => void;
	const scheduled = new Promise<number>((resolve) => {
		release = resolve;
	});
	const unsubscribe = harness.session.subscribe((event) => {
		if (event.type === eventType && "delayMs" in event) release(event.delayMs);
	});
	const running = operation();
	const settled = running.then(() => {
		throw new Error("Operation settled without scheduling its required retry");
	});
	try {
		const delay = await Promise.race([scheduled, settled]);
		await vi.advanceTimersByTimeAsync(delay);
		await running;
	} finally {
		unsubscribe();
		vi.useRealTimers();
	}
}

describe("OAuth same-model recovery (#2893)", () => {
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "senpi-2893-home-"));
		vi.stubEnv("HOME", home);
		vi.stubEnv("SENPI_CODING_AGENT_DIR", join(home, "agent"));
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.useRealTimers();
		while (harnesses.length) harnesses.pop()?.cleanup();
		rmSync(home, { recursive: true, force: true });
	});

	it("marks opaque terminal refresh failures structurally before prose classification", async () => {
		const { harness } = await fixture();
		const model = harness.getModel();
		const terminal = createTerminalFailureAssistantMessage(
			model,
			"error",
			new OAuthRefreshUnavailableError("faux", refused()),
			null,
		);
		expect(terminal.diagnostics).toMatchObject([
			{ type: "oauth_refresh_unavailable", details: { provider: "faux" } },
		]);
		expect(isRetryableAssistantError(terminal)).toBe(true);
	});

	it("completes a top-level turn with exactly one retry and no fallback", async () => {
		const { harness, models, refreshes } = await fixture();
		harness.agent.streamFunction = (model, context, options) => models.streamSimple(model, context, options);
		harness.setResponses([fauxAssistantMessage("recovered")]);
		await withRetryClock(harness, "auto_retry_start", () => harness.session.prompt("hello"));
		expect(refreshes()).toBe(2);
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1);
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		expect(harness.eventsOfType("model_changed")).toEqual([]);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("retries the same pooled child slot without blocking it", async () => {
		const { harness, models, refreshes } = await fixture();
		const pooled = {
			...stale,
			accounts: [
				{ name: "alpha", access: stale.access, refresh: stale.refresh, expires: 1, source: "login" as const },
				{ name: "bravo", access: "fixture-bravo", refresh: "fixture-bravo", expires: 1, source: "login" as const },
			],
		};
		await harness.authStorage.modify("faux", async () => pooled);
		const repository = new CredentialSlotRepository(`${harness.tempDir}/pool.json`);
		const blocks = vi.spyOn(repository, "mutateSlotState");
		const slots: string[] = [];
		harness.setResponses([fauxAssistantMessage("child recovered")]);
		harness.agent.streamFunction = (model, context, options) =>
			lazyStream(model, async () =>
				streamWithCredentialRotation({
					sources: {
						providerId: "faux",
						credential: pooled,
						env: () => undefined,
						repository,
						policy: { affinity: false },
					},
					modelId: model.id,
					runAttempt: async (slot) => {
						slots.push(slot.name);
						const auth = await models.getAuth("faux", { slotName: slot.name, signal: options?.signal });
						return streamSimple(model, context, { ...options, apiKey: auth?.auth.apiKey });
					},
				}),
			);
		await harness.session.prompt("child request");
		expect(slots).toEqual(["alpha", "alpha"]);
		expect(refreshes()).toBe(2);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.eventsOfType("model_changed")).toEqual([]);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(blocks.mock.calls.every((call) => call[3](undefined) === undefined)).toBe(true);
		expect((await repository.listSlots("faux", "stored")).alpha?.blockReason).toBeUndefined();
	});

	it("classifies branded refresh failures before status prose can block a slot", () => {
		expect(classifyCredentialFailure(new OAuthRefreshUnavailableError("faux", refused()))).toEqual({
			kind: "retry_same",
			maxAttempts: 2,
		});
		expect(classifyCredentialFailure(new Error("opaque permanent refresh failure"))).toEqual({
			kind: "fail_request",
		});
	});

	it("fails over when a refresh token is invalidated without a structured HTTP status", () => {
		// Given the error emitted by the ChatGPT refresh exchange.
		const failure = oauthRefreshModelsError(
			new OAuthRefreshExchangeError(
				new Error(
					'ChatGPT Subscription token refresh failed (401): {"error":{"code":"refresh_token_invalidated"}}',
				),
			),
			"faux",
		);

		// When the pool classifies the refresh rejection.
		const action = classifyCredentialFailure(failure);

		// Then only this credential is blocked, allowing a healthy sibling.
		expect(action).toEqual({ kind: "failover", block: { reason: "auth_error" } });
	});

	it.each(recoveryOperations)(
		"handles %s during normal requests and extension summarization when the pinned OAuth refresh token is invalidated",
		async (operation) => {
			// Given an expired, pinned login and a healthy sibling.
			const harness = await createHarness({
				withConfiguredAuth: false,
				settings: {
					compaction: {
						enabled: false,
						keepRecentTokens: 1,
						speculativeEnabled: false,
						idleCompactionEnabled: false,
					},
					retry: { enabled: false },
				},
			});
			harnesses.push(harness);
			const runtime = getModelRuntime(harness.modelRegistry);
			const refreshes: string[] = [];
			const credential = {
				...stale,
				pinned: "default",
				accounts: [
					{ name: "default", access: stale.access, refresh: stale.refresh, expires: 1, source: "login" as const },
					{
						name: "healthy",
						access: "healthy-access",
						refresh: "healthy-refresh",
						expires: operation.startsWith("exhausted") ? 1 : Date.now() + 3_600_000,
						source: "login" as const,
					},
				],
			};
			await harness.authStorage.modify("faux", async () => credential);
			await runtime.registerNativeProvider(
				createProvider({
					id: "faux",
					name: "fixture",
					api: { stream: streamSimple, streamSimple },
					baseUrl: "https://fixture.example",
					models: harness.models,
					auth: {
						oauth: {
							name: "fixture",
							login: async () => stale,
							refresh: async (current) => {
								refreshes.push(current.refresh);
								throw new Error(
									'ChatGPT Subscription token refresh failed (401): {"error":{"code":"refresh_token_invalidated"}}',
								);
							},
							toAuth: async (current) => ({ apiKey: current.access }),
						},
					},
				}),
			);
			await runtime.refresh({ allowNetwork: false, providers: ["faux"] });
			refreshes.length = 0;
			harness.agent.streamFunction = (model, context, options) => runtime.streamSimple(model, context, options);
			if (operation.includes("compaction")) {
				for (let i = 0; i < 4; i++) {
					harness.sessionManager.appendMessage({
						role: "user",
						content: `history ${i} `.repeat(100),
						timestamp: i,
					});
					harness.sessionManager.appendMessage(fauxAssistantMessage(`answer ${i} `.repeat(100)));
				}
				harness.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			}
			harness.setResponses([fauxAssistantMessage("recovered"), fauxAssistantMessage("prefix summary")]);

			// When a real session turn or compaction needs authentication.
			if (operation === "provider authentication") {
				const auth = await runtime.getAuth("faux");
				expect(auth?.auth.apiKey).toBe("healthy-access");
				expect(refreshes).toEqual(["fixture-refresh"]);
				expect(harness.faux.getCallLog()).toEqual([]);
				return;
			}
			if (operation === "exhausted pool") {
				await expect(runtime.getAuth(harness.getModel())).rejects.toMatchObject({
					action: { kind: "failover", block: { reason: "auth_error" } },
				});
				// Every login is attempted once, with no provider call or retry loop.
				expect(refreshes).toEqual(["fixture-refresh", "healthy-refresh"]);
				expect(harness.faux.getCallLog()).toEqual([]);
				return;
			}
			if (operation.includes("extension compaction")) {
				const context = extensionCompactionContext(harness);
				const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1 });
				if (!snapshot) throw new Error("Expected compaction preparation");
				const before = harness.sessionManager.getEntries();
				if (operation === "exhausted extension compaction") {
					await expect(runExtensionCompaction(context, snapshot)).rejects.toMatchObject({
						kind: "auth",
						cause: { action: { kind: "failover", block: { reason: "auth_error" } } },
					});
					expect(refreshes).toEqual(["fixture-refresh", "healthy-refresh"]);
					expect(harness.faux.getCallLog()).toEqual([]);
				} else {
					expect((await runExtensionCompaction(context, snapshot))?.summary).toBe("recovered");
					expect(harness.faux.getCallLog()[0]?.options?.apiKey).toBe("healthy-access");
					expect(refreshes).toEqual(["fixture-refresh"]);
				}
				expect(harness.sessionManager.getEntries()).toEqual(before);
				return;
			}
			if (operation === "turn") await harness.session.prompt("hello");
			else await harness.session.compact();

			// Then it uses the healthy login without a model switch or turn retry.
			expect(harness.faux.getCallLog().length).toBeGreaterThan(0);
			expect(harness.faux.getCallLog().every((call) => call.options?.apiKey === "healthy-access")).toBe(true);
			expect(refreshes.filter((refresh) => refresh === stale.refresh)).toHaveLength(1);
			expect(harness.eventsOfType("model_changed")).toEqual([]);
			expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
			if (operation === "turn") {
				expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
			} else {
				expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
			}
		},
	);

	it.each(["standard", "custom"] as const)(
		"compacts through %s auth after exactly one authentication retry",
		async (kind) => {
			const { harness, refreshes } = await fixture();
			if (kind === "custom") {
				harness.agent.streamFunction = (model, context, options) => streamSimple(model, context, options);
			}
			for (let i = 0; i < 4; i++) {
				harness.sessionManager.appendMessage({ role: "user", content: `history ${i} `.repeat(100), timestamp: i });
				harness.sessionManager.appendMessage(fauxAssistantMessage(`answer ${i} `.repeat(100)));
			}
			harness.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			harness.setResponses([
				fauxAssistantMessage("completed summary"),
				fauxAssistantMessage("completed prefix summary"),
			]);
			await withRetryClock(harness, "summarization_retry_scheduled", () => harness.session.compact());
			expect(refreshes()).toBe(2);
			expect(harness.eventsOfType("summarization_retry_scheduled")).toHaveLength(1);
			expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
			expect(harness.session.model?.id).toBe("faux-1");
			expect(harness.eventsOfType("model_changed")).toEqual([]);
		},
	);

	it("re-exchanges a refused access token during extension summarization", async () => {
		// Given a valid-looking OAuth token that the provider has revoked.
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const runtime = getModelRuntime(harness.modelRegistry);
		const credential = { ...stale, expires: Date.now() + 3_600_000 };
		await harness.authStorage.modify("faux", async () => credential);
		const refresh = vi.fn(async () => ({ ...credential, access: "renewed-access" }));
		await runtime.registerNativeProvider(
			createProvider({
				id: "faux",
				name: "fixture",
				baseUrl: "https://fixture.example",
				models: harness.models,
				api: {
					stream: (model, context, options) => {
						if (options?.apiKey === "renewed-access") return streamSimple(model, context, options);
						const result = createAssistantMessageEventStream();
						const message = {
							...fauxAssistantMessage("", { stopReason: "error", errorMessage: "Access token revoked" }),
							providerDiagnostic: {
								category: "auth" as const,
								evidence: "structured_status" as const,
								httpStatus: 401,
							},
						};
						result.push({ type: "error", reason: "error", error: message });
						result.end(message);
						return result;
					},
					streamSimple,
				},
				auth: {
					oauth: {
						name: "fixture",
						login: async () => credential,
						refresh,
						rejectedTokenStatuses: [401],
						toAuth: async (current) => ({ apiKey: current.access }),
					},
				},
			}),
		);
		for (let i = 0; i < 4; i++) {
			harness.sessionManager.appendMessage({ role: "user", content: `history ${i} `.repeat(100), timestamp: i });
			harness.sessionManager.appendMessage(fauxAssistantMessage(`answer ${i} `.repeat(100)));
		}
		const context = extensionCompactionContext(harness);
		const snapshot = createSpeculativeCompactionSnapshot(context, { generation: 1 });
		if (!snapshot) throw new Error("Expected compaction preparation");
		harness.setResponses([fauxAssistantMessage("renewed summary")]);

		// When summarization reaches request-time token recovery.
		const result = await runExtensionCompaction(context, snapshot);

		// Then exactly one re-exchange succeeds without changing models or losing history.
		expect(result?.summary).toBe("renewed summary");
		expect(refresh).toHaveBeenCalledOnce();
		expect(harness.faux.getCallLog()[0]?.options?.apiKey).toBe("renewed-access");
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});
});
