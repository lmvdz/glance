/**
 * Self-land durable journal (glance#391 round 3 H-3, hardened round 4 C-3/H-2).
 *
 * The window's evidence is `land-receipts/index.jsonl`. The receipt write is best-effort — a disk
 * fault after a successful merge would leave a MERGED, measured land with NO row in the window while
 * `selfLand` still returned `ok:true`. That is a silent under-count of exactly the thing being
 * measured. This journal closes it:
 *
 *  - `journalPending` is written BEFORE the merge is attempted — a durable intent, keyed by a UNIQUE
 *    per-attempt id (`repo:branch:head:base:nonce`), so a later attempt can NEVER overwrite an earlier
 *    attempt's finalized row (round 4 C-3: the old `repo:branch:head` id allowed exactly that).
 *  - `journalFinalized` is written the MOMENT the `LandResult` confirms a merge — BEFORE the
 *    best-effort index/HTML I/O (round 4 C-3), carrying the full measured-row payload. A crash between
 *    the merge and the index append therefore still leaves a finalized entry the window folds.
 *  - `journalQueued` (round 4 H-2) records a `gh pr merge` that ENQUEUED rather than merged
 *    synchronously — NOT an abort. The drain leaves it pending confirmation, never a defect, never a
 *    silent drop.
 *  - `journalAborted` is written only when the land genuinely did NOT and will NOT merge (a guard
 *    refused, a conflict) — so a `pending`/`queued` never lingers as a false "this landed", and an
 *    enqueue is never miscounted as a failure.
 *
 * The window reader folds `finalized` journal rows not already in `index.jsonl` (`journalRowsForWindow`
 * + dedupe by branch+commit), so a receipt-write failure can never hide a measured land. Append-only
 * JSONL, last-status-per-id wins. Reads FAIL CLOSED on a real I/O error (round 4 C-3): a missing file
 * is honest-empty, but an unreadable one THROWS so the drain reports "unmeasurable", never "empty".
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LandReceiptIndexRow } from "../receipt/types.ts";
import { landReceiptDir } from "../receipt/write.ts";

export type SelfLandJournalStatus = "pending" | "finalized" | "queued" | "aborted";

export interface SelfLandJournalEntry {
	/** Unique per-attempt id: `<repoSlug>:<branch>:<headOid>:<base>:<nonce>`. */
	id: string;
	repo: string; // owner/repo slug
	branch: string;
	headOid: string;
	base: string;
	status: SelfLandJournalStatus;
	at: number;
	prNumber?: number;
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

/** A fresh UNIQUE per-attempt id. Two attempts of the same (repo,branch,head) get DISTINCT ids, so a
 *  later attempt's `aborted` can never flip an earlier attempt's `finalized` (round 4 C-3). */
export function newSelfLandAttemptId(repoSlug: string, branch: string, headOid: string, base: string): string {
	return `${repoSlug}:${branch}:${headOid}:${base}:${randomBytes(6).toString("hex")}`;
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

export function journalPending(stateDir: string, id: string, input: { repo: string; branch: string; headOid: string; base: string; prNumber?: number; criteriaSource?: "pr-body" | "call"; criteriaCount?: number }): Promise<void> {
	return appendJournal(stateDir, { id, repo: input.repo, branch: input.branch, headOid: input.headOid, base: input.base, status: "pending", at: Date.now(), prNumber: input.prNumber, criteriaSource: input.criteriaSource, criteriaCount: input.criteriaCount });
}

export function journalFinalized(stateDir: string, id: string, input: { repo: string; branch: string; headOid: string; base: string; landedCommit: string; row: LandReceiptIndexRow }): Promise<void> {
	return appendJournal(stateDir, { id, repo: input.repo, branch: input.branch, headOid: input.headOid, base: input.base, status: "finalized", at: Date.now(), landedCommit: input.landedCommit, row: input.row });
}

export function journalQueued(stateDir: string, id: string, input: { repo: string; branch: string; headOid: string; base: string; prNumber: number; detail: string }): Promise<void> {
	return appendJournal(stateDir, { id, repo: input.repo, branch: input.branch, headOid: input.headOid, base: input.base, status: "queued", at: Date.now(), prNumber: input.prNumber, detail: input.detail });
}

export function journalAborted(stateDir: string, id: string, input: { repo: string; branch: string; headOid: string; base: string; detail: string }): Promise<void> {
	return appendJournal(stateDir, { id, repo: input.repo, branch: input.branch, headOid: input.headOid, base: input.base, status: "aborted", at: Date.now(), detail: input.detail });
}

/**
 * Latest state per id (last line wins). Missing file ⇒ empty. FAILS CLOSED on a real read error
 * (round 4 C-3): an unreadable journal is `unmeasurable`, never silently "empty" — it THROWS so the
 * drain reports a floor, not a false zero. A single corrupt LINE is skipped (never loses the rest).
 */
export async function readSelfLandJournal(stateDir: string): Promise<Map<string, SelfLandJournalEntry>> {
	let text: string;
	try {
		text = await fs.readFile(selfLandJournalPath(stateDir), "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return new Map();
		throw err; // fail closed — the caller must treat this as unmeasurable, not empty
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
 * `index.jsonl` (round 3 H-3) — the fallback evidence for a merged, measured land whose index-append
 * faulted. Dedupe against the given index rows by (branch, commit): a land already in the index needs
 * no fold. Only `finalized` entries with a carried `row` participate — `pending`/`queued`/`aborted`
 * never count (round 4 H-2: an enqueue is not evidence of a completed land).
 */
export async function journalRowsForWindow(stateDir: string, indexRows: readonly LandReceiptIndexRow[]): Promise<LandReceiptIndexRow[]> {
	const latest = await readSelfLandJournal(stateDir);
	const seen = new Set(indexRows.map((r) => `${r.branch}\0${r.commit ?? ""}`));
	const out: LandReceiptIndexRow[] = [];
	for (const e of latest.values()) {
		if (e.status !== "finalized" || !e.row || !e.landedCommit) continue;
		if (seen.has(`${e.branch}\0${e.landedCommit}`)) continue;
		seen.add(`${e.branch}\0${e.landedCommit}`); // dedupe within the fold too (two finalized ids, same commit)
		out.push(e.row);
	}
	return out;
}

/**
 * Entries still awaiting confirmation (round 4 H-2/C-3): `pending` (dispatched, outcome unknown — a
 * crash may have interrupted it) or `queued` (a `gh pr merge` enqueued into a merge queue, not yet
 * merged). The drain surfaces these as a FLOOR ("N self-lands awaiting confirmation"), never counting
 * them as measured and never aborting them — the reconcile-against-GitHub step decides their fate.
 */
export async function unconfirmedSelfLands(stateDir: string): Promise<SelfLandJournalEntry[]> {
	const latest = await readSelfLandJournal(stateDir);
	return [...latest.values()].filter((e) => e.status === "pending" || e.status === "queued");
}
