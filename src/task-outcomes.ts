/**
 * Joined task-outcome row (model-routing-control-loop concern 03) — one durable, idempotent record
 * per unit joining the routing decision (`PersistedAgent.routing`, concern 03 step 1) with the real
 * terminal land outcome. C05's task-class × model matrix reads THIS small pre-joined log instead of
 * re-deriving a fragile cross-file join (roster × routing × receipts × land-ledger) on every request.
 *
 * Idempotency: rows are keyed on `agentId`, upsert semantics with LAST-terminal-wins collapse done at
 * READ time (never at write time — the log is a plain append, single-writer, never rewritten in
 * place). This makes re-entry safe: a revert→reland of the same branch, or the reconciler's
 * out-of-band backstop double-firing for a unit `land()` already recorded, both just append another
 * line; the reader keeps only the last one per agentId. Branch is NOT the key (a branch can be
 * reused across a revert→reland, and the reconciler path is branch-keyed but must resolve to the SAME
 * agentId row `land()` would have written — see `SquadManager.reconcileOnePr`'s branch→agentId
 * resolution).
 *
 * Rows are deliberately SMALL (no spans/rationale/transcript) — a fat row risks a single `O_APPEND`
 * write exceeding PIPE_BUF and interleaving with a concurrent writer's line (see receipts.ts's own
 * O_APPEND commentary). The daemon's single event loop serializes writes in practice, but a
 * multi-daemon/restart overlap is possible; small rows + agentId-keyed upsert-on-read make an
 * interleave (or a torn line) recoverable rather than corrupting.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** One joined row: what the router picked, and what happened after it landed (or didn't). */
export interface TaskOutcomeRow {
	agentId: string;
	branch?: string;
	routing: { mode: string; tier: string };
	model?: string;
	costUsd?: number;
	confidence?: number;
	validation?: "pass" | "veto" | "abstain" | "skipped";
	outcome: "landed" | "rejected" | "abandoned";
	/** Which code path produced this row — "land" (the in-process land() method), "reconciled" (the
	 *  PR-reconciler's out-of-band GitHub-UI-merge backstop), or "sweep" (any future batch reconciliation). */
	source: "land" | "reconciled" | "sweep";
	/** ms epoch this row was recorded (NOT necessarily when the land happened — see the reconciler,
	 *  which records well after the fact). */
	ts: number;
}

function outcomesPath(stateDir: string): string {
	return path.join(stateDir, "task-outcomes.jsonl");
}

/**
 * Append one row + fsync so a committed line survives a host crash — same durable-append pattern as
 * `receipts.ts`'s `appendReceipt`. Best-effort is the CALLER's job (every call site wraps this in a
 * non-fatal try/catch, matching `recordModelOutcome`/`recordConfidenceOutcome`'s sibling calls in
 * `land()`): a task-outcome write must never break the land it records.
 */
export async function recordTaskOutcome(stateDir: string, row: TaskOutcomeRow): Promise<void> {
	const file = outcomesPath(stateDir);
	await fs.mkdir(path.dirname(file), { recursive: true });
	const fh = await fs.open(file, "a");
	try {
		await fh.writeFile(`${JSON.stringify(row)}\n`);
		await fh.sync();
	} finally {
		await fh.close();
	}
}

/**
 * Read every row, collapsed by `agentId` keeping the LAST line written for each id (terminal-wins —
 * see the module doc for why this is the idempotency mechanism rather than a write-time upsert).
 * Per-line tolerant like `readReceipts`: an unparseable/torn line (crash mid-append) is dropped rather
 * than thrown. Missing file ⇒ `[]`.
 */
export async function readTaskOutcomes(stateDir: string): Promise<TaskOutcomeRow[]> {
	let text: string;
	try {
		text = await fs.readFile(outcomesPath(stateDir), "utf8");
	} catch {
		return [];
	}
	const byAgent = new Map<string, TaskOutcomeRow>();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const row = JSON.parse(line) as TaskOutcomeRow;
			if (row && typeof row.agentId === "string") byAgent.set(row.agentId, row); // last line for an agentId wins
		} catch {
			// torn/corrupt line (crash mid-append) — drop it and keep the rest
		}
	}
	return [...byAgent.values()];
}
