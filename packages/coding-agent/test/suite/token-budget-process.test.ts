import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { budgetProviderAttempt } from "../../src/core/provider-token-budget.ts";
import { TokenBudgetLedger } from "../../src/core/token-budget.ts";

describe("cross-process token budget admission", () => {
	let directory: string;
	let ledger: TokenBudgetLedger;
	let children: { child: ChildProcess; exited: Promise<unknown> }[];

	function startChild(sessionId: string, bound: number, holdLock = false) {
		const child = fork(
			fileURLToPath(new URL("./token-budget-process-support.ts", import.meta.url)),
			[directory, sessionId, String(bound), holdLock ? "hold" : "free"],
			{
				execArgv: ["--import", "tsx"],
				stdio: ["ignore", "ignore", "inherit", "ipc"],
				env: { PATH: process.env.PATH },
			},
		);
		const ready = once(child, "message", { signal: AbortSignal.timeout(5_000) }).then(([message]) => message);
		const exited = once(child, "exit", { signal: AbortSignal.timeout(10_000) });
		children.push({ child, exited });
		return { child, ready, exited };
	}

	function command(child: ChildProcess) {
		const result = once(child, "message", { signal: AbortSignal.timeout(5_000) }).then(([message]) => message);
		child.send("advance");
		return result;
	}

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "senpi-budget-process-"));
		ledger = new TokenBudgetLedger(directory, "root");
		children = [];
	});

	afterEach(async () => {
		for (const { child } of children) {
			if (child.exitCode === null && child.signalCode === null) child.kill();
		}
		await Promise.all(children.map(({ exited }) => exited));
		rmSync(directory, { recursive: true, force: true });
	});

	it("does not create an uninitialized root while another process holds its lock", async () => {
		// Given: another process owns the initialization lock before the root directory exists.
		const worker = startChild("first", 100, true);
		expect(await worker.ready).toEqual({ phase: "ready" });
		let sends = 0;
		const attempt = budgetProviderAttempt({ ledger, sessionId: "second" }, 100, async function* () {
			sends++;
			yield* [];
		});

		// When: a competing request tries admission, then the lock holder initializes.
		await expect(attempt.next()).rejects.toMatchObject({ code: "ELOCKED" });
		expect(await command(worker.child)).toEqual({ phase: "dispatched", sends: 1 });
		expect(await command(worker.child)).toEqual({ phase: "settled", sends: 1 });
		expect(await worker.exited).toEqual([0, null]);

		// Then: contention never dispatches, and the legitimate initializer still succeeds.
		expect(sends).toBe(0);
		expect(new TokenBudgetLedger(directory, "root").status("first").used).toBe(100);
	});

	it.each(["tree", "session"] as const)(
		"denies a second process before dispatch at the shared %s ceiling",
		async (limit) => {
			// Given: two live processes share a ledger, with only one reservation fitting.
			if (limit === "tree") {
				ledger.reserve("seed-one", "one", 3_000_000);
				ledger.reserve("seed-two", "two", 3_000_000);
			} else {
				ledger.status("shared");
			}
			const firstSession = limit === "tree" ? "first" : "shared";
			const secondSession = limit === "tree" ? "second" : "shared";
			const first = startChild(firstSession, 2_000_000);
			const second = startChild(secondSession, 2_000_000);
			await Promise.all([first.ready, second.ready]);

			// When: the second process requests dispatch while the first provider request is unsettled.
			expect(await command(first.child)).toEqual({ phase: "dispatched", sends: 1 });
			expect(await command(second.child)).toEqual({ phase: "denied", sends: 0, name: "TokenBudgetPausedError" });
			const restarted = new TokenBudgetLedger(directory, "root");
			expect(restarted.status(firstSession)).toMatchObject({
				used: limit === "tree" ? 8_000_000 : 2_000_000,
				paused: true,
			});
			expect(await command(first.child)).toEqual({ phase: "settled", sends: 1 });
			await Promise.all([first.exited, second.exited]);

			// Then: all four usage counters reconcile once, without clearing the durable tree pause.
			expect(restarted.status(firstSession)).toMatchObject({
				used: limit === "tree" ? 6_000_100 : 100,
				sessionUsed: 100,
				paused: true,
			});
		},
	);
});
