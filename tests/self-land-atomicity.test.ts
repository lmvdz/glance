/**
 * Self-land ATOMICITY layer (glance#391 round 3) — the merge-point compare-and-swaps and the durable
 * journal, tested as PURE units + real fs, with NO `mock.module("gh")` (its process-wide, collection-
 * time hoist poisons tests/gh.test.ts + land-mode.test.ts — a leak `mock.restore` cannot contain). The
 * merge-point decisions were factored out of `landAgentPrOnce` precisely so they are provable here
 * without gh; the end-to-end orchestration is exercised by the seam-based tests/self-land*.test.ts.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { selfLandMergeGuard, prMergeArgs, nonMutatingAdoptDecision } from "../src/land-pr.ts";
import { isMeasuredLand } from "../src/rail/land-metrics.ts";
import type { LandReceiptIndexRow } from "../src/rail/receipt/types.ts";
import { appendLandReceiptIndexRow } from "../src/rail/receipt/write.ts";
import { readLandReceiptIndex } from "../src/rail/land-metrics.ts";
import { journalPending, journalFinalized, journalQueued, journalAborted, readSelfLandJournal, journalRowsForWindow, unconfirmedSelfLands, reconcileUnconfirmedSelfLands, newSelfLandAttemptId, type QueuedPrReader } from "../src/rail/self-land/journal.ts";
import type { LandReceipt } from "../src/rail/receipt/types.ts";

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});
async function tmpDir(prefix: string): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(d);
	return d;
}

const H = "a".repeat(40);
const H2 = "b".repeat(40); // a descendant pushed between measure and merge

// ── C-1: --match-head-commit binds the merge to the measured SHA ────────────────────────────────

test("C-1: prMergeArgs adds --match-head-commit <gated SHA> so GitHub refuses a moved head", () => {
	const args = prMergeArgs(370, "merge", "lmvdz/glance", H);
	expect(args).toContain("--match-head-commit");
	expect(args[args.indexOf("--match-head-commit") + 1]).toBe(H);
	// A non-self-land merge (no expectHeadOid) carries no CAS flag — behaviour unchanged for agents.
	expect(prMergeArgs(370, "merge", "lmvdz/glance")).not.toContain("--match-head-commit");
});

// ── C-1/C-2/H-1: the live merge-point guard (compare-and-swap on base/head/draft) ───────────────

test("C-2: the base guard refuses when the PR's live base ≠ the authorized base", () => {
	expect(selfLandMergeGuard({ baseRefName: "production", headRefOid: H, isDraft: false }, { expectBase: "main", expectHeadOid: H, refuseDraft: true }, 1)).toContain("now targets");
	expect(selfLandMergeGuard({ baseRefName: "main", headRefOid: H, isDraft: false }, { expectBase: "main", expectHeadOid: H, refuseDraft: true }, 1)).toBeUndefined();
});

test("C-1: the head guard refuses when the PR head moved to a descendant since it was gated", () => {
	expect(selfLandMergeGuard({ baseRefName: "main", headRefOid: H2, isDraft: false }, { expectBase: "main", expectHeadOid: H, refuseDraft: true }, 1)).toContain("head moved");
});

test("H-1: the draft guard refuses a mid-window draft-flip", () => {
	expect(selfLandMergeGuard({ baseRefName: "main", headRefOid: H, isDraft: true }, { expectBase: "main", expectHeadOid: H, refuseDraft: true }, 1)).toContain("DRAFT");
});

test("H-1: the guard FAILS CLOSED on a missing/mistyped live field (never reads absence as pass)", () => {
	// missing base
	expect(selfLandMergeGuard({ headRefOid: H, isDraft: false }, { expectBase: "main", expectHeadOid: H, refuseDraft: true }, 1)).toContain("no base branch");
	// missing head
	expect(selfLandMergeGuard({ baseRefName: "main", isDraft: false }, { expectBase: "main", expectHeadOid: H, refuseDraft: true }, 1)).toContain("no valid head");
	// non-hex head
	expect(selfLandMergeGuard({ baseRefName: "main", headRefOid: "not-a-sha", isDraft: false }, { expectBase: "main", expectHeadOid: H, refuseDraft: true }, 1)).toContain("no valid head");
	// missing draft flag
	expect(selfLandMergeGuard({ baseRefName: "main", headRefOid: H, isDraft: null }, { expectBase: "main", expectHeadOid: H, refuseDraft: true }, 1)).toContain("no draft flag");
});

// ── C-2: the non-mutating adopt refuses a moved head instead of force-pushing over it ───────────

test("C-2: nonMutatingAdoptDecision refuses when the open PR head ≠ the gated head (never force-pushes)", () => {
	expect(nonMutatingAdoptDecision(H, { number: 1, headRefOid: H2 }, "deepen/x")).toContain("not the gated");
	expect(nonMutatingAdoptDecision(H, undefined, "deepen/x")).toContain("no OPEN PR");
	expect(nonMutatingAdoptDecision(H, { number: 1, headRefOid: H }, "deepen/x")).toBeUndefined();
});

// ── C-3: isMeasuredLand requires verdict==="pass" (abstain with n>0 is NOT measured) ────────────

test("C-3: isMeasuredLand requires verdict pass — an abstain with precision.n>0 is NOT measured", () => {
	const base: LandReceiptIndexRow = { at: 1, repo: "lmvdz/glance", branch: "b", commit: "c", landed: true, forced: false, gateStatus: "green", verdict: "pass", precision: { lineage: "codex", n: 5, survived: 4 } };
	expect(isMeasuredLand(base)).toBe(true);
	// The exact defect: a stamped abstain (precision.n>0) must NOT count.
	expect(isMeasuredLand({ ...base, verdict: "abstain" })).toBe(false);
	expect(isMeasuredLand({ ...base, verdict: "skipped" })).toBe(false);
	expect(isMeasuredLand({ ...base, verdict: "veto" })).toBe(false);
	// A missing verdict fails closed.
	expect(isMeasuredLand({ ...base, verdict: undefined })).toBe(false);
});

// ── glance#392 item 5: reconcile a QUEUED self-land against GitHub, fold the merged ones as measured ──

const GATED = "a".repeat(40);
const MOVED = "b".repeat(40);
const MERGE_COMMIT = "c".repeat(40);

/** The measured row a queued self-land carries (verdict pass + precision, landed true, no commit yet). */
function queuedRow(): LandReceiptIndexRow {
	return { at: 1, repo: "lmvdz/glance", branch: "deepen/x", landed: true, forced: false, gateStatus: "green", verdict: "pass", precision: { lineage: "codex", n: 5, survived: 4 }, criteriaSource: "pr-body" };
}
async function queue(dir: string): Promise<string> {
	const id = newSelfLandAttemptId("lmvdz/glance", "deepen/x", GATED, "main");
	await journalQueued(dir, id, { repo: "lmvdz/glance", branch: "deepen/x", headOid: GATED, base: "main", prNumber: 370, detail: "enqueued", criteriaSource: "pr-body", criteriaCount: 1, row: queuedRow() });
	return id;
}

test("reconcile FOLDS a queued land merged at the gated head — it becomes a measured window row and leaves the unconfirmed floor", async () => {
	const dir = await tmpDir("reconcile-fold-");
	await queue(dir);
	expect((await unconfirmedSelfLands(dir)).length).toBe(1); // queued, awaiting confirmation

	const reader: QueuedPrReader = async () => ({ state: "MERGED", headOid: GATED, mergeCommit: MERGE_COMMIT });
	const out = await reconcileUnconfirmedSelfLands(dir, reader);
	expect(out).toHaveLength(1);
	expect(out[0].action).toBe("folded");
	expect(out[0].commit).toBe(MERGE_COMMIT);

	// It is now a finalized row the window folds (with the real merge commit stamped), and no longer
	// counts against the unconfirmed floor.
	const folded = await journalRowsForWindow(dir, []);
	expect(folded).toHaveLength(1);
	expect(folded[0].commit).toBe(MERGE_COMMIT);
	expect(isMeasuredLand(folded[0])).toBe(true);
	expect((await unconfirmedSelfLands(dir)).length).toBe(0);
});

test("reconcile is IDEMPOTENT — a second run sees it finalized and does nothing new", async () => {
	const dir = await tmpDir("reconcile-idem-");
	await queue(dir);
	const reader: QueuedPrReader = async () => ({ state: "MERGED", headOid: GATED, mergeCommit: MERGE_COMMIT });
	await reconcileUnconfirmedSelfLands(dir, reader);
	const second = await reconcileUnconfirmedSelfLands(dir, reader);
	expect(second).toHaveLength(0); // nothing unconfirmed left to reconcile
});

test("reconcile leaves a still-OPEN queued land PENDING (never folds, never aborts)", async () => {
	const dir = await tmpDir("reconcile-open-");
	await queue(dir);
	const reader: QueuedPrReader = async () => ({ state: "OPEN", headOid: GATED });
	const out = await reconcileUnconfirmedSelfLands(dir, reader);
	expect(out[0].action).toBe("pending");
	expect((await unconfirmedSelfLands(dir)).length).toBe(1); // still awaiting
	expect(await journalRowsForWindow(dir, [])).toHaveLength(0); // never folded
});

test("reconcile ABORTS a queued land merged at a NON-gated head (a merge-queue rewrote the tree) — not folded as measured", async () => {
	const dir = await tmpDir("reconcile-moved-");
	await queue(dir);
	const reader: QueuedPrReader = async () => ({ state: "MERGED", headOid: MOVED, mergeCommit: MERGE_COMMIT });
	const out = await reconcileUnconfirmedSelfLands(dir, reader);
	expect(out[0].action).toBe("aborted");
	expect(await journalRowsForWindow(dir, [])).toHaveLength(0); // the measured attempt is void
	expect((await unconfirmedSelfLands(dir)).length).toBe(0); // no longer pending — terminally aborted
});

test("reconcile ABORTS a queued land whose PR CLOSED unmerged", async () => {
	const dir = await tmpDir("reconcile-closed-");
	await queue(dir);
	const reader: QueuedPrReader = async () => ({ state: "CLOSED", headOid: GATED });
	const out = await reconcileUnconfirmedSelfLands(dir, reader);
	expect(out[0].action).toBe("aborted");
	expect((await unconfirmedSelfLands(dir)).length).toBe(0);
});

test("reconcile leaves an entry PENDING on a read FAULT — never aborts a possibly-merged land (undercount guard)", async () => {
	const dir = await tmpDir("reconcile-fault-");
	await queue(dir);
	const reader: QueuedPrReader = async () => undefined; // transient gh/network fault
	const out = await reconcileUnconfirmedSelfLands(dir, reader);
	expect(out[0].action).toBe("unreadable");
	expect((await unconfirmedSelfLands(dir)).length).toBe(1); // still pending, not dropped
});

test("reconcile leaves a MERGED land PENDING when the live head is MISSING/unreadable — never aborts on an unconfirmable head (grok gauntlet)", async () => {
	const dir = await tmpDir("reconcile-nohead-");
	await queue(dir);
	const reader: QueuedPrReader = async () => ({ state: "MERGED", mergeCommit: MERGE_COMMIT }); // headOid absent
	const out = await reconcileUnconfirmedSelfLands(dir, reader);
	expect(out[0].action).toBe("pending"); // NOT aborted — a merged-at-gated-head land must not be dropped
	expect((await unconfirmedSelfLands(dir)).length).toBe(1);
	expect(await journalRowsForWindow(dir, [])).toHaveLength(0);
});

test("reconcile leaves PENDING when a head OID is not valid hex — no false prefix-match to a wrong tree (grok gauntlet)", async () => {
	const dir = await tmpDir("reconcile-badhex-");
	await queue(dir);
	const reader: QueuedPrReader = async () => ({ state: "MERGED", headOid: "not-a-sha", mergeCommit: MERGE_COMMIT });
	const out = await reconcileUnconfirmedSelfLands(dir, reader);
	expect(out[0].action).toBe("pending");
	expect((await unconfirmedSelfLands(dir)).length).toBe(1);
});

test("reconcile ABORTS a MERGED land whose base was RETARGETED away from the authorized base", async () => {
	const dir = await tmpDir("reconcile-base-");
	await queue(dir); // base "main"
	const reader: QueuedPrReader = async () => ({ state: "MERGED", headOid: GATED, mergeCommit: MERGE_COMMIT, baseRef: "production" });
	const out = await reconcileUnconfirmedSelfLands(dir, reader);
	expect(out[0].action).toBe("aborted");
	expect(await journalRowsForWindow(dir, [])).toHaveLength(0);
});

test("reconcile dates the folded land by MERGE time, not enqueue time (window bucketing)", async () => {
	const dir = await tmpDir("reconcile-at-");
	await queue(dir); // queuedRow().at === 1
	const mergedAt = Date.parse("2026-08-12T12:00:00Z");
	const reader: QueuedPrReader = async () => ({ state: "MERGED", headOid: GATED, mergeCommit: MERGE_COMMIT, mergedAt });
	await reconcileUnconfirmedSelfLands(dir, reader);
	const folded = await journalRowsForWindow(dir, []);
	expect(folded[0].at).toBe(mergedAt); // the merge day, not the enqueue-time at:1
});

test("reconcile folds a crash-orphaned PENDING (no carried row) that merged at the gated head as an UNMEASURED land — never dropped", async () => {
	const dir = await tmpDir("reconcile-pending-");
	// A bare `pending` (journalPending only — no measured row was ever journaled, e.g. a crash before
	// the queued write).
	const id = newSelfLandAttemptId("lmvdz/glance", "deepen/x", GATED, "main");
	await journalPending(dir, id, { repo: "lmvdz/glance", branch: "deepen/x", headOid: GATED, base: "main", prNumber: 370, criteriaSource: "pr-body", criteriaCount: 1 });
	const reader: QueuedPrReader = async () => ({ state: "MERGED", headOid: GATED, mergeCommit: MERGE_COMMIT });
	const out = await reconcileUnconfirmedSelfLands(dir, reader);
	expect(out[0].action).toBe("folded");
	expect(out[0].measured).toBe(false); // its measurement was lost to the crash — a land, not measured
	const folded = await journalRowsForWindow(dir, []);
	expect(folded).toHaveLength(1);
	expect(folded[0].landed).toBe(true);
	expect(isMeasuredLand(folded[0])).toBe(false);
	expect((await unconfirmedSelfLands(dir)).length).toBe(0); // no longer an eternal-pending floor
});

// ── H-3: durable journal — a merged measured land is never lost to a receipt-write fault ────────

const passRow = (branch: string, commit: string): LandReceiptIndexRow => ({ at: Date.now(), repo: "lmvdz/glance", branch, commit, landed: true, forced: false, gateStatus: "green", verdict: "pass", precision: { lineage: "native", n: 3, survived: 2 }, criteriaSource: "pr-body" });

test("H-3: appendLandReceiptIndexRow durably records a row the window reads back", async () => {
	const stateDir = await tmpDir("selfland-durable-");
	const receipt: LandReceipt = { repo: "lmvdz/glance", branch: "deepen/x", commit: "c1", files: [], landed: true, at: Date.now(), gate: { status: "green", unprovenGreenRejected: false, newRegressions: [], baseWasRed: false }, validation: { verdict: "pass", agreement: 1, confidence: 1, perCriterion: [{ id: "ac1", satisfied: true }], rationale: "ok", ranAt: 1, reviewerPrecision: { lineage: "native", n: 3, survived: 2, survivedRate: 2 / 3, provisional: true } }, forcedWithoutProof: false, cost: { costUnknown: true }, criteriaSource: "pr-body" };
	await appendLandReceiptIndexRow(stateDir, receipt);
	const { rows } = await readLandReceiptIndex(stateDir);
	expect(rows.length).toBe(1);
	expect(rows[0]!.verdict).toBe("pass");
	expect(isMeasuredLand(rows[0]!)).toBe(true);
});

const BASE = "main";
const mkId = (branch: string, head: string): string => newSelfLandAttemptId("lmvdz/glance", branch, head, BASE);

test("H-3: a finalized-but-not-indexed journal row is FOLDED into the window (receipt-write-failure fallback)", async () => {
	const stateDir = await tmpDir("selfland-journal-fold-");
	// Simulate the failure: a merged measured land whose index append faulted — only the journal has it.
	const id = mkId("deepen/lost", H);
	await journalPending(stateDir, id, { repo: "lmvdz/glance", branch: "deepen/lost", headOid: H, base: BASE, criteriaSource: "pr-body", criteriaCount: 1 });
	await journalFinalized(stateDir, id, { repo: "lmvdz/glance", branch: "deepen/lost", headOid: H, base: BASE, landedCommit: "merge1", row: passRow("deepen/lost", "merge1") });
	// The index is empty (the append never happened), but the fold recovers the row.
	const folded = await journalRowsForWindow(stateDir, []);
	expect(folded.length).toBe(1);
	expect(folded[0]!.branch).toBe("deepen/lost");
	expect(isMeasuredLand(folded[0]!)).toBe(true);
	// Dedup: if the SAME land IS already in the index, it is not folded again (no double count).
	const already = await journalRowsForWindow(stateDir, [passRow("deepen/lost", "merge1")]);
	expect(already.length).toBe(0);
});

test("C-3: a later attempt's abort CANNOT overwrite an earlier attempt's finalized row (unique per-attempt id)", async () => {
	const stateDir = await tmpDir("selfland-journal-unique-");
	// Attempt 1 finalizes a real merge.
	const id1 = mkId("deepen/x", H);
	await journalPending(stateDir, id1, { repo: "lmvdz/glance", branch: "deepen/x", headOid: H, base: BASE });
	await journalFinalized(stateDir, id1, { repo: "lmvdz/glance", branch: "deepen/x", headOid: H, base: BASE, landedCommit: "merge1", row: passRow("deepen/x", "merge1") });
	// Attempt 2 (same repo:branch:head) aborts — with the OLD repo:branch:head id this would overwrite
	// attempt 1's finalized entry and vanish the land. Distinct ids keep both.
	const id2 = mkId("deepen/x", H);
	expect(id2).not.toBe(id1);
	await journalPending(stateDir, id2, { repo: "lmvdz/glance", branch: "deepen/x", headOid: H, base: BASE });
	await journalAborted(stateDir, id2, { repo: "lmvdz/glance", branch: "deepen/x", headOid: H, base: BASE, detail: "conflict" });
	// The finalized land still folds — attempt 2's abort didn't erase it.
	const folded = await journalRowsForWindow(stateDir, []);
	expect(folded.length).toBe(1);
	expect(folded[0]!.commit).toBe("merge1");
});

test("H-2: a QUEUED entry is never folded and is surfaced as unconfirmed (not a defect, not a drop)", async () => {
	const stateDir = await tmpDir("selfland-journal-queued-");
	const id = mkId("deepen/queued", H);
	await journalPending(stateDir, id, { repo: "lmvdz/glance", branch: "deepen/queued", headOid: H, base: BASE });
	await journalQueued(stateDir, id, { repo: "lmvdz/glance", branch: "deepen/queued", headOid: H, base: BASE, prNumber: 380, detail: "enqueued" });
	// Not folded (not a confirmed measured land)...
	expect(await journalRowsForWindow(stateDir, [])).toEqual([]);
	// ...but surfaced as awaiting confirmation, so the drain reports it rather than silently dropping it.
	const unconfirmed = await unconfirmedSelfLands(stateDir);
	expect(unconfirmed.length).toBe(1);
	expect(unconfirmed[0]!.status).toBe("queued");
});

test("C-3: readSelfLandJournal FAILS CLOSED on an unreadable journal (never a silent empty map)", async () => {
	const stateDir = await tmpDir("selfland-journal-failclosed-");
	// A missing file is honest-empty.
	expect((await readSelfLandJournal(stateDir)).size).toBe(0);
	// A directory where the journal file should be → EISDIR on read → THROW, not empty.
	await fs.mkdir(path.join(stateDir, "land-receipts"), { recursive: true });
	await fs.mkdir(path.join(stateDir, "land-receipts", "self-land-journal.jsonl"));
	await expect(readSelfLandJournal(stateDir)).rejects.toThrow();
});

test("M-1: readLandReceiptIndex dedupes a double-appended row on the stable land id (no double-count)", async () => {
	const stateDir = await tmpDir("selfland-dedupe-");
	const receipt: LandReceipt = { repo: "lmvdz/glance", branch: "deepen/dup", commit: "cc", files: [], landed: true, at: Date.now(), gate: { status: "green", unprovenGreenRejected: false, newRegressions: [], baseWasRed: false }, validation: { verdict: "pass", agreement: 1, confidence: 1, perCriterion: [{ id: "ac1", satisfied: true }], rationale: "ok", ranAt: 1, reviewerPrecision: { lineage: "native", n: 3, survived: 2, survivedRate: 2 / 3, provisional: true } }, forcedWithoutProof: false, cost: { costUnknown: true } };
	// The retry-after-a-late-EIO case: the same row lands in the index TWICE.
	await appendLandReceiptIndexRow(stateDir, receipt);
	await appendLandReceiptIndexRow(stateDir, receipt);
	const { rows } = await readLandReceiptIndex(stateDir);
	expect(rows.length).toBe(1); // deduped on landId — counted exactly once
	expect(rows[0]!.landId).toBe(`deepen/dup\0cc`);
});
