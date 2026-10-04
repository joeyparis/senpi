import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { AssistantMessageEvent, Usage } from "@earendil-works/pi-ai";
import type { TokenBudgetLedger } from "./token-budget.ts";

export type TokenBudgetOwner = {
	readonly ledger: TokenBudgetLedger;
	readonly sessionId: string;
};

const ownership = new AsyncLocalStorage<TokenBudgetOwner>();

/** Provider-facing session IDs may change for compaction; accounting ownership must not. */
export function withTokenBudgetOwner<T>(owner: TokenBudgetOwner, operation: () => T): T {
	return ownership.run(owner, operation);
}

export function currentTokenBudgetOwner(): TokenBudgetOwner | undefined {
	return ownership.getStore();
}

/** pi-ai normalizes these four disjoint counters before exposing Usage. */
export function processedTokens(usage: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">): number {
	let total = 0;
	for (const count of [usage.input, usage.output, usage.cacheRead, usage.cacheWrite]) {
		if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid provider token usage");
		total += count;
	}
	if (!Number.isSafeInteger(total)) throw new Error("Provider token usage exceeds the safe integer range");
	return total;
}

export async function budgetAuxiliaryRequest<T>(
	owner: TokenBudgetOwner,
	upperBound: number,
	send: () => Promise<T>,
	usage: (result: T) => Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite"> | undefined,
): Promise<T> {
	const requestId = randomUUID();
	owner.ledger.reserve(owner.sessionId, requestId, upperBound);
	const result = await send();
	const reported = usage(result);
	if (reported) {
		const actual = processedTokens(reported);
		if (actual > 0) owner.ledger.settle(requestId, actual);
	}
	return result;
}

/**
 * Reserve before dispatch and settle before forwarding a terminal event. A missing
 * usage report or interrupted iterator leaves its full reservation charged.
 */
export async function* budgetProviderAttempt(
	owner: TokenBudgetOwner,
	upperBound: number,
	send: () => AsyncIterable<AssistantMessageEvent>,
	signal?: AbortSignal,
): AsyncGenerator<AssistantMessageEvent> {
	signal?.throwIfAborted();
	const requestId = randomUUID();
	owner.ledger.reserve(owner.sessionId, requestId, upperBound);
	for await (const event of send()) {
		if (event.type === "done" || event.type === "error") {
			const message = event.type === "done" ? event.message : event.error;
			const actual = processedTokens(message.usage);
			// Zero usage does not prove that a dispatched request was free.
			if (actual > 0) owner.ledger.settle(requestId, actual);
		}
		yield event;
	}
}
