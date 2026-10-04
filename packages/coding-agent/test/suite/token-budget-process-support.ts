import { once } from "node:events";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { FILE_STORAGE_LOCK_OPTIONS } from "../../src/core/lockfile-policy.ts";
import { budgetAuxiliaryRequest } from "../../src/core/provider-token-budget.ts";
import { TokenBudgetLedger } from "../../src/core/token-budget.ts";

const [directory, sessionId, bound, holdLock] = z
	.tuple([z.string(), z.string(), z.coerce.number().int().positive(), z.enum(["hold", "free"])])
	.parse(process.argv.slice(2));
const ledger = new TokenBudgetLedger(directory, "root");
const release =
	holdLock === "hold"
		? lockfile.lockSync(join(directory, Buffer.from("root").toString("hex")), FILE_STORAGE_LOCK_OPTIONS)
		: undefined;
const start = once(process, "message", { signal: AbortSignal.timeout(5_000) });
process.send?.({ phase: "ready" });
await start;
release?.();

let sends = 0;
try {
	await budgetAuxiliaryRequest(
		{ ledger, sessionId },
		bound,
		async () => {
			sends++;
			const complete = once(process, "message", { signal: AbortSignal.timeout(5_000) });
			process.send?.({ phase: "dispatched", sends });
			await complete;
			return { input: 10, cacheRead: 20, cacheWrite: 30, output: 40 };
		},
		(result) => result,
	);
	process.send?.({ phase: "settled", sends });
} catch (error) {
	if (!(error instanceof Error)) throw error;
	process.send?.({
		phase: "denied",
		sends,
		name: error.name,
		...("code" in error ? { code: error.code } : {}),
	});
}
process.disconnect?.();
