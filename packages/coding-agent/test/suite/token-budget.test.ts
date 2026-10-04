import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TokenBudgetLedger, TokenBudgetPausedError } from "../../src/core/token-budget.ts";

describe("persistent root token budget", () => {
	let directory: string;
	let ledger: TokenBudgetLedger;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "senpi-token-budget-"));
		ledger = new TokenBudgetLedger(directory, "root");
	});

	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	it("charges unsettled requests across restarts", () => {
		ledger.reserve("child", "request", 100);
		const restarted = new TokenBudgetLedger(directory, "root");
		expect(restarted.status("child").used).toBe(100);
		expect(restarted.status("child").sessionUsed).toBe(100);
	});

	it("deduplicates terminal usage without double charging", () => {
		ledger.reserve("child", "request", 100);
		ledger.settle("request", 75);
		ledger.settle("request", 75);
		expect(ledger.status("child").used).toBe(75);
		expect(() => ledger.settle("request", 76)).toThrow("Conflicting");
	});

	it("persists a session denial as a pause for every sibling", () => {
		ledger.reserve("child", "request", 3_000_000);
		expect(() => ledger.reserve("child", "denied", 1)).toThrow(TokenBudgetPausedError);
		expect(() => new TokenBudgetLedger(directory, "root").reserve("sibling", "next", 1)).toThrow(
			TokenBudgetPausedError,
		);
		expect(ledger.status("sibling").used).toBe(3_000_000);
	});

	it("shares the tree limit across distinct child sessions", () => {
		ledger.reserve("first", "one", 3_000_000);
		ledger.reserve("second", "two", 3_000_000);
		expect(() => ledger.reserve("third", "three", 2_000_001)).toThrow(TokenBudgetPausedError);
		expect(ledger.status("third").used).toBe(6_000_000);
	});

	it("retains a pause when reconciliation refunds a reservation", () => {
		ledger.reserve("child", "request", 3_000_000);
		expect(() => ledger.reserve("child", "denied", 1)).toThrow(TokenBudgetPausedError);
		ledger.settle("request", 100);
		expect(ledger.status("child").paused).toBe(true);
	});

	it("pauses the tree when a provider exceeds its admitted bound", () => {
		ledger.reserve("child", "request", 100);
		ledger.settle("request", 101);
		expect(ledger.status("child").paused).toBe(true);
	});

	it("fails closed when persisted state is missing or corrupt", () => {
		ledger.reserve("child", "request", 100);
		const path = join(directory, Buffer.from("root").toString("hex"), "budget.json");
		writeFileSync(path, "{");
		expect(() => ledger.status("child")).toThrow();
		unlinkSync(path);
		expect(() => ledger.status("child")).toThrow();
	});
});
