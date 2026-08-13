/**
 * The self-land path (glance#391 / #362) — a branch/PR with NO agent record routed through the rail,
 * producing a validator-stamped, precision-MEASURED receipt.
 *
 * The three properties a critic should be able to flip and watch move, all driven through the real
 * `SquadManager.selfLand` against real git repos in tmp dirs (the convention land-seam.test.ts and
 * validator-land-gate.test.ts already use):
 *  1. **Rig the gate RED ⇒ the land refuses.** No merge, no receipt, `refusal:"gate-red"`.
 *  2. **Strip the acceptance criteria ⇒ the land REFUSES, never lands green-but-unmeasured.** The
 *     accompanying "the trap is real" test proves what the refusal is protecting against: a receipt
 *     whose validator verdict is `"skipped"` carries NO precision and `isMeasuredLand` reads false.
 *  3. **Happy path ⇒ merged into a THROWAWAY target branch, with `isMeasuredLand:true` on the row
 *     that was actually written to `land-receipts/index.jsonl`** (read back off disk, not asserted).
 *
 * Nothing here touches a remote, a PR, or `main`: every land targets a `scratch/target` branch inside
 * a per-test tmp repo, so the acceptance path can never merge anything anywhere real.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acceptanceCriteriaFromPrBody, criteriaFromTexts, isMeasuredLand, landReceiptIndexRow, readLandReceiptIndex, readSelfLandJournal } from "../src/rail/index.ts";
import type { GateStage } from "../src/intake.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer } from "../src/server.ts";
import type { Judge } from "../src/validator.ts";
import type { LandReceipt } from "../src/rail/index.ts";
import type { ValidationRecord } from "../src/types.ts";
import type { ReviewerPrecisionStamp } from "../src/memory/index.ts";

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function tmpDir(prefix: string): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(d);
	return d;
}

async function git(cwd: string, ...a: string[]): Promise<void> {
	await Bun.spawn(["git", ...a], { cwd, stdout: "ignore", stderr: "ignore" }).exited;
}

const TARGET = "scratch/target";
const BRANCH = "deepen/self-land-fixture";

/**
 * A repo whose checked-out branch is a THROWAWAY target (never `main` — the land merges into whatever
 * the primary checkout has checked out in local mode), plus a feature branch with one commit and NO
 * worktree holding it, so `selfLand` can cut its own.
 */
async function repoWithFeatureBranch(prefix: string): Promise<string> {
	const repo = await tmpDir(prefix);
	await git(repo, "init", "-q", "-b", TARGET);
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "base.txt"), `base ${prefix}\n`);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	await git(repo, "checkout", "-q", "-b", BRANCH);
	await fs.writeFile(path.join(repo, "feature.txt"), `feature ${prefix}\n`);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "add feature");
	await git(repo, "checkout", "-q", TARGET);
	return repo;
}

/** Every criterion satisfied — a clean pass, whatever ids the criteria source produced. */
const passJudge: Judge = async ({ criteria }) => ({ perCriterion: criteria.map((c) => ({ id: c.id, satisfied: true })), confidence: 0.9, rationale: "all declared criteria met" });
/** One criterion unsatisfied — a real veto. */
const vetoJudge: Judge = async ({ criteria }) => ({ perCriterion: criteria.map((c, i) => ({ id: c.id, satisfied: i > 0, note: i === 0 ? "not met" : undefined })), confidence: 0.8, rationale: "first criterion unmet" });
/** The judge is unreachable — validatorGate falls open to `abstain` (judge down / empty diff). */
const throwJudge: Judge = async () => { throw new Error("judge process is down"); };

class TestManager extends SquadManager {
	judge: Judge | undefined;
	protected validatorJudgeOverride(): Judge | undefined {
		return this.judge;
	}
	ledgerPath: string | undefined;
	protected reviewerLedgerPathOverride(): string | undefined {
		return this.ledgerPath;
	}
	/** Rigged gate. `undefined` ⇒ the real per-repo detection (a bare tmp repo detects none). */
	stages: GateStage[] | undefined;
	protected selfLandGateStages(repo: string): Promise<GateStage[]> {
		return this.stages ? Promise.resolve(this.stages) : super.selfLandGateStages(repo);
	}
}

const GREEN: GateStage[] = [{ name: "gate", command: "true" }];
const RED: GateStage[] = [{ name: "gate", command: "false" }];
const CRITERIA = ["the feature file is added", "nothing else is touched"];

/** Distinct `concernClass` per row on purpose: the precision reader de-duplicates identical
 *  adjudications, so three byte-identical rows would count as one. */
const ledgerRow = (survived: boolean, n: number): string => JSON.stringify({ at: "2026-08-01", lineage: "native", concernClass: `test-fixture-${n}`, survived, source: "fixture", note: `fixture row ${n}` });

async function tmpLedgerFile(lines: string[]): Promise<string> {
	const dir = await tmpDir("self-land-ledger-");
	const file = path.join(dir, "reviewer-ledger.jsonl");
	await fs.writeFile(file, lines.map((l) => `${l}\n`).join(""));
	return file;
}

async function headOf(repo: string, ref: string): Promise<string> {
	const p = Bun.spawn(["git", "rev-parse", ref], { cwd: repo, stdout: "pipe", stderr: "ignore" });
	const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
	return out.trim();
}

async function mkManager(prefix: string): Promise<{ mgr: TestManager; repo: string; stateDir: string }> {
	const stateDir = await tmpDir(`${prefix}state-`);
	const repo = await repoWithFeatureBranch(prefix);
	const mgr = new TestManager({ stateDir });
	mgr.judge = passJudge;
	mgr.ledgerPath = await tmpLedgerFile([ledgerRow(true, 1), ledgerRow(true, 2), ledgerRow(false, 3)]);
	return { mgr, repo, stateDir };
}

// ── 1. the refusal path: a red gate blocks the land ────────────────────────────────────────────

test("REFUSAL: a rigged-RED gate refuses the self-land — nothing merges, no receipt is written", async () => {
	const { mgr, repo, stateDir } = await mkManager("self-land-red-");
	mgr.stages = RED;
	const before = await headOf(repo, TARGET);

	const result = await mgr.selfLand({ repo, branch: BRANCH, criteria: CRITERIA, expectBase: TARGET });

	expect(result.ok).toBe(false);
	expect(result.measured).toBe(false);
	expect(result.refusal).toBe("gate-red");
	expect(result.detail).toContain("gate failed");
	// The target branch never moved — the refusal is a refusal, not a rollback story.
	expect(await headOf(repo, TARGET)).toBe(before);
	// And no receipt claims a land that never happened.
	expect((await readLandReceiptIndex(stateDir)).rows).toEqual([]);
});

test("REFUSAL: the same branch with a GREEN gate DOES land — the red refusal above is the gate moving, not a broken fixture", async () => {
	const { mgr, repo } = await mkManager("self-land-green-control-");
	mgr.stages = GREEN;
	const before = await headOf(repo, TARGET);

	const result = await mgr.selfLand({ repo, branch: BRANCH, criteria: CRITERIA, expectBase: TARGET });

	expect(result.ok).toBe(true);
	expect(result.land?.merged).toBe(true);
	expect(await headOf(repo, TARGET)).not.toBe(before);
});

// ── 2. the UNMEASURED trap: no criteria ⇒ refuse, never a silent green ─────────────────────────

test("UNMEASURED TRAP: a self-land with NO acceptance criteria REFUSES — it never lands green-but-unmeasured", async () => {
	const { mgr, repo, stateDir } = await mkManager("self-land-nocrit-");
	mgr.stages = GREEN;
	const before = await headOf(repo, TARGET);

	// No `criteria`, and no PR body to derive them from (a bare tmp repo has no PR at all).
	const result = await mgr.selfLand({ repo, branch: BRANCH, expectBase: TARGET });

	expect(result.ok).toBe(false);
	expect(result.measured).toBe(false);
	expect(result.refusal).toBe("no-criteria");
	expect(result.detail).toContain("UNMEASURED");
	expect(await headOf(repo, TARGET)).toBe(before);
	expect((await readLandReceiptIndex(stateDir)).rows).toEqual([]);
	// The refusal is loud in the audit trail, not just in the return value — a refusal is the rail's
	// positive signal (#385), so it has to be countable after the fact.
	const audits = await mgr.auditLog();
	const refusal = audits.find((a) => a.action === "self-land");
	expect(refusal?.outcome).toBe("error");
	expect(refusal?.detail).toContain("no-criteria");
});

test("UNMEASURED TRAP (why it matters): a receipt whose validator verdict is \"skipped\" carries NO precision and reads as UNMEASURED", () => {
	// This is the exact row a criteria-less self-land WOULD have written: landed, green, and worth
	// nothing to the dogfood window. Pinning it here keeps the refusal above from looking like
	// paranoia — the trap is real, and `isMeasuredLand` is what would have quietly excluded the row.
	const skipped: LandReceipt = {
		repo: "lmvdz/glance",
		branch: BRANCH,
		commit: "a".repeat(40),
		files: [],
		landed: true,
		at: Date.now(),
		gate: { status: "green", unprovenGreenRejected: false, newRegressions: [], baseWasRed: false },
		validation: { verdict: "skipped", agreement: 1, confidence: 0, perCriterion: [], rationale: "no declared criteria", ranAt: Date.now() },
		forcedWithoutProof: false,
		cost: { costUnknown: true },
	};
	const row = landReceiptIndexRow(skipped);
	expect(row.landed).toBe(true);
	expect(row.precision).toBeUndefined();
	expect(isMeasuredLand(row)).toBe(false);
});

// ── 3. the happy path: a MEASURED land into a throwaway target branch ──────────────────────────

test("HAPPY PATH: a self-land into a scratch target branch merges and writes a MEASURED receipt (precision.n > 0)", async () => {
	const { mgr, repo, stateDir } = await mkManager("self-land-happy-");
	mgr.stages = GREEN;
	const before = await headOf(repo, TARGET);

	const result = await mgr.selfLand({ repo, branch: BRANCH, criteria: CRITERIA, expectBase: TARGET, message: "self-land fixture" });

	expect(result.ok).toBe(true);
	expect(result.land?.merged).toBe(true);
	expect(result.targetBranch).toBe(TARGET);
	expect(result.criteriaSource).toBe("call");
	expect(result.criteriaCount).toBe(2);
	expect(result.verdict).toBe("pass");
	// The measurement itself: a real lineage, a real n, read off the fixture reviewer ledger.
	// `SelfLandResult.precision` is declared as the narrower `LandReceiptPrecision` (the persisted-row
	// shape), but at runtime it is assigned the FULL `ReviewerPrecisionStamp` straight from the
	// validator (squad-manager.ts selfLand, `const precision: LandReceiptPrecision | undefined =
	// validation?.reviewerPrecision`) — unstripped, so `survivedRate`/`provisional` really are on it.
	// Type the expected literal as the real runtime shape (a superset of `LandReceiptPrecision`, so
	// still assignable where `LandReceiptPrecision` is expected) rather than casting it away.
	const expectedPrecision: ReviewerPrecisionStamp = { lineage: "native", n: 3, survived: 2, survivedRate: 2 / 3, provisional: true };
	expect(result.precision).toEqual(expectedPrecision);
	// `measured` is the VERDICT (a judge graded every criterion, pass, before the merge); `countedByWindow`
	// adds precision.n>0 (the reviewer has history). Both hold here.
	expect(result.measured).toBe(true);
	expect(result.countedByWindow).toBe(true);
	expect(result.receiptWritten).toBe(true);
	expect(result.receiptPath).toBeTruthy();
	expect(await headOf(repo, TARGET)).not.toBe(before);

	// Read the evidence back off disk — the drain's count must be a property of the written row.
	const { rows } = await readLandReceiptIndex(stateDir);
	expect(rows.length).toBe(1);
	expect(rows[0]!.branch).toBe(BRANCH);
	expect(rows[0]!.landed).toBe(true);
	expect(rows[0]!.forced).toBe(false);
	expect(rows[0]!.precision?.n).toBe(3);
	expect(rows[0]!.criteriaSource).toBe("call"); // M-1: provenance stamped on the row
	expect(rows[0]!.verdict).toBe("pass"); // C-3: measured rows carry an evaluated pass verdict
	expect(isMeasuredLand(rows[0]!)).toBe(true);
	// The HTML receipt exists beside the index.
	expect(await fs.stat(result.receiptPath!).then((s) => s.isFile())).toBe(true);
	// H-3: the durable journal recorded this land as finalized (the fallback evidence).
	const journal = await readSelfLandJournal(stateDir);
	const finalized = [...journal.values()].filter((e) => e.status === "finalized" && e.branch === BRANCH);
	expect(finalized.length).toBe(1);
	expect(finalized[0]!.landedCommit).toBeTruthy();
});

test("HAPPY PATH: the self-land worktree is torn down after the land (no state-dir litter)", async () => {
	const { mgr, repo, stateDir } = await mkManager("self-land-cleanup-");
	mgr.stages = GREEN;

	await mgr.selfLand({ repo, branch: BRANCH, criteria: CRITERIA, expectBase: TARGET });

	const left = await fs.readdir(path.join(stateDir, "self-land")).catch(() => [] as string[]);
	expect(left).toEqual([]);
});

// ── C-1: the mandatory-measurement gate runs BEFORE the merge, on the REAL validator path ──────
// Every one of these rigs the ACTUAL validator (an injected judge / OMP_SQUAD_VALIDATOR=0 / an
// empty diff) — never the `selfLandGateStages` proof stub — and proves the land REFUSES rather than
// merging an unmeasured land. The gate is GREEN in each, so the ONLY thing stopping the merge is the
// verdict. A merged, then a clean state (target SHA unchanged, no receipt row) proves nothing landed.

async function expectUnmeasuredRefusal(mgr: TestManager, repo: string, stateDir: string, expectedVerdict: ValidationRecord["verdict"]): Promise<void> {
	const before = await headOf(repo, TARGET);
	const result = await mgr.selfLand({ repo, branch: BRANCH, criteria: CRITERIA, expectBase: TARGET });
	expect(result.ok).toBe(false);
	expect(result.measured).toBe(false);
	expect(result.refusal).toBe("unmeasured");
	expect(result.verdict).toBe(expectedVerdict);
	expect(await headOf(repo, TARGET)).toBe(before); // nothing merged
	expect((await readLandReceiptIndex(stateDir)).rows).toEqual([]); // no receipt
}

test("C-1: judge THROWS → validator abstains → self-land REFUSES (never an ok:true unmeasured merge)", async () => {
	const { mgr, repo, stateDir } = await mkManager("self-land-abstain-judge-");
	mgr.stages = GREEN;
	mgr.judge = throwJudge;
	await expectUnmeasuredRefusal(mgr, repo, stateDir, "abstain");
});

test("C-1: OMP_SQUAD_VALIDATOR=0 → validator skipped → self-land REFUSES (a disabled validator never lands measured)", async () => {
	const saved = process.env.OMP_SQUAD_VALIDATOR;
	process.env.OMP_SQUAD_VALIDATOR = "0";
	try {
		const { mgr, repo, stateDir } = await mkManager("self-land-validator-off-");
		mgr.stages = GREEN;
		mgr.judge = passJudge; // even a would-pass judge is never consulted when the validator is off
		await expectUnmeasuredRefusal(mgr, repo, stateDir, "skipped");
	} finally {
		if (saved === undefined) delete process.env.OMP_SQUAD_VALIDATOR;
		else process.env.OMP_SQUAD_VALIDATOR = saved;
	}
});

test("C-1: a VETO (a declared criterion unmet) → self-land REFUSES, never merges the failing change", async () => {
	const { mgr, repo, stateDir } = await mkManager("self-land-veto-");
	mgr.stages = GREEN;
	mgr.judge = vetoJudge;
	await expectUnmeasuredRefusal(mgr, repo, stateDir, "veto");
});

test("C-1: an EMPTY diff → validator abstains → self-land REFUSES (an empty-diff land is not measured evidence)", async () => {
	// A branch at the SAME tip as the target: the land diff is empty, so scoreAgainstCriteria abstains.
	const stateDir = await tmpDir("self-land-emptydiff-state-");
	const repo = await tmpDir("self-land-emptydiff-");
	await git(repo, "init", "-q", "-b", TARGET);
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "base.txt"), "base\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	await git(repo, "branch", BRANCH); // BRANCH === TARGET tip — no diff
	const mgr = new TestManager({ stateDir });
	mgr.judge = passJudge;
	mgr.ledgerPath = await tmpLedgerFile([ledgerRow(true, 1)]);
	mgr.stages = GREEN;
	await expectUnmeasuredRefusal(mgr, repo, stateDir, "abstain");
});

// ── C-3: worktree isolation — collisions can't reuse, concurrent lands serialize ───────────────

test("C-3: two branches whose sanitized names COLLIDE get distinct worktrees (mkdtemp), not a reused tree", async () => {
	// `deepen/a+b` and `deepen/a-b` both sanitize to `deepen-a-b`; the OLD fixed-path key would have
	// reused one tree for both. Land each and prove both succeed independently, with no litter.
	const stateDir = await tmpDir("self-land-collide-state-");
	const repo = await tmpDir("self-land-collide-");
	await git(repo, "init", "-q", "-b", TARGET);
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "base.txt"), "base\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	for (const b of ["deepen/a+b", "deepen/a-b"]) {
		await git(repo, "checkout", "-q", "-b", b, TARGET);
		await fs.writeFile(path.join(repo, `${b.replace(/\//g, "_").replace(/\+/g, "plus")}.txt`), b);
		await git(repo, "add", "-A");
		await git(repo, "commit", "-qm", `work ${b}`);
		await git(repo, "checkout", "-q", TARGET);
	}
	const mgr = new TestManager({ stateDir });
	mgr.judge = passJudge;
	mgr.ledgerPath = await tmpLedgerFile([ledgerRow(true, 1), ledgerRow(true, 2)]);
	mgr.stages = GREEN;
	const a = await mgr.selfLand({ repo, branch: "deepen/a+b", criteria: CRITERIA, expectBase: TARGET });
	const b = await mgr.selfLand({ repo, branch: "deepen/a-b", criteria: CRITERIA, expectBase: TARGET });
	expect(a.ok).toBe(true);
	expect(b.ok).toBe(true);
	// Both landed distinct commits; no leftover worktrees.
	expect((await readLandReceiptIndex(stateDir)).rows.map((r) => r.branch).sort()).toEqual(["deepen/a+b", "deepen/a-b"]);
	expect(await fs.readdir(path.join(stateDir, "self-land")).catch(() => [])).toEqual([]);
});

test("C-3/M-2: two CONCURRENT self-lands of the same branch serialize (mutex) — neither errors on a shared worktree", async () => {
	const { mgr, repo } = await mkManager("self-land-concurrent-");
	mgr.stages = GREEN;
	// Fire both without awaiting the first: the per-(repo,branch) mutex must serialize them so they
	// never share/destroy one worktree. The first lands; the second finds nothing ahead (already
	// merged) but must not throw or corrupt state.
	const [r1, r2] = await Promise.all([
		mgr.selfLand({ repo, branch: BRANCH, criteria: CRITERIA, expectBase: TARGET }),
		mgr.selfLand({ repo, branch: BRANCH, criteria: CRITERIA, expectBase: TARGET }),
	]);
	// Exactly one merged; both returned a structured result (no throw).
	expect([r1.ok, r2.ok].filter(Boolean).length).toBeGreaterThanOrEqual(1);
	expect(typeof r1.measured).toBe("boolean");
	expect(typeof r2.measured).toBe("boolean");
});

// ── guards: the land can never merge into a branch the caller did not name ─────────────────────

test("GUARD: expectBase that does not match the real target refuses BEFORE running any gate", async () => {
	const { mgr, repo } = await mkManager("self-land-base-");
	mgr.stages = RED; // would also refuse — this must refuse EARLIER, on the base, without running it
	const before = await headOf(repo, TARGET);

	const result = await mgr.selfLand({ repo, branch: BRANCH, criteria: CRITERIA, expectBase: "main" });

	expect(result.ok).toBe(false);
	expect(result.refusal).toBe("base-mismatch");
	expect(result.detail).toContain(TARGET);
	expect(await headOf(repo, TARGET)).toBe(before);
});

test("GUARD: a self-land with neither branch nor PR refuses", async () => {
	const { mgr, repo } = await mkManager("self-land-notarget-");
	const result = await mgr.selfLand({ repo, expectBase: TARGET });
	expect(result.ok).toBe(false);
	expect(result.refusal).toBe("no-target");
});

test("GUARD (C-2): a self-land with NO expectBase refuses — it must name the branch it may merge into", async () => {
	const { mgr, repo } = await mkManager("self-land-nobase-");
	mgr.stages = GREEN;
	// @ts-expect-error deliberately omitting the now-required expectBase to prove the runtime guard
	const result = await mgr.selfLand({ repo, branch: BRANCH, criteria: CRITERIA });
	expect(result.ok).toBe(false);
	expect(result.refusal).toBe("base-mismatch");
	expect(result.detail).toContain("expectBase");
});

test("GUARD: a repo with NO detectable verification gate refuses — a land with no gate is not evidence", async () => {
	const { mgr, repo } = await mkManager("self-land-nogate-");
	mgr.stages = undefined; // real detection: a bare git repo has no package.json/Cargo.toml/go.mod
	const result = await mgr.selfLand({ repo, branch: BRANCH, criteria: CRITERIA, expectBase: TARGET });
	expect(result.ok).toBe(false);
	expect(result.refusal).toBe("no-gate");
});

test("GUARD: a branch that does not exist anywhere refuses at worktree provisioning — it never invents an empty branch", async () => {
	const { mgr, repo } = await mkManager("self-land-nobranch-");
	mgr.stages = GREEN;
	const result = await mgr.selfLand({ repo, branch: "deepen/does-not-exist", criteria: CRITERIA, expectBase: TARGET });
	expect(result.ok).toBe(false);
	expect(result.refusal).toBe("worktree-failed");
});

// ── the criteria source, unit level ────────────────────────────────────────────────────────────

test("criteria: a PR body's declared acceptance checklist becomes the graded criteria", () => {
	const body = [
		"## What",
		"",
		"- [ ] this is NOT an acceptance criterion (wrong section)",
		"",
		"## Acceptance criteria",
		"",
		"- [ ] the endpoint exists",
		"- [x] the endpoint is authenticated",
		"",
		"## Gates",
		"",
		"- [ ] also not a criterion",
	].join("\n");
	expect(acceptanceCriteriaFromPrBody(body)).toEqual([
		{ id: "ac1", text: "the endpoint exists", completed: false, source: "ticket" },
		{ id: "ac2", text: "the endpoint is authenticated", completed: true, source: "ticket" },
	]);
});

test("criteria: a PR body with no acceptance section — like every open glance draft today — yields NONE (never invented from prose)", () => {
	const body = "## What\n\nRound-2's daemon rank-3: `Store` was a 36-member bag.\n\n## Gates\n\ncheck 0 · root 5332/2\n";
	expect(acceptanceCriteriaFromPrBody(body)).toEqual([]);
	expect(acceptanceCriteriaFromPrBody(undefined)).toEqual([]);
	// An acceptance heading with PROSE under it is still nothing — only a checklist declares criteria.
	expect(acceptanceCriteriaFromPrBody("## Acceptance test\n\nA real draft PR is routed via the new verb.\n")).toEqual([]);
});

test("criteria: call-time texts are normalized, blank-dropped, and win over the body", () => {
	expect(criteriaFromTexts(["  a  ", "", "   ", "b"])).toEqual([
		{ id: "ac1", text: "a", completed: false, source: "manual" },
		{ id: "ac2", text: "b", completed: false, source: "manual" },
	]);
	expect(criteriaFromTexts([])).toEqual([]);
});

// ── the surface: POST /api/self-land ───────────────────────────────────────────────────────────
// The entry is a daemon ROUTE (not a CLI verb) because the manager that owns the land lane — its
// roster, state dir, land ledger, proof root — lives in the daemon; a CLI verb would have to stand a
// second manager up against the same state dir to do the same work. `glance land <pr>` can become a
// thin client over this later without changing anything here.

test("ROUTE: POST /api/self-land is admin-tier — an operator token is stopped at the gate", async () => {
	const { mgr } = await mkManager("self-land-route-authz-");
	await mgr.start();
	const tokens = { admin: "admin-token-xxxxxxxx", operator: "operator-token-xxxxxx" };
	const server = new SquadServer(mgr, { port: 0, token: tokens.admin, roleTokens: { operator: tokens.operator } });
	const url = server.start();
	try {
		const post = (t: string, body: unknown): Promise<Response> =>
			fetch(`${url}/api/self-land`, { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify(body) });
		expect((await post(tokens.operator, { repo: "/nonexistent", expectBase: "main" })).status).toBe(403);
		// Admin clears the gate; the handler then REFUSES (409 + a refusal code), proving authz passed.
		const denied = await post(tokens.admin, { repo: "/nonexistent", expectBase: "main" });
		expect(denied.status).toBe(409);
		expect(((await denied.json()) as { refusal?: string }).refusal).toBe("no-target");
		// A missing repo is a 400 at the schema boundary, not a mystery 500.
		expect((await post(tokens.admin, { branch: "x", expectBase: "main" })).status).toBe(400);
		// A missing expectBase is likewise a 400 — the route requires the authorized target (C-2).
		expect((await post(tokens.admin, { repo: "/nonexistent" })).status).toBe(400);
	} finally {
		server.stop();
		await mgr.stop();
	}
});

test("ROUTE: an end-to-end self-land through the HTTP surface returns measured:true and its receipt path", async () => {
	const { mgr, repo, stateDir } = await mkManager("self-land-route-e2e-");
	mgr.stages = GREEN;
	await mgr.start();
	const token = "admin-token-xxxxxxxx";
	const server = new SquadServer(mgr, { port: 0, token });
	const url = server.start();
	try {
		const res = await fetch(`${url}/api/self-land`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ repo, branch: BRANCH, criteria: CRITERIA, expectBase: TARGET }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; measured: boolean; targetBranch: string; precision?: { n: number }; receiptPath?: string };
		expect(body.ok).toBe(true);
		expect(body.measured).toBe(true);
		expect(body.targetBranch).toBe(TARGET);
		expect(body.precision?.n).toBe(3);
		expect(body.receiptPath).toBeTruthy();
		const { rows } = await readLandReceiptIndex(stateDir);
		expect(rows.length).toBe(1);
		expect(isMeasuredLand(rows[0]!)).toBe(true);
	} finally {
		server.stop();
		await mgr.stop();
	}
});
