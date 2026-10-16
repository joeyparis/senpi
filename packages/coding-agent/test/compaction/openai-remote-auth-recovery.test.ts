import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { listSlots } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import { runOpenAiRemoteCompaction } from "../../src/core/extensions/builtin/compaction/openai-remote.ts";
import {
	createOpenAiRemoteCompactionHeaders,
	openAiRemoteCompactionOrigin,
} from "../../src/core/extensions/builtin/compaction/openai-remote-model.ts";
import type { SessionBeforeCompactEvent } from "../../src/core/extensions/types.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";

const MODEL = {
	id: "remote-auth-test",
	name: "Remote auth test",
	provider: "chatgpt-subscription",
	api: "openai-codex-responses",
	baseUrl: "http://localhost:0",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 1_000,
} satisfies Model<"openai-codex-responses">;

function token(account: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } }),
	).toString("base64url");
	return `synthetic.${payload}.signature`;
}

const EXPIRED = token("expired-account");
const HEALTHY = token("healthy-account");
const SESSION_ID = "remote-auth-session";
const directories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function event(signal = new AbortController().signal): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		reason: "threshold",
		willRetry: false,
		requestId: "remote-auth-request",
		signal,
		branchEntries: [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-10-16T00:00:00.000Z",
				message: { role: "user", content: "Inspect the build.", timestamp: 1 },
			},
		],
		preparation: {
			firstKeptEntryId: "u1",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 12_000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: DEFAULT_COMPACTION_SETTINGS,
		},
	};
}

async function setup(options: { refuse?: boolean; refresh?: (signal?: AbortSignal) => Promise<void> } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "remote-compaction-auth-"));
	directories.push(directory);
	const credentials = AuthStorage.inMemory({
		[MODEL.provider]: {
			type: "oauth",
			access: EXPIRED,
			refresh: "synthetic-expired-refresh",
			expires: 0,
			pinned: "default",
			accounts: [
				{
					name: "default",
					access: EXPIRED,
					refresh: "synthetic-expired-refresh",
					expires: 0,
					source: "login",
				},
				{
					name: "healthy",
					access: HEALTHY,
					refresh: "synthetic-healthy-refresh",
					expires: Number.MAX_SAFE_INTEGER,
					source: "login",
				},
			],
		},
	});
	const runtime = await ModelRuntime.create({
		credentials,
		agentDir: directory,
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const attempts: SimpleStreamOptions[] = [];
	const refresh = vi.fn(async (signal?: AbortSignal) => {
		if (options.refresh) return options.refresh(signal);
		throw new Error("invalid_grant: unauthorized synthetic refresh");
	});
	await runtime.registerProvider(MODEL.provider, {
		name: "Synthetic remote OAuth",
		api: MODEL.api,
		baseUrl: MODEL.baseUrl,
		oauth: {
			name: "Synthetic OAuth",
			login: async () => {
				throw new Error("Login must not run");
			},
			refreshToken: async (credential, signal) => {
				await refresh(signal);
				return { ...credential, expires: Number.MAX_SAFE_INTEGER };
			},
			getApiKey: (credential) => credential.access,
		},
		models: [MODEL],
		streamSimple: (_model, _context, streamOptions) => {
			if (streamOptions) attempts.push(streamOptions);
			const stream = createAssistantMessageEventStream();
			const message = {
				...fauxAssistantMessage(
					[
						{
							type: "providerNative",
							subtype: "compaction",
							raw: { type: "compaction", id: "cmp_auth", encrypted_content: "synthetic-checkpoint" },
						},
					],
					{ timestamp: 1_792_108_800_000 },
				),
				api: MODEL.api,
				provider: MODEL.provider,
				model: MODEL.id,
			};
			if (options.refuse && streamOptions?.apiKey === HEALTHY) {
				stream.push({
					type: "error",
					reason: "error",
					error: { ...message, content: [], stopReason: "error", errorMessage: "401 unauthorized" },
				});
			} else {
				stream.push({ type: "done", reason: "stop", message });
			}
			stream.end();
			return stream;
		},
	});
	const registry = new ModelRegistry(runtime);
	const resolveAuth = vi.spyOn(registry, "getApiKeyAndHeaders");
	const emitted: unknown[] = [];
	const fetch = vi.fn(async () => {
		throw new Error("The subscription route must not call the compact endpoint");
	});
	const context = {
		model: MODEL,
		modelRegistry: registry,
		sessionManager: { getSessionId: () => SESSION_ID },
		serviceTier: undefined,
		getSystemPrompt: () => "Synthetic system prompt",
	};
	const run = (request = event()) =>
		runOpenAiRemoteCompaction(context, request, (entry) => emitted.push(entry), { fetch });
	return { run, context, credentials, resolveAuth, refresh, attempts, emitted, fetch };
}

describe("remote compaction OAuth recovery", () => {
	it("recovers an invalid default refresh using a healthy sibling with session-scoped provenance", async () => {
		// Given: a pinned expired default account and a healthy sibling in real auth storage.
		const harness = await setup();
		const request = event();

		// When: the remote route resolves auth and sends through the real model runtime.
		const result = await harness.run(request);

		// Then: auth resolution receives the caller's cancellation and affinity identity.
		expect(harness.resolveAuth).toHaveBeenCalledWith(MODEL, {
			signal: request.signal,
			sessionId: SESSION_ID,
		});
		expect(harness.refresh).toHaveBeenCalledOnce();
		expect(harness.attempts).toHaveLength(1);
		expect(harness.attempts[0]).toMatchObject({ apiKey: HEALTHY, sessionId: SESSION_ID });
		expect(result?.details.transport).toBe("responses-v2");
		const headers = createOpenAiRemoteCompactionHeaders(MODEL, { apiKey: HEALTHY }, SESSION_ID);
		if (!headers) throw new Error("Expected synthetic auth headers");
		expect(result?.details.origin).toEqual(openAiRemoteCompactionOrigin(MODEL, headers));
		const serialized = JSON.stringify({ result, events: harness.emitted });
		for (const secret of [EXPIRED, HEALTHY, "synthetic-expired-refresh", "synthetic-healthy-refresh"]) {
			expect(serialized).not.toContain(secret);
		}
		expect(harness.fetch).not.toHaveBeenCalled();
	});

	it("falls back without a checkpoint when the selected remote account is refused", async () => {
		// Given: after auth resolves, a request hook adds and pins a healthy account
		// that would succeed if the runtime silently rotated away from the selected account.
		const harness = await setup({ refuse: true });

		// When
		const result = await runOpenAiRemoteCompaction(
			{
				...harness.context,
				prepareProviderRequest: async (messages) => {
					await harness.credentials.modify(MODEL.provider, async (current) => {
						if (current?.type !== "oauth") throw new Error("Expected pooled OAuth credentials");
						return {
							...current,
							pinned: "other",
							accounts: [
								...listSlots(current),
								{
									name: "other",
									access: token("other-account"),
									refresh: "synthetic-other-refresh",
									expires: Number.MAX_SAFE_INTEGER,
									source: "login",
								},
							],
						};
					});
					return {
						messages,
						transformHeaders: async (headers) => headers,
						transformPayload: async (payload) => payload,
					};
				},
			},
			event(),
			(entry) => harness.emitted.push(entry),
			{ fetch: harness.fetch },
		);

		// Then: refusal requests local summarization, not a checkpoint from the other account.
		expect(result).toBeUndefined();
		expect(harness.attempts).toHaveLength(1);
		expect(harness.attempts[0]?.apiKey).toBe(HEALTHY);
		expect(harness.refresh).toHaveBeenCalledOnce();
		expect(harness.emitted).not.toContainEqual(expect.objectContaining({ action: "remote_completed" }));
		expect(harness.fetch).not.toHaveBeenCalled();
	});

	it("propagates abort during OAuth refresh without reporting a credential failure or dispatching", async () => {
		// Given: auth refresh is suspended on an explicit event, not a timer.
		const started = Promise.withResolvers<AbortSignal | undefined>();
		const release = Promise.withResolvers<void>();
		const harness = await setup({
			refresh: async (signal) => {
				started.resolve(signal);
				await release.promise;
				signal?.throwIfAborted();
			},
		});
		const controller = new AbortController();
		const reason = new DOMException("Synthetic compaction cancellation", "AbortError");
		const pending = harness.run(event(controller.signal));
		const outcome = expect(pending).rejects.toBe(reason);
		const refreshSignal = await started.promise;

		// When
		controller.abort(reason);
		release.resolve();

		// Then
		await outcome;
		expect(refreshSignal?.aborted).toBe(true);
		expect(harness.attempts).toEqual([]);
		expect(harness.emitted).toEqual([]);
		expect(harness.fetch).not.toHaveBeenCalled();
	});
});
