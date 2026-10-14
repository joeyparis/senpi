import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { OAuthRefreshExchangeError } from "../src/auth/oauth-refresh.ts";
import { oauthRefreshModelsError, resolveProviderAuth } from "../src/auth/resolve.ts";
import {
	classifyOAuthRefreshFailure,
	isOAuthRefreshRejectedError,
	isOAuthRefreshUnavailableError,
	OAuthTokenEndpointError,
} from "../src/utils/oauth-refresh-error.ts";

describe("transient OAuth refresh failures (#2893)", () => {
	afterEach(() => vi.restoreAllMocks());

	it.each([
		...[
			"ConnectionRefused",
			"FailedToOpenSocket",
			"ECONNREFUSED",
			"ECONNRESET",
			"ENOTFOUND",
			"EAI_AGAIN",
			"ETIMEDOUT",
			"EPIPE",
			"UND_ERR_CONNECT_TIMEOUT",
			"UND_ERR_SOCKET",
		].map((code) => [Object.assign(new TypeError("opaque"), { code }), "transient"] as const),
		...["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_SOCKET"].map(
			(code) =>
				[
					new TypeError("fetch failed", { cause: Object.assign(new Error("opaque"), { code }) }),
					"transient",
				] as const,
		),
		[new DOMException("opaque", "TimeoutError"), "transient"],
		...[408, 429, 500, 503, 599].map(
			(status) => [new OAuthTokenEndpointError("opaque", status), "transient"] as const,
		),
		...[400, 401, 403].map((status) => [new OAuthTokenEndpointError("invalid_grant", status), "permanent"] as const),
		[new Error("connection refused 503"), "permanent"],
		[Object.assign(new Error("opaque"), { code: "UND_ERR_INVALID_ARG" }), "permanent"],
	] as const)("classifies structured failure %o as %s", (cause, classification) => {
		expect(classifyOAuthRefreshFailure(cause)).toBe(classification);
		const mapped = oauthRefreshModelsError(new OAuthRefreshExchangeError(cause), "fixture");
		expect(isOAuthRefreshUnavailableError(mapped)).toBe(classification === "transient");
		expect(isOAuthRefreshRejectedError(mapped)).toBe(classification === "permanent");
		expect(mapped.code).toBe("oauth");
	});

	it("recognizes the unavailable brand across bundle copies", () => {
		expect(isOAuthRefreshUnavailableError({ [Symbol.for("senpi.oauthRefreshUnavailable")]: true })).toBe(true);
		expect(
			isOAuthRefreshUnavailableError(
				new Error("pool exhausted", { cause: { [Symbol.for("senpi.oauthRefreshUnavailable")]: true } }),
			),
		).toBe(true);
		expect(isOAuthRefreshUnavailableError(new Error("OAuth refresh unavailable"))).toBe(false);
	});

	it("recognizes rejected refreshes across bundle copies and wrapped pool errors", () => {
		// Given an error from another bundle, wrapped by credential failover.
		const rejection = { [Symbol.for("senpi.oauthRefreshRejected")]: true };
		const wrapped = new Error("pool exhausted", { cause: rejection });

		// When authentication recovery inspects the structured failure.
		const rejected = isOAuthRefreshRejectedError(wrapped);

		// Then it remains credential-scoped without matching provider prose.
		expect(rejected).toBe(true);
		expect(isOAuthRefreshRejectedError(new Error("refresh_token_invalidated"))).toBe(false);
	});

	it("terminates safely on cyclic causes", () => {
		const cycle = new Error("unknown");
		cycle.cause = cycle;
		expect(classifyOAuthRefreshFailure(cycle)).toBe("permanent");
		expect(isOAuthRefreshUnavailableError(cycle)).toBe(false);
		expect(isOAuthRefreshRejectedError(cycle)).toBe(false);
	});

	it("keeps stored credentials byte-identical on failure and recovers on the next exchange", async () => {
		const credentials = new InMemoryCredentialStore();
		const stored = { type: "oauth" as const, access: "fixture-access", refresh: "fixture-refresh", expires: 1 };
		await credentials.modify("fixture", async () => stored);
		let calls = 0;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const provider = {
			id: "fixture",
			auth: {
				oauth: {
					name: "fixture",
					login: async () => stored,
					refresh: async () => {
						if (++calls === 1) throw Object.assign(new TypeError("opaque"), { code: "ConnectionRefused" });
						return { ...stored, access: "fixture-next", expires: Date.now() + 3_600_000 };
					},
					toAuth: async (credential: typeof stored) => ({ apiKey: credential.access }),
				},
			},
		};
		const context = { env: async () => undefined, fileExists: async () => false };
		await expect(resolveProviderAuth(provider, credentials, context)).rejects.toSatisfy(
			isOAuthRefreshUnavailableError,
		);
		expect(await credentials.read("fixture")).toEqual(stored);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]).toEqual([
			"OAuth refresh unavailable",
			JSON.stringify({ provider: "fixture", cause: "connection_refused" }),
		]);
		expect(JSON.stringify(warn.mock.calls)).not.toContain("fixture-refresh");
		expect((await resolveProviderAuth(provider, credentials, context))?.auth.apiKey).toBe("fixture-next");
		expect(calls).toBe(2);
	});

	it("uses a resolved request token instead of refreshing an OAuth-only provider's stale default", async () => {
		// Given a previously resolved token and an invalidated stored default.
		const credentials = new InMemoryCredentialStore();
		const stored = {
			type: "oauth" as const,
			access: "stale-access",
			refresh: "stale-refresh",
			expires: 1,
			accounts: [
				{ name: "default", access: "stale-access", refresh: "stale-refresh", expires: 1, source: "login" as const },
				{
					name: "healthy",
					access: "healthy-access",
					refresh: "healthy-refresh",
					expires: Date.now() + 3_600_000,
					source: "login" as const,
				},
			],
		};
		await credentials.modify("fixture", async () => stored);
		const refresh = vi.fn(async () => {
			throw new OAuthTokenEndpointError("refresh_token_invalidated", 401);
		});
		const provider = {
			id: "fixture",
			auth: {
				oauth: {
					name: "fixture",
					login: async () => stored,
					refresh,
					toAuth: async (credential: { access: string }) => ({ apiKey: credential.access }),
				},
			},
		};

		// When an auxiliary request reuses that resolved authentication.
		const auth = await resolveProviderAuth(
			provider,
			credentials,
			{ env: async () => undefined, fileExists: async () => false },
			{ apiKey: "healthy-access" },
		);

		// Then the request uses that token without another refresh or store mutation.
		expect(auth?.auth.apiKey).toBe("healthy-access");
		expect(refresh).not.toHaveBeenCalled();
		expect(await credentials.read("fixture")).toEqual(stored);
	});

	it("propagates caller abort rather than an exchange failure", async () => {
		const credentials = new InMemoryCredentialStore();
		const stored = { type: "oauth" as const, access: "fixture", refresh: "fixture", expires: 1 };
		await credentials.modify("fixture", async () => stored);
		const controller = new AbortController();
		const reason = new DOMException("cancelled", "AbortError");
		const provider = {
			id: "fixture",
			auth: {
				oauth: {
					name: "fixture",
					login: async () => stored,
					refresh: async () => {
						controller.abort(reason);
						throw Object.assign(new Error("opaque"), { code: "ConnectionRefused" });
					},
					toAuth: async () => ({ apiKey: "fixture" }),
				},
			},
		};
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await expect(
			resolveProviderAuth(
				provider,
				credentials,
				{ env: async () => undefined, fileExists: async () => false },
				{ signal: controller.signal },
			),
		).rejects.toBe(reason);
		expect(await credentials.read("fixture")).toEqual(stored);
		// A caller abort is not a refresh failure: no transient-refresh log line for it.
		expect(warn.mock.calls.filter((call) => call[0] === "OAuth refresh unavailable")).toEqual([]);
		warn.mockRestore();
	});
});
