import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	budgetProviderAttempt,
	currentTokenBudgetOwner,
	processedTokens,
	withTokenBudgetOwner,
} from "../../src/core/provider-token-budget.ts";
import { TokenBudgetLedger, TokenBudgetPausedError } from "../../src/core/token-budget.ts";

describe("provider token admission", () => {
	let directory: string;
	let ledger: TokenBudgetLedger;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "senpi-provider-budget-"));
		ledger = new TokenBudgetLedger(directory, "root");
	});

	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	it("counts cached input and output exactly once", () => {
		expect(processedTokens({ input: 10, cacheRead: 20, cacheWrite: 30, output: 40 })).toBe(100);
		expect(() => processedTokens({ input: -1, cacheRead: 0, cacheWrite: 0, output: 0 })).toThrow();
	});

	it("isolates asynchronous ownership between concurrent sibling requests", async () => {
		const first = { ledger, sessionId: "first" };
		const second = { ledger, sessionId: "second" };
		const owners = await Promise.all(
			[first, second].map((owner) =>
				withTokenBudgetOwner(owner, async () => {
					await Promise.resolve();
					return currentTokenBudgetOwner();
				}),
			),
		);
		expect(owners).toEqual([first, second]);
		expect(currentTokenBudgetOwner()).toBeUndefined();
	});

	it("never dispatches an attempt denied by the root ledger", async () => {
		let sends = 0;
		const iterator = budgetProviderAttempt({ ledger, sessionId: "child" }, 3_000_001, async function* () {
			sends++;
			yield* [];
		});
		await expect(iterator.next()).rejects.toThrow(TokenBudgetPausedError);
		expect(sends).toBe(0);
	});

	it("keeps a reservation when dispatch fails before usage is reported", async () => {
		const iterator = budgetProviderAttempt({ ledger, sessionId: "child" }, 100, async function* () {
			yield* [];
			throw new Error("transport interrupted");
		});
		await expect(iterator.next()).rejects.toThrow("transport interrupted");
		expect(ledger.status("child").used).toBe(100);
	});
});
