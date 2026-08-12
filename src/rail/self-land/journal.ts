/**
 * Self-land durable journal (glance#391 round 3, H-3).
 *
 * The window's evidence is `land-receipts/index.jsonl`. The receipt write is best-effort — a disk
 * fault after a successful merge would leave a MERGED, measured land with NO row in the window, while
 * `selfLand` still returned `ok:true`. That is a silent under-count of exactly the thing being
 * measured. This journal closes it:
 *
 *  - `journalPending` is written BEFORE the merge is attempted — a durable "a measured land of
 *    <branch>@<head> is about to happen" intent.
 *  - `journalFinalized` is written AFTER a confirmed merge, carrying the full measured-row payload
 *    (landed commit, verdict, precision, criteria source). This is a complete `LandReceiptIndexRow`'s
 *    worth of evidence, independent of whether the `index.jsonl` append then succeeds.
 *  - `journalAborted` is written when the land did NOT merge (a guard refused, a conflict) — so a
 *    `pending` never lingers as a false "this merged".
 *
 * The window reader folds `finalized` journal rows that are not already in `index.jsonl`
 * (`journalRowsForWindow` + dedupe by branch+commit), so a receipt-write failure can never hide a
 * measured land. Append-only JSONL, last-status-per-id wins — the same durable-append shape the land
 * ledgers use. Never throws on a read fault (missing file ⇒ empty); a WRITE fault propagates to the
 * caller, which decides how loud to be (selfLand logs an error and still surfaces the land).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LandReceiptIndexRow } from "../receipt/types.ts";
import { landReceiptDir } from "../receipt/write.ts";

export type SelfLandJournalStatus = "pending" | "finalized" | "aborted";

export interface SelfLandJournalEntry {
	/** Stable, idempotent key: `<repoSlug>:<branch>:<headOid>`. Finalize/abort target it. */
	id: string;
	repo: string; // owner/repo slug
	branch: string;
	headOid: string;
	status: SelfLandJournalStatus;
	at: number;
	criteriaSource?: "pr-body" | "call";
	criteriaCount?: number;
	/** Present on `finalized`: the merge commit (the row's `commit`). */
	landedCommit?: string;
	/** Present on `finalized`: the full measured-row payload, so the fold needs nothing else. */
	row?: LandReceiptIndexRow;
	detail?: string;
}

export function selfLandJournalPath(stateDir: string): string {
	return path.join(landReceiptDir(stateDir), "self-land-journal.jsonl");
}

export function selfLandJournalId(repoSlug: string, branch: string, headOid: string): string {
	return `${repoSlug}:${branch}:${headOid}`;
}

/** Durable append of one journal event. Retries a bounded number of times, then throws — the caller
 *  (selfLand) treats a pending-write failure as a hard refusal and a finalize-write failure as a loud
 *  error, never a silent proceed. */
async function appendJournal(stateDir: string, entry: SelfLandJournalEntry): Promise<void> {
	await fs.mkdir(landReceiptDir(stateDir), { recursive: true });
	const line = JSON.stringify(entry) + "\n";
	let lastErr: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await fs.appendFile(selfLandJournalPath(stateDir), line, "utf8");
			return;
		} catch (err) {
			lastErr = err;
			await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
		}
	}
	if (lastErr instanceof Error) throw lastErr;
	throw new Error(String(lastErr));
}

export function journalPending(stateDir: string, input: { repo: string; branch: string; headOid: string; criteriaSource?: "pr-body" | "call"; criteriaCount?: number }): Promise<string> {
	const id = selfLandJournalId(input.repo, input.branch, input.headOid);
	return appendJournal(stateDir, { id, repo: input.repo, branch: input.branch, headOid: input.headOid, status: "pending", at: Date.now(), criteriaSource: input.criteriaSource, criteriaCount: input.criteriaCount }).then(() => id);
}

export function journalFinalized(stateDir: string, id: string, input: { repo: string; branch: string; headOid: string; landedCommit: string; row: LandReceiptIndexRow }): Promise<void> {
	return appendJournal(stateDir, { id, repo: input.repo, branch: input.branch, headOid: input.headOid, status: "finalized", at: Date.now(), landedCommit: input.landedCommit, row: input.row });
}

export function journalAborted(stateDir: string, id: string, input: { repo: string; branch: string; headOid: string; detail: string }): Promise<void> {
	return appendJournal(stateDir, { id, repo: input.repo, branch: input.branch, headOid: input.headOid, status: "aborted", at: Date.now(), detail: input.detail });
}

/** Latest state per id (last line wins). Missing file ⇒ empty. Never throws. */
export async function readSelfLandJournal(stateDir: string): Promise<Map<string, SelfLandJournalEntry>> {
	let text: string;
	try {
		text = await fs.readFile(selfLandJournalPath(stateDir), "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return new Map();
		return new Map(); // an unreadable journal is a degraded fallback, never a throw into a land
	}
	const latest = new Map<string, SelfLandJournalEntry>();
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const e: unknown = JSON.parse(t);
			if (!e || typeof e !== "object") continue;
			const rec = e as Record<string, unknown>;
			if (typeof rec.id !== "string" || typeof rec.status !== "string") continue;
			latest.set(rec.id, e as SelfLandJournalEntry);
		} catch {
			/* skip a corrupt line — never let one bad row lose the rest */
		}
	}
	return latest;
}

/**
 * The finalized-journal rows that must be FOLDED into the window when they are not already present in
 * `index.jsonl` (glance#391 round 3, H-3) — the fallback evidence for a merged, measured land whose
 * receipt index-append failed. Dedupe against the given index rows by (branch, commit): a land already
 * in the index needs no fold. Only `finalized` entries with a carried `row` participate.
 */
export async function journalRowsForWindow(stateDir: string, indexRows: readonly LandReceiptIndexRow[]): Promise<LandReceiptIndexRow[]> {
	const latest = await readSelfLandJournal(stateDir);
	const seen = new Set(indexRows.map((r) => `${r.branch}\0${r.commit ?? ""}`));
	const out: LandReceiptIndexRow[] = [];
	for (const e of latest.values()) {
		if (e.status !== "finalized" || !e.row || !e.landedCommit) continue;
		if (seen.has(`${e.branch}\0${e.landedCommit}`)) continue;
		out.push(e.row);
	}
	return out;
}
