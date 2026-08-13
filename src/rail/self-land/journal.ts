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

/**
 * Record a `gh pr merge` that ENQUEUED (or an unreadable post-merge confirm after a 0-exit merge —
 * glance#392 item 4). Carries the MEASURED-ROW payload (`row`) the land already earned — verdict +
 * precision + gateStatus, `landed:true`, but no `commit`/`landId` yet (the merge commit isn't known
 * until the queue completes). The reconcile step (`reconcileUnconfirmedSelfLands`) fills in the commit
 * and promotes it to `finalized` once GitHub confirms the merge at the gated head. Without the carried
 * row, a queued land could only ever be folded as an UNMEASURED land after it merged — losing the very
 * reviewer-precision measurement the window exists to count (glance#392 item 5).
 */
export function journalQueued(stateDir: string, id: string, input: { repo: string; branch: string; headOid: string; base: string; prNumber: number; detail: string; criteriaSource?: "pr-body" | "call"; criteriaCount?: number; row?: LandReceiptIndexRow }): Promise<void> {
	return appendJournal(stateDir, { id, repo: input.repo, branch: input.branch, headOid: input.headOid, base: input.base, status: "queued", at: Date.now(), prNumber: input.prNumber, criteriaSource: input.criteriaSource, criteriaCount: input.criteriaCount, row: input.row, detail: input.detail });
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

/** SHA identity tolerant of an abbreviated-vs-full form on either side (gh returns either) — the same
 *  rule the self-land head guard uses. Empty on either side is never a match. */
function sameOid(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) return false;
	const x = a.toLowerCase();
	const y = b.toLowerCase();
	return x === y || x.startsWith(y) || y.startsWith(x);
}

/** The live PR facts the reconcile step reads from GitHub for one unconfirmed self-land. Injected so
 *  the drain wires `gh pr view` while tests pass a pure function — this module stays gh-free. */
export interface QueuedPrState {
	/** GitHub PR state: `MERGED` / `CLOSED` / `OPEN` (any other value is treated as still-open). */
	state: string;
	/** The PR head OID at read time. For a MERGED PR this is the commit that actually merged — compared
	 *  against the gated `headOid` so a merge-queue that REWROTE the tree we measured is never folded as
	 *  our measured land. */
	headOid?: string;
	/** The merge commit OID, when the PR merged — becomes the folded row's `commit`. */
	mergeCommit?: string;
}

/** Reads GitHub for one unconfirmed entry; returns undefined on a transient fault (which must leave the
 *  entry pending, never abort it). */
export type QueuedPrReader = (entry: SelfLandJournalEntry) => Promise<QueuedPrState | undefined>;

export type ReconcileAction = "folded" | "aborted" | "pending" | "unreadable";
export interface ReconcileOutcome {
	id: string;
	branch: string;
	prNumber?: number;
	action: ReconcileAction;
	detail: string;
	/** The merge commit, on a `folded` outcome. */
	commit?: string;
}

/**
 * Settle every UNCONFIRMED self-land (`queued`/`pending`) against GitHub (glance#392 item 5) — the
 * read-side that completes B2's persist-as-`queued` / never-count. For each entry the injected reader
 * re-reads the PR, and this decides its fate:
 *   - MERGED at the GATED head (headOid matches) AND the entry carries its measured `row` ⇒ FOLD:
 *     append a `finalized` entry (the row + the real merge commit) so the window counts the measured
 *     land it would otherwise have lost. Idempotent — a re-run sees `finalized` (no longer unconfirmed)
 *     and skips it; `journalRowsForWindow` then folds it, deduped by (branch, commit).
 *   - MERGED but the head MOVED (a merge-queue rewrote the tree we measured), or CLOSED unmerged ⇒
 *     ABORT: the gated tree is not what landed / will never land, so this measured attempt is void. A
 *     rewritten descendant needs its OWN self-land + fresh measurement, never a silent count here.
 *   - still OPEN / still queued ⇒ leave PENDING (unchanged) — reconciled again on the next drain.
 *   - reader fault (transient gh/network), or a crash-orphaned `pending` with no measured row we could
 *     reconstruct ⇒ leave PENDING; NEVER aborted on a fault (that would drop a possibly-merged land —
 *     the undercount direction this whole path guards).
 * A journal WRITE fault while folding/aborting is reported (as `unreadable`/pending for a fold) but
 * never throws — the drain must still produce its ledger row.
 */
export async function reconcileUnconfirmedSelfLands(stateDir: string, read: QueuedPrReader): Promise<ReconcileOutcome[]> {
	const pending = await unconfirmedSelfLands(stateDir);
	const out: ReconcileOutcome[] = [];
	for (const e of pending) {
		const tag = `${e.branch}${e.prNumber ? ` (#${e.prNumber})` : ""}`;
		let state: QueuedPrState | undefined;
		try {
			state = await read(e);
		} catch {
			state = undefined;
		}
		if (!state || typeof state.state !== "string") {
			out.push({ id: e.id, branch: e.branch, prNumber: e.prNumber, action: "unreadable", detail: `could not re-read PR state for ${tag} — left pending (never aborted on a read fault)` });
			continue;
		}
		const st = state.state.toUpperCase();
		const headMatches = sameOid(state.headOid, e.headOid);
		if (st === "MERGED" && headMatches && state.mergeCommit && e.row) {
			const commit = state.mergeCommit;
			const row: LandReceiptIndexRow = { ...e.row, commit, landId: `${e.branch}\0${commit}` };
			try {
				await journalFinalized(stateDir, e.id, { repo: e.repo, branch: e.branch, headOid: e.headOid, base: e.base, landedCommit: commit, row });
				out.push({ id: e.id, branch: e.branch, prNumber: e.prNumber, action: "folded", commit, detail: `${tag} merged at the gated head ${e.headOid.slice(0, 12)} → folded as measured (merge commit ${commit.slice(0, 12)})` });
			} catch (err) {
				out.push({ id: e.id, branch: e.branch, prNumber: e.prNumber, action: "unreadable", detail: `${tag} merged at the gated head but the finalize-journal write FAILED (${String(err)}) — left pending, retry the drain` });
			}
			continue;
		}
		if (st === "MERGED" && !headMatches) {
			await journalAborted(stateDir, e.id, { repo: e.repo, branch: e.branch, headOid: e.headOid, base: e.base, detail: `${tag} merged, but at head ${state.headOid?.slice(0, 12) ?? "unknown"} — NOT the gated ${e.headOid.slice(0, 12)} (a merge-queue rewrote the tree). The measured attempt is void; the rewritten head needs its own self-land.` }).catch(() => {});
			out.push({ id: e.id, branch: e.branch, prNumber: e.prNumber, action: "aborted", detail: `${tag} merged at a non-gated head — measured attempt void` });
			continue;
		}
		if (st === "CLOSED") {
			await journalAborted(stateDir, e.id, { repo: e.repo, branch: e.branch, headOid: e.headOid, base: e.base, detail: `${tag} closed without merging — the queued land will never complete.` }).catch(() => {});
			out.push({ id: e.id, branch: e.branch, prNumber: e.prNumber, action: "aborted", detail: `${tag} closed unmerged` });
			continue;
		}
		out.push({ id: e.id, branch: e.branch, prNumber: e.prNumber, action: "pending", detail: `${tag} state=${state.state} — awaiting confirmation` });
	}
	return out;
}
