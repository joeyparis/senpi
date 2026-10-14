## 2026-10-14 - Preserve permanent refresh rejection for credential failover

### What changed

- `packages/ai/src/auth/resolve.ts`: permanent OAuth exchange failures retain their existing error code, message and cause in a symbol-branded rejection error.
- `packages/ai/src/auth/resolve.ts`: OAuth-only providers resolve an explicit request token against its matching saved login, preserving that login's authentication checks and metadata instead of refreshing the flat default again. Unmatched API keys retain ordinary OAuth resolution.

### Why

- An invalidated refresh token could reach a credential pool without a structured HTTP status, so it failed the request instead of selecting a healthy login.
- Compaction could resolve a healthy pooled token but lose it when the subsequent OAuth-only request ignored the explicit token override.

### Why an extension could not handle it

- `packages/ai/src/auth/resolve.ts` maps authentication failures before provider requests and extension recovery hooks.

### Expected merge conflict zones

- `packages/ai/src/auth/resolve.ts`: OAuth error imports, request-token overrides and `oauthRefreshModelsError`.

## 2026-10-09 - Restore auth-tracker coverage for upstream-modified paths (senpi#3006)

### What changed

- `packages/ai/src/auth/credential-store.ts`: documentation only; the store comment says an entry may be pooled.
- `packages/ai/src/auth/helpers.ts`: shared auth helpers carried through the v0.99.1 sync and Copilot token re-exchange (senpi#2297).
- `packages/ai/src/auth/types.ts`: auth resolution types — ambient shared-cloud credential chains (senpi#2327), immutable account ids (senpi#1495), and the `ApiKeyAuth.ambientOnly` compatibility marker.

These files were covered by the parent tracker until senpi#2895 added this nearer tracker without listing them, hiding them from the audit's exact-nearest-tracker rule.

### Why

The repository audit requires every upstream-modified production path to be named by an entry in its exact nearest changes.md tracker. senpi#2895 introduced this tracker and named only the two files it touched, so the 3 pre-existing upstream-modified files beneath it lost the coverage the parent tracker had provided and were reported uncovered.

### Why an extension could not handle it

changes.md coverage is fork-owned documentation metadata; no extension or runtime hook can supply it.

### Expected merge conflict zones

- The `ApiKeyAuth` / auth-resolution type fields (ambient markers, account-id metadata) in `packages/ai/src/auth/types.ts`, against upstream auth-contract changes.
- The `rejectedTokenStatuses` passthrough in `packages/ai/src/auth/helpers.ts`, against upstream changes to the OAuth refresh input shape.
- The doc comment in `packages/ai/src/auth/credential-store.ts` (an entry may be pooled), against upstream edits to the same comment; the code is unchanged.

## 2026-10-07 - Preserve transient OAuth exchange failures (senpi#2893)

### What changed

- `packages/ai/src/auth/oauth-refresh.ts`: preserve caller cancellation; log one JSON-encoded provider/optional-slot/closed-cause line per transient exchange without changing stored credentials. JSON encoding prevents object inspection or embedded newlines from splitting the log record.
- `packages/ai/src/auth/resolve.ts`: map transient exchanges to a symbol-branded OAuth ModelsError while preserving permanent errors and message text.

### Why

Transport failures during refresh lost their retryability and ended unattended turns.

### Why an extension could not handle it

Exchange classification and credential resolution happen before provider requests or extension recovery hooks.

### Expected merge conflict zones

- The exchange catch in `oauth-refresh.ts` and error mapping in `resolve.ts`.
