import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { FILE_STORAGE_LOCK_OPTIONS } from "./lockfile-policy.ts";

export const DEFAULT_SESSION_TOKEN_LIMIT = 3_000_000;
export const DEFAULT_TREE_TOKEN_LIMIT = 8_000_000;

const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const requestSchema = z.strictObject({
	sessionId: z.string().min(1),
	reserved: tokens,
	actual: tokens.optional(),
});
const documentSchema = z.strictObject({
	version: z.literal(1),
	rootId: z.string().min(1),
	treeLimit: tokens,
	sessionLimit: tokens,
	paused: z.boolean(),
	approvals: z.array(
		z.strictObject({
			id: z.string().min(1),
			treeTokens: tokens,
			sessionTokens: tokens,
			origin: z.literal("interactive-confirmation"),
		}),
	),
	requests: z.record(z.string(), requestSchema),
});
type BudgetDocument = z.infer<typeof documentSchema>;

export class TokenBudgetPausedError extends Error {
	readonly name = "TokenBudgetPausedError";
	readonly rootId: string;
	constructor(rootId: string) {
		super(`Token budget paused for ${rootId}. An explicit human budget extension is required.`);
		this.rootId = rootId;
	}
}

export type TokenBudgetSnapshot = {
	readonly rootId: string;
	readonly used: number;
	readonly sessionUsed: number;
	readonly treeLimit: number;
	readonly sessionLimit: number;
	readonly paused: boolean;
	readonly warning: boolean;
};

/**
 * A root ledger shared across processes. Unsettled reservations survive crashes and
 * remain charged. Invalid persisted state never resets the budget.
 */
export class TokenBudgetLedger {
	private readonly directory: string;
	private readonly path: string;
	readonly rootId: string;

	constructor(directory: string, rootId: string) {
		z.string().min(1).parse(rootId);
		this.rootId = rootId;
		this.directory = join(directory, Buffer.from(rootId).toString("hex"));
		this.path = join(this.directory, "budget.json");
	}

	private transact<T>(operation: (document: BudgetDocument) => T): T {
		mkdirSync(dirname(this.directory), { recursive: true, mode: 0o700 });
		const release = lockfile.lockSync(this.directory, FILE_STORAGE_LOCK_OPTIONS);
		try {
			// With realpath disabled, the lock can precede the root directory. Only its
			// holder may create the directory and authorize a missing ledger's initialization.
			const created = mkdirSync(this.directory, { recursive: true, mode: 0o700 });
			let document: BudgetDocument;
			try {
				document = documentSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
			} catch (error) {
				if (created === undefined || !(error instanceof Error && "code" in error && error.code === "ENOENT")) {
					throw error;
				}
				document = {
					version: 1,
					rootId: this.rootId,
					treeLimit: DEFAULT_TREE_TOKEN_LIMIT,
					sessionLimit: DEFAULT_SESSION_TOKEN_LIMIT,
					paused: false,
					approvals: [],
					requests: {},
				};
			}
			if (document.rootId !== this.rootId) throw new Error("Token budget root identity mismatch");
			const result = operation(document);
			const temporary = join(this.directory, `${randomUUID()}.tmp`);
			const descriptor = openSync(temporary, "wx", 0o600);
			try {
				writeFileSync(descriptor, JSON.stringify(document));
				fsyncSync(descriptor);
			} finally {
				closeSync(descriptor);
			}
			renameSync(temporary, this.path);
			const directoryDescriptor = openSync(dirname(this.path), "r");
			try {
				fsyncSync(directoryDescriptor);
			} finally {
				closeSync(directoryDescriptor);
			}
			return result;
		} finally {
			release();
		}
	}

	private snapshot(document: BudgetDocument, sessionId: string): TokenBudgetSnapshot {
		let used = 0;
		let sessionUsed = 0;
		for (const request of Object.values(document.requests)) {
			const charged = request.actual ?? request.reserved;
			used += charged;
			if (request.sessionId === sessionId) sessionUsed += charged;
		}
		return {
			rootId: this.rootId,
			used,
			sessionUsed,
			treeLimit: document.treeLimit,
			sessionLimit: document.sessionLimit,
			paused: document.paused,
			warning: used >= document.treeLimit * 0.8 || sessionUsed >= document.sessionLimit * 0.8,
		};
	}

	status(sessionId: string): TokenBudgetSnapshot {
		return this.transact((document) => this.snapshot(document, sessionId));
	}

	/** Called only after the native editor receives an explicit confirmation. */
	extendFromInteractiveConfirmation(treeTokens: number, sessionTokens: number): void {
		tokens.parse(treeTokens);
		tokens.parse(sessionTokens);
		if (treeTokens + sessionTokens === 0) throw new Error("A budget extension must add tokens");
		this.transact((document) => {
			document.treeLimit = tokens.parse(document.treeLimit + treeTokens);
			document.sessionLimit = tokens.parse(document.sessionLimit + sessionTokens);
			document.approvals.push({ id: randomUUID(), treeTokens, sessionTokens, origin: "interactive-confirmation" });
			document.paused = false;
		});
	}

	reserve(sessionId: string, requestId: string, upperBound: number): void {
		z.string().min(1).parse(sessionId);
		z.string().min(1).parse(requestId);
		tokens.parse(upperBound);
		const admitted = this.transact((document) => {
			if (document.requests[requestId]) throw new Error("Duplicate token budget request identity");
			const current = this.snapshot(document, sessionId);
			if (
				current.paused ||
				current.used + upperBound > current.treeLimit ||
				current.sessionUsed + upperBound > current.sessionLimit
			) {
				document.paused = true;
				return false;
			}
			document.requests[requestId] = { sessionId, reserved: upperBound };
			return true;
		});
		if (!admitted) throw new TokenBudgetPausedError(this.rootId);
	}

	settle(requestId: string, actual: number): void {
		tokens.parse(actual);
		this.transact((document) => {
			const request = document.requests[requestId];
			if (!request) throw new Error("Unknown token budget request identity");
			if (request.actual !== undefined) {
				if (request.actual !== actual) throw new Error("Conflicting token budget usage event");
				return;
			}
			request.actual = actual;
			const current = this.snapshot(document, request.sessionId);
			if (
				actual > request.reserved ||
				current.used >= current.treeLimit ||
				current.sessionUsed >= current.sessionLimit
			) {
				document.paused = true;
			}
		});
	}
}
