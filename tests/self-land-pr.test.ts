/**
 * Self-land PR-mode guards (glance#391 round 2) — the paths the round-1 gauntlet found UNTESTED.
 *
 * Deliberately NO `mock.module("../src/gh.ts")`: that mock leaks process-wide across test files (the
 * bun hazard this repo has been bitten by — land-seam.test.ts carries the same latent leak, masked
 * only by file ordering). Instead the PR facts are injected through the `lookupPrByNumber` /
 * `lookupPrForBranch` seams on `SquadManager` (mirroring `validatorJudgeOverride` /
 * `resolveLandModeFor`), and the land mode is forced to `pr` through its own seam. Real git tmp repos;
 * no gh binary, no module mock, no leak.
 *
 * Every round-1 Critical/High whose selfLand-side enforcement runs BEFORE dispatch is flip-tested
 * here (base-mismatch, prForBranch-fault, head-mismatch, draft, malformed row). The under-lock
 * merge-point re-checks I added in land-pr.ts are belt-and-suspenders backstops for these SAME
 * conditions; the "guards threaded to the land" test proves selfLand passes expectBase/expectHeadOid/
 * refuseDraft down into `LandOpts`, so the backstop is wired even though the primary refusal is here.
 * H-2's strict shape-decode is unit-tested directly against `decodePrRow`.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { decodePrRow, type PrLookup, type PrRef } from "../src/land-pr.ts";
import type { LandOpts, LandResult } from "../src/land.ts";
import type { GateStage } from "../src/intake.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { Judge } from "../src/validator.ts";

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});
async function tmpDir(prefix: string): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(d);
	return d;
}
async function git(cwd: string, ...a: string[]): Promise<{ code: number; stdout: string }> {
	const p = Bun.spawn(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, , code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { code, stdout: stdout.trim() };
}
async function revParse(repo: string, ref: string): Promise<string> {
	return (await git(repo, "rev-parse", ref)).stdout;
}

const passJudge: Judge = async ({ criteria }) => ({ perCriterion: criteria.map((c) => ({ id: c.id, satisfied: true })), confidence: 0.9, rationale: "ok" });
const GREEN: GateStage[] = [{ name: "gate", command: "true" }];
const CRITERIA = ["the change is complete"];
const TARGET = "main";
const BRANCH = "deepen/pr-fixture";

const ledgerRow = (n: number): string => JSON.stringify({ at: "2026-08-01", lineage: "native", concernClass: `fix-${n}`, survived: true, source: "fixture", note: `finding ${n}` });

/** PR facts injected through the lookup seams — no gh anywhere. */
class TestManager extends SquadManager {
	judge: Judge | undefined = passJudge;
	protected validatorJudgeOverride(): Judge | undefined {
		return this.judge;
	}
	ledgerPath: string | undefined;
	protected reviewerLedgerPathOverride(): string | undefined {
		return this.ledgerPath;
	}
	stages: GateStage[] | undefined = GREEN;
	protected selfLandGateStages(): Promise<GateStage[]> {
		return Promise.resolve(this.stages ?? []);
	}
	mode: { mode: "pr" | "local"; defaultBranch?: string } = { mode: "pr", defaultBranch: "main" };
	protected resolveLandModeFor(): Promise<{ mode: "pr" | "local"; defaultBranch?: string; reason: string }> {
		return Promise.resolve({ ...this.mode, reason: "forced for test" });
	}
	byNumber: PrLookup | undefined;
	forBranch: PrLookup | undefined;
	protected lookupPrByNumber(): Promise<PrLookup> {
		return Promise.resolve(this.byNumber ?? { ok: false, detail: "no fixture" });
	}
	protected lookupPrForBranch(): Promise<PrLookup> {
		return Promise.resolve(this.forBranch ?? { ok: true, pr: undefined });
	}
	/** Capture the LandOpts selfLand threads down, and simulate a merged PR-mode land WITHOUT gh. When
	 *  `fakeLand` is set it stands in for the real merge; it calls `onValidation` with a pass record so
	 *  the pass-derived `measured` holds (the real gate is exercised in tests/self-land-merge.test.ts). */
	captured: LandOpts | undefined;
	fakeLand: ((opts: LandOpts) => LandResult) | undefined;
	protected landBranch(opts: LandOpts): Promise<LandResult> {
		this.captured = opts;
		if (this.fakeLand) {
			opts.onValidation?.({ verdict: "pass", agreement: 1, confidence: 1, perCriterion: (opts.criteria ?? []).map((c) => ({ id: c.id, satisfied: true })), rationale: "fake pass", ranAt: Date.now(), reviewerPrecision: { lineage: "native", n: 2, survived: 2, survivedRate: 1, provisional: true } });
			return Promise.resolve(this.fakeLand(opts));
		}
		return super.landBranch(opts);
	}
}

/** A repo on `main` with a feature branch that has one commit; returns the branch's real tip SHA. */
async function repoWithBranch(prefix: string): Promise<{ repo: string; tip: string }> {
	const repo = await tmpDir(prefix);
	await git(repo, "init", "-q", "-b", TARGET);
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "base.txt"), "base\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	await git(repo, "checkout", "-q", "-b", BRANCH);
	await fs.writeFile(path.join(repo, "feature.txt"), "feature\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "add feature");
	const tip = await revParse(repo, "HEAD");
	await git(repo, "checkout", "-q", TARGET);
	return { repo, tip };
}

async function mkManager(prefix: string, ledgerN = 2): Promise<TestManager> {
	const stateDir = await tmpDir(`${prefix}state-`);
	const mgr = new TestManager({ stateDir });
	const ledgerDir = await tmpDir(`${prefix}ledger-`);
	const ledgerFile = path.join(ledgerDir, "l.jsonl");
	await fs.writeFile(ledgerFile, Array.from({ length: ledgerN }, (_, i) => ledgerRow(i)).join("\n") + "\n");
	mgr.ledgerPath = ledgerFile;
	return mgr;
}

const prRef = (over: Partial<PrRef>): PrRef => ({ number: 370, url: "https://github.com/lmvdz/glance/pull/370", branch: BRANCH, baseBranch: "main", headRefOid: "0".repeat(40), state: "OPEN", isDraft: false, body: "## Acceptance\n\n- [ ] it works\n", ...over });

// ── C-2: base guard (PR mode, pre-dispatch) ─────────────────────────────────────────────────────

test("C-2: a PR whose base ≠ the authorized expectBase REFUSES (never gates one branch, merges into another)", async () => {
	const { repo, tip } = await repoWithBranch("selfland-pr-base-");
	const mgr = await mkManager("selfland-pr-base-");
	mgr.byNumber = { ok: true, pr: prRef({ number: 371, baseBranch: "develop", headRefOid: tip }) };
	const result = await mgr.selfLand({ repo, pr: 371, expectBase: "main" });
	expect(result.ok).toBe(false);
	expect(result.refusal).toBe("base-mismatch");
	expect(result.detail).toContain("develop");
});

test("C-2: prForBranch FAULT with a real open PR present REFUSES in PR mode (a fault must not skip the base guard)", async () => {
	const { repo } = await repoWithBranch("selfland-pr-fault-");
	const mgr = await mkManager("selfland-pr-fault-");
	mgr.forBranch = { ok: false, detail: "gh pr list --head faulted" }; // the lookup could not be trusted
	const result = await mgr.selfLand({ repo, branch: BRANCH, criteria: CRITERIA, expectBase: "main" });
	expect(result.ok).toBe(false);
	expect(result.refusal).toBe("pr-lookup-failed");
});

test("C-2 (control): the SAME fault in LOCAL mode does NOT refuse — there is no PR base to verify", async () => {
	const { repo } = await repoWithBranch("selfland-local-fault-");
	const mgr = await mkManager("selfland-local-fault-");
	mgr.mode = { mode: "local" }; // local mode merges into the checked-out branch, not a PR
	mgr.forBranch = { ok: false, detail: "gh pr list --head faulted" };
	// The repo is checked out on main (TARGET); expectBase main matches. A gh fault only costs the body.
	const result = await mgr.selfLand({ repo, branch: BRANCH, criteria: CRITERIA, expectBase: "main" });
	// Not a lookup refusal — it proceeds (and here lands, proving the fault was non-fatal in local mode).
	expect(result.refusal).not.toBe("pr-lookup-failed");
	expect(result.ok).toBe(true);
});

// ── C-3: head guard (PR mode, pre-dispatch) ─────────────────────────────────────────────────────

test("C-3: local tip ≠ the PR's headRefOid REFUSES (head-mismatch) — a stale branch is never force-pushed", async () => {
	const { repo, tip } = await repoWithBranch("selfland-pr-head-");
	const mgr = await mkManager("selfland-pr-head-");
	mgr.byNumber = { ok: true, pr: prRef({ number: 373, headRefOid: "0".repeat(40) }) }; // PR head ≠ real tip
	const result = await mgr.selfLand({ repo, pr: 373, expectBase: "main" });
	expect(result.ok).toBe(false);
	expect(result.refusal).toBe("head-mismatch");
	expect(result.detail).toContain(tip.slice(0, 12));
	// The land was never dispatched — no force-push could have happened.
	expect(mgr.captured).toBeUndefined();
});

// ── H-1: draft (PR mode, pre-dispatch) ──────────────────────────────────────────────────────────

test("H-1: a DRAFT PR REFUSES (GitHub reports drafts as OPEN, and glance's own PRs are normally drafts)", async () => {
	const { repo, tip } = await repoWithBranch("selfland-pr-draft-");
	const mgr = await mkManager("selfland-pr-draft-");
	mgr.byNumber = { ok: true, pr: prRef({ number: 374, headRefOid: tip, isDraft: true }) };
	const result = await mgr.selfLand({ repo, pr: 374, expectBase: "main" });
	expect(result.ok).toBe(false);
	expect(result.refusal).toBe("pr-draft");
	expect(mgr.captured).toBeUndefined();
});

// ── the guards are THREADED into the land (belt-and-suspenders backstop is wired) ───────────────

test("PR mode: selfLand threads expectBase / expectHeadOid / refuseDraft into LandOpts (the under-lock backstop is wired)", async () => {
	const { repo, tip } = await repoWithBranch("selfland-pr-thread-");
	const mgr = await mkManager("selfland-pr-thread-");
	mgr.byNumber = { ok: true, pr: prRef({ number: 377, headRefOid: tip, body: "## Acceptance\n\n- [ ] done\n" }) };
	// Simulate a successful PR-mode merge WITHOUT gh — we only care that the guards were threaded down.
	mgr.fakeLand = (opts) => ({ ok: true, committed: true, merged: true, message: opts.message, mode: "pr", prNumber: 377, head0: "aaaa", landedCommit: "bbbb" });
	const result = await mgr.selfLand({ repo, pr: 377, expectBase: "main" });
	expect(result.ok).toBe(true);
	expect(result.measured).toBe(true); // verdict pass (via the gate), and a real merge
	expect(result.criteriaSource).toBe("pr-body"); // criteria came from the PR's own checklist
	expect(mgr.captured?.expectBase).toBe("main");
	expect(mgr.captured?.expectHeadOid).toBe(tip);
	expect(mgr.captured?.refuseDraft).toBe(true);
	expect(mgr.captured?.requireValidationPass).toBe(true); // C-3: the pass invariant is threaded INTO landBranch
	expect(mgr.captured?.criteria?.length).toBe(1);
});

// ── H-2: strict shape-decode (unit, no gh, no mock) ─────────────────────────────────────────────

test("H-2: decodePrRow rejects malformed gh rows and NEVER throws", () => {
	// A well-formed row decodes.
	const good = { number: 1, url: "u", state: "OPEN", headRefName: "b", headRefOid: "a".repeat(40), baseRefName: "main", isDraft: false, body: "x" };
	expect(decodePrRow(good, "ctx").ok).toBe(true);
	// Each malformation is rejected, not thrown, not coerced.
	for (const bad of [
		null,
		"a string",
		[good],
		{ ...good, number: "1" }, // non-numeric number
		{ ...good, number: -3 }, // non-positive
		{ ...good, headRefName: "" }, // empty head
		{ ...good, headRefOid: "" }, // no head sha
		{ ...good, headRefOid: "nothex" }, // non-hex sha
		{ ...good, baseRefName: 5 }, // non-string base
		{ ...good, isDraft: "false" }, // non-boolean draft
		{ ...good, state: "" }, // no state
	]) {
		const r = decodePrRow(bad, "ctx");
		expect(r.ok).toBe(false);
	}
	// A non-string body does not throw — it is dropped to undefined (the never-throws contract).
	const weirdBody = decodePrRow({ ...good, body: { not: "a string" } }, "ctx");
	expect(weirdBody.ok).toBe(true);
	if (weirdBody.ok) expect(weirdBody.pr.body).toBeUndefined();
});

test("H-2: decodePrRow with expectHead rejects a row whose head ≠ the requested branch (A can't authorize B)", () => {
	const rowForB = { number: 9, url: "u", state: "OPEN", headRefName: "branch-B", headRefOid: "a".repeat(40), baseRefName: "main", isDraft: false, body: "x" };
	const asked = decodePrRow(rowForB, "gh pr list --head branch-A", "branch-A");
	expect(asked.ok).toBe(false);
	if (!asked.ok) expect(asked.detail).toContain("branch-B");
});
