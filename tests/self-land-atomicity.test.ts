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
import { journalPending, journalFinalized, journalAborted, readSelfLandJournal, journalRowsForWindow } from "../src/rail/self-land/journal.ts";
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

// ── H-3: durable journal — a merged measured land is never lost to a receipt-write fault ────────

const passRow = (branch: string, commit: string): LandReceiptIndexRow => ({ at: Date.now(), repo: "lmvdz/glance", branch, commit, landed: true, forced: false, gateStatus: "green", verdict: "pass", precision: { lineage: "native", n: 3, survived: 2 }, criteriaSource: "pr-body" });

test("H-3: appendLandReceiptIndexRow durably records a row the window reads back", async () => {
	const stateDir = await tmpDir("selfland-durable-");
	const receipt: LandReceipt = { repo: "lmvdz/glance", branch: "deepen/x", commit: "c1", files: [], landed: true, at: Date.now(), gate: { status: "green" }, validation: { verdict: "pass", agreement: 1, confidence: 1, perCriterion: [{ id: "ac1", satisfied: true }], rationale: "ok", ranAt: 1, reviewerPrecision: { lineage: "native", n: 3, survived: 2, survivedRate: 2 / 3, provisional: true } }, forcedWithoutProof: false, cost: { costUnknown: true }, criteriaSource: "pr-body" };
	await appendLandReceiptIndexRow(stateDir, receipt);
	const { rows } = await readLandReceiptIndex(stateDir);
	expect(rows.length).toBe(1);
	expect(rows[0]!.verdict).toBe("pass");
	expect(isMeasuredLand(rows[0]!)).toBe(true);
});

test("H-3: a finalized-but-not-indexed journal row is FOLDED into the window (receipt-write-failure fallback)", async () => {
	const stateDir = await tmpDir("selfland-journal-fold-");
	// Simulate the failure: a merged measured land whose index append faulted — only the journal has it.
	const id = await journalPending(stateDir, { repo: "lmvdz/glance", branch: "deepen/lost", headOid: H, criteriaSource: "pr-body", criteriaCount: 1 });
	await journalFinalized(stateDir, id, { repo: "lmvdz/glance", branch: "deepen/lost", headOid: H, landedCommit: "merge1", row: passRow("deepen/lost", "merge1") });
	// The index is empty (the append never happened), but the fold recovers the row.
	const folded = await journalRowsForWindow(stateDir, []);
	expect(folded.length).toBe(1);
	expect(folded[0]!.branch).toBe("deepen/lost");
	expect(isMeasuredLand(folded[0]!)).toBe(true);
	// Dedup: if the SAME land IS already in the index, it is not folded again (no double count).
	const already = await journalRowsForWindow(stateDir, [passRow("deepen/lost", "merge1")]);
	expect(already.length).toBe(0);
});

test("H-3: a pending/aborted journal entry is NEVER folded (only a confirmed finalized merge counts)", async () => {
	const stateDir = await tmpDir("selfland-journal-pending-");
	const idA = await journalPending(stateDir, { repo: "lmvdz/glance", branch: "deepen/pending", headOid: H, criteriaSource: "call", criteriaCount: 1 });
	void idA; // left pending — the merge never confirmed
	const idB = await journalPending(stateDir, { repo: "lmvdz/glance", branch: "deepen/aborted", headOid: H2, criteriaSource: "call", criteriaCount: 1 });
	await journalAborted(stateDir, idB, { repo: "lmvdz/glance", branch: "deepen/aborted", headOid: H2, detail: "gate red" });
	const folded = await journalRowsForWindow(stateDir, []);
	expect(folded).toEqual([]);
	// last-status-per-id: the aborted entry's latest state is "aborted", not "pending".
	const latest = await readSelfLandJournal(stateDir);
	expect(latest.get(idB)?.status).toBe("aborted");
});
