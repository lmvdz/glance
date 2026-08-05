/**
 * Validator land-gate (Epic 3, leaf 02) — the independent-validator veto at `SquadManager.landBranch`,
 * the mode-dispatch seam EVERY land funnels through (DESIGN §1). A fixture feature declares two
 * criteria; a fake judge marks one unsatisfied. Asserts: (a) a normal land is blocked with the veto
 * reason surfaced; (b) a FORCED land (`requireProof:false`, no `validatorOverride`) is ALSO blocked —
 * the veto is not on the "or force" path; (c) `OMP_SQUAD_VALIDATOR=0` disables the gate entirely and
 * the land proceeds; (d) a passing judge lands normally and stamps `agent.validation`.
 *
 * Real git in tmp dirs (mirrors land.test.ts/land-seam.test.ts's convention); the judge is injected
 * via a `TestManager` subclass overriding `validatorJudgeOverride` — mirrors how `land-seam.test.ts`
 * overrides `resolveLandModeFor` to avoid needing a real `omp` binary on PATH.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runProof } from "../src/proof.ts";
import { SquadManager } from "../src/squad-manager.ts";
import {
	TRANSCRIPT_EVENT_GATE_VERDICT,
	TRANSCRIPT_EVENT_LAND_ATTEMPT,
	TRANSCRIPT_EVENT_LAND_MERGE,
} from "../src/transcript-event-kinds.ts";
import { SubagentTracker } from "../src/subagents.ts";
import type { AgentDTO, PersistedAgent, PersistedFeature } from "../src/types.ts";
import { validatorGate, withFreshReviewerPrecision, type Judge } from "../src/validator.ts";
import type { ValidationRecord } from "../src/types.ts";

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

const ENV_KEYS = ["OMP_SQUAD_VALIDATOR"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

async function tmpDir(prefix: string): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(d);
	return d;
}

async function git(cwd: string, ...a: string[]): Promise<void> {
	await Bun.spawn(["git", ...a], { cwd, stdout: "ignore", stderr: "ignore" }).exited;
}

/** A repo on `main` with one base commit, plus a worktree branched off it with one committed file —
 *  enough for a real, non-empty `git diff` between the worktree branch and the repo's HEAD. File
 *  content is unique per call (embeds `prefix`) so different tests never accidentally hash-collide
 *  on `validatorGate`'s `(commit,tree)` cache — real units always differ; identical fixture content
 *  across tests would not. */
async function repoWithBranch(prefix: string): Promise<{ repo: string; worktree: string; branch: string }> {
	const repo = await tmpDir(prefix);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "base.txt"), `base ${prefix}\n`);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	const branch = "squad/vgate";
	const worktree = path.join(await tmpDir(`${prefix}wt-`), "wt");
	await git(repo, "worktree", "add", "-q", "-b", branch, worktree, "main");
	await fs.writeFile(path.join(worktree, "feature.txt"), `new ${prefix}\n`);
	await git(worktree, "add", "-A");
	await git(worktree, "commit", "-qm", "add feature");
	return { repo, worktree, branch };
}

class TestManager extends SquadManager {
	judge: Judge | undefined;
	protected validatorJudgeOverride(): Judge | undefined {
		return this.judge;
	}
	/** DI hatch for the reviewer-precision reader (gauntlet round 1: a function parameter, never an
	 *  environment variable — see `SquadManager.reviewerLedgerPathOverride`'s doc). */
	ledgerPath: string | undefined;
	protected reviewerLedgerPathOverride(): string | undefined {
		return this.ledgerPath;
	}
}

function seedAgent(mgr: SquadManager, id: string, repo: string, worktree: string, branch: string, featureId?: string): void {
	const dto: AgentDTO = {
		id,
		name: id,
		status: "idle",
		kind: "omp-operator",
		repo,
		worktree,
		branch,
		approvalMode: "yolo",
		pending: [],
		lastActivity: 0,
		messageCount: 0,
		featureId,
	};
	const options: PersistedAgent = { id, name: id, repo, worktree, approvalMode: "yolo" };
	mgr.agents.set(id, { dto, agent: undefined as never, options, transcript: [], assistantBuf: "", streaming: false, subs: new SubagentTracker() });
}

/** A judge that marks c1 satisfied and c2 unsatisfied — a real veto. */
const vetoJudge: Judge = async () => ({ perCriterion: [{ id: "c1", satisfied: true }, { id: "c2", satisfied: false, note: "auth missing" }], confidence: 0.8, rationale: "auth criterion not met" });
/** A judge that marks every criterion satisfied. */
const passJudge: Judge = async () => ({ perCriterion: [{ id: "c1", satisfied: true }, { id: "c2", satisfied: true }] });

const CRITERIA = [
	{ id: "c1", text: "adds the endpoint", completed: false },
	{ id: "c2", text: "the endpoint is authenticated", completed: false },
];

test("a normal land is blocked by a real veto, with the reason surfaced in detail", async () => {
	const stateDir = await tmpDir("vgate-state-");
	const { repo, worktree, branch } = await repoWithBranch("vgate-normal-");
	const mgr = new TestManager({ stateDir }); // sets the module-level proof root to stateDir
	mgr.judge = vetoJudge;
	seedAgent(mgr, "a1", repo, worktree, branch, "f1");
	(mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore.set("f1", { id: "f1", title: "F1", repo, createdAt: 0, updatedAt: 0, acceptanceCriteria: CRITERIA });
	await runProof({ repo, worktree, command: "true" }); // a genuine fresh proof so proofGate passes and the validator gate is reached

	const result = await mgr.land("a1", undefined, {});

	expect(result.ok).toBe(false);
	expect(result.detail).toContain("validator veto");
	expect(result.detail).toContain("c2");
	expect(mgr.agents.get("a1")?.dto.validation?.verdict).toBe("veto");
});

test("a FORCED land (requireProof:false) with NO validatorOverride is ALSO blocked — the veto is not on the force path", async () => {
	const stateDir = await tmpDir("vgate-forced-state-");
	const { repo, worktree, branch } = await repoWithBranch("vgate-forced-");
	const mgr = new TestManager({ stateDir });
	mgr.judge = vetoJudge;
	seedAgent(mgr, "a1", repo, worktree, branch, "f1");
	(mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore.set("f1", { id: "f1", title: "F1", repo, createdAt: 0, updatedAt: 0, acceptanceCriteria: CRITERIA });

	const result = await mgr.land("a1", undefined, { force: true, reason: "unrelated force reason" });

	expect(result.ok).toBe(false);
	expect(result.detail).toContain("validator veto");
});

test("an explicit validatorOverride with a reason class bypasses the veto and records it", async () => {
	const stateDir = await tmpDir("vgate-override-state-");
	const { repo, worktree, branch } = await repoWithBranch("vgate-override-");
	const mgr = new TestManager({ stateDir });
	mgr.judge = vetoJudge;
	seedAgent(mgr, "a1", repo, worktree, branch, "f1");
	(mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore.set("f1", { id: "f1", title: "F1", repo, createdAt: 0, updatedAt: 0, acceptanceCriteria: CRITERIA });
	await runProof({ repo, worktree, command: "true" });

	const result = await mgr.land("a1", undefined, { validatorOverride: { reasonClass: "criteria-wrong" } });

	expect(result.ok).toBe(true);
	expect(result.merged).toBe(true);
	const { readValidatorOverrides } = await import("../src/rail/land-ledger.ts");
	const overrides = readValidatorOverrides(stateDir);
	expect(overrides.length).toBe(1);
	expect(overrides[0].branch).toBe(branch);
	expect(overrides[0].reasonClass).toBe("criteria-wrong");
	// t3-face concern 06 (grok-4.5 cross-lineage review): `runValidatorGate` stamped
	// `dto.validation.verdict = "veto"` BEFORE this override bypass ran, and nothing since re-scores
	// the diff — the needs-you ladder's `error` rung (attention-ladder.ts) reads that verdict with no
	// time bound, so without the fix this unit would report `error` FOREVER after a land that just
	// succeeded. Driven through the REAL land() override path, not a hand-cleared fixture.
	expect(mgr.agents.get("a1")?.dto.validation).toBeUndefined();
	expect(mgr.agents.get("a1")?.dto.ladderPriority).not.toBe("error");
});

test("OMP_SQUAD_VALIDATOR=0 disables the gate entirely — a would-veto judge never blocks the land", async () => {
	process.env.OMP_SQUAD_VALIDATOR = "0";
	const stateDir = await tmpDir("vgate-off-state-");
	const { repo, worktree, branch } = await repoWithBranch("vgate-off-");
	const mgr = new TestManager({ stateDir });
	mgr.judge = vetoJudge;
	seedAgent(mgr, "a1", repo, worktree, branch, "f1");
	(mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore.set("f1", { id: "f1", title: "F1", repo, createdAt: 0, updatedAt: 0, acceptanceCriteria: CRITERIA });
	await runProof({ repo, worktree, command: "true" });

	const result = await mgr.land("a1", undefined, {});

	expect(result.ok).toBe(true);
	expect(result.merged).toBe(true);
	expect(mgr.agents.get("a1")?.dto.validation?.verdict).toBe("skipped");
});

test("a passing judge lands normally and stamps agent.validation", async () => {
	const stateDir = await tmpDir("vgate-pass-state-");
	const { repo, worktree, branch } = await repoWithBranch("vgate-pass-");
	const mgr = new TestManager({ stateDir });
	mgr.judge = passJudge;
	seedAgent(mgr, "a1", repo, worktree, branch, "f1");
	(mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore.set("f1", { id: "f1", title: "F1", repo, createdAt: 0, updatedAt: 0, acceptanceCriteria: CRITERIA });
	await runProof({ repo, worktree, command: "true" });

	const result = await mgr.land("a1", undefined, {});

	expect(result.ok).toBe(true);
	expect(result.merged).toBe(true);
	expect(mgr.agents.get("a1")?.dto.validation?.verdict).toBe("pass");
	expect(mgr.agents.get("a1")?.dto.validation?.agreement).toBe(1);
	const events = mgr.getTranscript("a1").filter((e) => e.event);
	expect(events.every((e) => e.event?.issuer === "manager")).toBe(true);
	expect(events.map((e) => e.event?.kind)).toContain(TRANSCRIPT_EVENT_GATE_VERDICT);
	expect(events.map((e) => e.event?.kind)).toContain(TRANSCRIPT_EVENT_LAND_ATTEMPT);
	expect(events.map((e) => e.event?.kind)).toContain(TRANSCRIPT_EVENT_LAND_MERGE);
	const verdict = events.find((e) => e.event?.kind === TRANSCRIPT_EVENT_GATE_VERDICT);
	expect(verdict?.status).toBe("ok");
	expect(verdict?.event?.payload).toMatchObject({ verdict: "pass", agreement: 1, confidence: 0 });
	const merge = events.find((e) => e.event?.kind === TRANSCRIPT_EVENT_LAND_MERGE);
	expect(merge?.status).toBe("ok");
	expect(merge?.event?.payload).toMatchObject({ stage: "finalized", agentId: "a1", branch });
});

test("a feature with no declared criteria ⇒ skipped, land proceeds (never invents criteria)", async () => {
	const stateDir = await tmpDir("vgate-empty-state-");
	const { repo, worktree, branch } = await repoWithBranch("vgate-empty-");
	const mgr = new TestManager({ stateDir });
	mgr.judge = vetoJudge; // would veto if ever called with real criteria
	seedAgent(mgr, "a1", repo, worktree, branch, "f1");
	(mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore.set("f1", { id: "f1", title: "F1", repo, createdAt: 0, updatedAt: 0 }); // no acceptanceCriteria
	await runProof({ repo, worktree, command: "true" });

	const result = await mgr.land("a1", undefined, {});

	expect(result.ok).toBe(true);
	expect(mgr.agents.get("a1")?.dto.validation?.verdict).toBe("skipped");
});

// ── validatorGate() unit-level: diff computation + caching (leaf 02's own primitive) ───────────────

test("validatorGate: computes a real diff and vetoes on a fixture feature whose criteria include one the diff misses", async () => {
	const { repo, worktree } = await repoWithBranch("vgate-direct-");
	const { record, veto } = await validatorGate({ criteria: CRITERIA, repo, worktree, judge: vetoJudge });
	expect(record.verdict).toBe("veto");
	expect(veto).toContain("c2");
});

test("validatorGate: caches the verdict by (commit,tree) — a second call with the SAME proof does not re-invoke the judge", async () => {
	const { repo, worktree } = await repoWithBranch("vgate-cache-");
	// A real base commit so `computeLandDiff` produces a non-empty diff and the judge is actually invoked
	// (an unresolvable base ⇒ empty diff ⇒ abstain without ever calling the judge — can't test caching).
	const baseCommit = (await new Response(Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: repo, stdout: "pipe" }).stdout).text()).trim();
	let calls = 0;
	const countingJudge: Judge = async () => {
		calls++;
		return { perCriterion: [{ id: "c1", satisfied: true }, { id: "c2", satisfied: true }] };
	};
	const proof = { ok: true, commit: "deadbeef", tree: "cafef00d", branch: "b", dirty: false, baseCommit, repo, worktree, command: "test", commandHash: "h", ranAt: 1, ttlMs: 1000, detail: "", artifacts: [] };
	const first = await validatorGate({ criteria: CRITERIA, repo, worktree, proof, judge: countingJudge });
	const second = await validatorGate({ criteria: CRITERIA, repo, worktree, proof, judge: countingJudge });
	expect(first.record.verdict).toBe("pass");
	expect(second.record).toEqual(first.record);
	expect(calls).toBe(1);
});

test("validatorGate: OMP_SQUAD_VALIDATOR=0 short-circuits before touching git or the judge", async () => {
	process.env.OMP_SQUAD_VALIDATOR = "0";
	let called = false;
	const judge: Judge = async () => {
		called = true;
		return { perCriterion: [{ id: "c1", satisfied: false }] };
	};
	const { record, veto } = await validatorGate({ criteria: CRITERIA, repo: "/nonexistent", worktree: "/nonexistent", judge });
	expect(record.verdict).toBe("skipped");
	expect(veto).toBeUndefined();
	expect(called).toBe(false);
});

// ── glance#332: the land receipt carries the judging lineage's MEASURED reviewer precision ─────────
// A fixture ledger, injected via `TestManager.ledgerPath` (real DI through `reviewerLedgerPathOverride`
// — gauntlet round 1, codex's "env-ledger-shadow" finding closed this off as an env var: production
// never reads one, so a launch-directory `.env` can no longer redirect this read), stands in for
// plans/.reviews/reviewer-ledger.jsonl. The default (unset OMP_SQUAD_VALIDATOR_HARNESS) judge harness
// is "omp", whose ledger lineage tag is "native".

async function tmpLedgerFile(lines: string[]): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vgate-ledger-"));
	tmps.push(dir);
	const file = path.join(dir, "reviewer-ledger.jsonl");
	await fs.writeFile(file, lines.map((l) => `${l}\n`).join(""));
	return file;
}

const ledgerRow = (survived: boolean, note = "fixture row") => JSON.stringify({ at: "2026-08-01", lineage: "native", concernClass: "test-fixture", survived, source: "fixture", note });

test("a landed unit's validation record carries the judging lineage's measured precision, end-to-end through the land path", async () => {
	const stateDir = await tmpDir("vgate-precision-state-");
	const { repo, worktree, branch } = await repoWithBranch("vgate-precision-");
	const mgr = new TestManager({ stateDir });
	mgr.ledgerPath = await tmpLedgerFile([ledgerRow(true), ledgerRow(false)]);
	mgr.judge = passJudge;
	seedAgent(mgr, "a1", repo, worktree, branch, "f1");
	(mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore.set("f1", { id: "f1", title: "F1", repo, createdAt: 0, updatedAt: 0, acceptanceCriteria: CRITERIA });
	await runProof({ repo, worktree, command: "true" });

	const result = await mgr.land("a1", undefined, {});

	expect(result.ok).toBe(true);
	const precision = mgr.agents.get("a1")?.dto.validation?.reviewerPrecision;
	expect(precision).toEqual({ lineage: "native", n: 2, survived: 1, survivedRate: 0.5, provisional: true });
	expect(Object.hasOwn(precision ?? {}, "survivedRate")).toBe(true); // n>0 ⇒ genuinely OWNED, not merely truthy
	// The same stamp rides the transcript's gate-verdict event, and the narration cites the number.
	const verdict = mgr.getTranscript("a1").find((e) => e.event?.kind === TRANSCRIPT_EVENT_GATE_VERDICT);
	expect(verdict?.event?.payload).toMatchObject({ reviewerPrecision: precision });
	expect(verdict?.text).toContain("native, measured precision 50% (n=2 adjudicated rows) [provisional]");
});

test("HONESTY: a lineage with NO ledger history lands with reviewerPrecision.n === 0 and survivedRate ABSENT (not merely undefined) — never a fabricated number", async () => {
	const stateDir = await tmpDir("vgate-precision-zero-state-");
	const { repo, worktree, branch } = await repoWithBranch("vgate-precision-zero-");
	const mgr = new TestManager({ stateDir });
	mgr.ledgerPath = await tmpLedgerFile([]); // empty ledger — never-reviewed lineage
	mgr.judge = passJudge;
	seedAgent(mgr, "a1", repo, worktree, branch, "f1");
	(mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore.set("f1", { id: "f1", title: "F1", repo, createdAt: 0, updatedAt: 0, acceptanceCriteria: CRITERIA });
	await runProof({ repo, worktree, command: "true" });

	const result = await mgr.land("a1", undefined, {});

	expect(result.ok).toBe(true);
	const precision = mgr.agents.get("a1")?.dto.validation?.reviewerPrecision;
	expect(precision).toEqual({ lineage: "native", n: 0, survived: 0, provisional: true });
	// toEqual alone can't distinguish "key absent" from "key present holding undefined" (gauntlet round
	// 1, codex's "survivedRate present-as-undefined" finding) — assert ownership explicitly.
	expect(Object.hasOwn(precision ?? { survivedRate: 1 }, "survivedRate")).toBe(false);
	const verdict = mgr.getTranscript("a1").find((e) => e.event?.kind === TRANSCRIPT_EVENT_GATE_VERDICT);
	expect(verdict?.text).toContain("native, unmeasured (n=0)");
});

test("FLIP THE INPUT: two lands (different commits) against the SAME still-growing fixture ledger get DIFFERENT receipts", async () => {
	const stateDir = await tmpDir("vgate-precision-flip-state-");
	const ledgerPath = await tmpLedgerFile([ledgerRow(true)]);
	const mgr = new TestManager({ stateDir });
	mgr.ledgerPath = ledgerPath;
	mgr.judge = passJudge;

	// First land: 1 adjudicated row, 100% survived.
	const first = await repoWithBranch("vgate-precision-flip-a-");
	seedAgent(mgr, "a1", first.repo, first.worktree, first.branch, "f1");
	(mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore.set("f1", { id: "f1", title: "F1", repo: first.repo, createdAt: 0, updatedAt: 0, acceptanceCriteria: CRITERIA });
	await runProof({ repo: first.repo, worktree: first.worktree, command: "true" });
	const firstResult = await mgr.land("a1", undefined, {});
	expect(firstResult.ok).toBe(true);
	const firstPrecision = mgr.agents.get("a1")?.dto.validation?.reviewerPrecision;
	expect(firstPrecision).toEqual({ lineage: "native", n: 1, survived: 1, survivedRate: 1, provisional: true });

	// The fixture ledger grows — a new adjudicated finding that did NOT survive.
	await fs.appendFile(ledgerPath, `${ledgerRow(false, "second finding")}\n`);

	// Second land, a DIFFERENT branch/diff (a different (commit,tree) so validatorGate's cache is a genuine miss).
	const second = await repoWithBranch("vgate-precision-flip-b-");
	seedAgent(mgr, "a2", second.repo, second.worktree, second.branch, "f2");
	(mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore.set("f2", { id: "f2", title: "F2", repo: second.repo, createdAt: 0, updatedAt: 0, acceptanceCriteria: CRITERIA });
	await runProof({ repo: second.repo, worktree: second.worktree, command: "true" });
	const secondResult = await mgr.land("a2", undefined, {});
	expect(secondResult.ok).toBe(true);
	const secondPrecision = mgr.agents.get("a2")?.dto.validation?.reviewerPrecision;

	expect(secondPrecision).toEqual({ lineage: "native", n: 2, survived: 1, survivedRate: 0.5, provisional: true });
	expect(secondPrecision?.n).not.toBe(firstPrecision?.n);
	expect(secondPrecision?.survivedRate).not.toBe(firstPrecision?.survivedRate);
});

// ── SHIP-BLOCKER FIX (gauntlet round 1 — codex gpt-5.6-sol AND grok-4.5, converged independently): ──
// gateCache freezes the JUDGE VERDICT keyed only on (commit,tree,criteriaHash) — a re-land of the SAME
// commit/tree after the reviewer ledger grew must NOT return a stale reviewerPrecision, even though the
// cached judge verdict is (correctly) reused. This is the exact scenario the earlier flip-the-input test
// dodged by using a different cache key each time.
test("SHIP-BLOCKER FIX: re-scoring the SAME (commit,tree,criteria) after the ledger grows MOVES reviewerPrecision even though the cached judge verdict is reused", async () => {
	const { repo, worktree } = await repoWithBranch("vgate-precision-cachehit-");
	const baseCommit = (await new Response(Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: repo, stdout: "pipe" }).stdout).text()).trim();
	const ledgerPath = await tmpLedgerFile([ledgerRow(true)]);
	let judgeCalls = 0;
	const countingPassJudge: Judge = async () => {
		judgeCalls++;
		return { perCriterion: [{ id: "c1", satisfied: true }, { id: "c2", satisfied: true }] };
	};
	const proof = { ok: true, commit: "deadbeef-precision", tree: "cafef00d-precision", branch: "b", dirty: false, baseCommit, repo, worktree, command: "test", commandHash: "h", ranAt: 1, ttlMs: 1000, detail: "", artifacts: [] };

	const first = await validatorGate({ criteria: CRITERIA, repo, worktree, proof, judge: countingPassJudge, reviewerLedgerPath: ledgerPath });
	expect(first.record.verdict).toBe("pass");
	expect(first.record.reviewerPrecision).toEqual({ lineage: "native", n: 1, survived: 1, survivedRate: 1, provisional: true });
	expect(judgeCalls).toBe(1);

	// The ledger grows. The (commit,tree,criteria) tuple is UNCHANGED — this second call is exactly the
	// gateCache HIT path (same key as the first call).
	await fs.appendFile(ledgerPath, `${ledgerRow(false, "second finding")}\n`);

	const second = await validatorGate({ criteria: CRITERIA, repo, worktree, proof, judge: countingPassJudge, reviewerLedgerPath: ledgerPath });

	// The judge verdict itself IS the cached value — never re-invoked (caching still works).
	expect(judgeCalls).toBe(1);
	expect(second.record.verdict).toBe(first.record.verdict);
	expect(second.record.agreement).toBe(first.record.agreement);
	// But reviewerPrecision reflects the CURRENT ledger, not the ledger as it stood at the first call —
	// this is the number that must never be served stale from the cache.
	expect(second.record.reviewerPrecision).toEqual({ lineage: "native", n: 2, survived: 1, survivedRate: 0.5, provisional: true });
	expect(second.record.reviewerPrecision?.n).not.toBe(first.record.reviewerPrecision?.n);
	expect(second.record.reviewerPrecision?.survivedRate).not.toBe(first.record.reviewerPrecision?.survivedRate);
});

// ── SERIOUS new defect (gauntlet round 2, delta-verify) — precision-lineage-mismatch-on-cache-hit:
// withFreshReviewerPrecision must restamp using the CACHED VERDICT's own judge lineage, never
// whatever harness happens to be active right now — those can differ across two resolutions of the
// same cached record (an operator flipping OMP_SQUAD_VALIDATOR_HARNESS, or a foreign judge binary
// coming or going), and restamping from the wrong lineage would show the approver a precision number
// for a DIFFERENT reviewer than the one credited with the verdict.
test("withFreshReviewerPrecision restamps using the CACHED record's OWN reviewerLineage, never the currently active harness", async () => {
	// Built directly (not via the shared `ledgerRow` helper, which hardcodes lineage "native") — three
	// codex rows (2 survived) and one native row, with visibly different math, so a lineage mix-up is
	// unmistakable in the result.
	const ledgerPath = await tmpLedgerFile([]);
	await fs.writeFile(
		ledgerPath,
		[
			JSON.stringify({ at: "2026-08-01", lineage: "codex", concernClass: "test-fixture", survived: true, source: "fixture", note: "codex finding one" }),
			JSON.stringify({ at: "2026-08-01", lineage: "codex", concernClass: "test-fixture", survived: true, source: "fixture", note: "codex finding two" }),
			JSON.stringify({ at: "2026-08-01", lineage: "codex", concernClass: "test-fixture", survived: false, source: "fixture", note: "codex finding three" }),
			JSON.stringify({ at: "2026-08-01", lineage: "native", concernClass: "test-fixture", survived: true, source: "fixture", note: "native finding one" }),
		]
			.map((l) => `${l}\n`)
			.join(""),
	);

	// A verdict that was ACTUALLY judged by the codex (openai-lineage) harness — as if it were cached
	// from a resolution where OMP_SQUAD_VALIDATOR_HARNESS=codex was active.
	const cachedAsCodex: ValidationRecord = {
		verdict: "pass",
		agreement: 1,
		confidence: 1,
		perCriterion: [{ id: "c1", satisfied: true }],
		rationale: "",
		model: "codex",
		reviewerLineage: "openai",
		authorLineage: "unknown",
		ranAt: 0,
	};

	// Simulate the active harness having since changed to something else entirely — restamping must
	// NOT be swayed by this; the env var isn't even read by withFreshReviewerPrecision at all anymore.
	const savedHarness = process.env.OMP_SQUAD_VALIDATOR_HARNESS;
	process.env.OMP_SQUAD_VALIDATOR_HARNESS = "grok";
	try {
		const restamped = withFreshReviewerPrecision(cachedAsCodex, ledgerPath);
		expect(restamped.reviewerPrecision?.lineage).toBe("codex");
		expect(restamped.reviewerPrecision).toEqual({ lineage: "codex", n: 3, survived: 2, survivedRate: 2 / 3, provisional: true });
	} finally {
		if (savedHarness === undefined) delete process.env.OMP_SQUAD_VALIDATOR_HARNESS;
		else process.env.OMP_SQUAD_VALIDATOR_HARNESS = savedHarness;
	}
});

test("withFreshReviewerPrecision restamps as 'native' for an anthropic-judged cached verdict, regardless of active harness", async () => {
	const ledgerPath = await tmpLedgerFile([ledgerRow(true), ledgerRow(false, "second finding")]);
	const cachedAsNative: ValidationRecord = {
		verdict: "pass",
		agreement: 1,
		confidence: 1,
		perCriterion: [],
		rationale: "",
		model: "opus",
		reviewerLineage: "anthropic",
		ranAt: 0,
	};
	const restamped = withFreshReviewerPrecision(cachedAsNative, ledgerPath);
	expect(restamped.reviewerPrecision).toEqual({ lineage: "native", n: 2, survived: 1, survivedRate: 0.5, provisional: true });
});

test("withFreshReviewerPrecision leaves skipped/inconclusive verdicts untouched (no reviewer identity to restamp)", () => {
	const skipped: ValidationRecord = { verdict: "skipped", agreement: 1, confidence: 0, perCriterion: [], rationale: "no declared criteria", ranAt: 0 };
	expect(withFreshReviewerPrecision(skipped)).toEqual(skipped);
	const inconclusive: ValidationRecord = { verdict: "inconclusive", agreement: 0, confidence: 0, perCriterion: [], rationale: "git fault", ranAt: 0 };
	expect(withFreshReviewerPrecision(inconclusive)).toEqual(inconclusive);
});

// ── MEDIUM (gauntlet round 3, delta-verify): "absent-lineage-fabricated-as-native" — a record with no
// resolvable reviewer identity at all (no model, reviewerLineage absent or "unknown") must render as an
// honest "unmeasured", never silently defaulted to the "native" bucket — that would fabricate a
// measurement for a reviewer we don't actually know ran (the campaign's signature absence-as-value bug).
test("HONESTY (gauntlet round 3): a record with NO reviewerLineage and no model restamps as 'unknown', never fabricated as 'native'", async () => {
	const ledgerPath = await tmpLedgerFile([ledgerRow(true), ledgerRow(false, "second finding")]); // real "native" history exists — a wrong fallback would find real numbers here
	const noIdentity: ValidationRecord = { verdict: "pass", agreement: 1, confidence: 1, perCriterion: [], rationale: "", ranAt: 0 };
	const restamped = withFreshReviewerPrecision(noIdentity, ledgerPath);
	expect(restamped.reviewerPrecision?.lineage).toBe("unknown");
	expect(restamped.reviewerPrecision?.lineage).not.toBe("native");
	expect(restamped.reviewerPrecision).toEqual({ lineage: "unknown", n: 0, survived: 0, provisional: true });
});

test("HONESTY (gauntlet round 3): a record with reviewerLineage explicitly 'unknown' and no model ALSO restamps as 'unknown', not 'native'", async () => {
	const ledgerPath = await tmpLedgerFile([ledgerRow(true)]);
	const explicitlyUnknown: ValidationRecord = { verdict: "pass", agreement: 1, confidence: 1, perCriterion: [], rationale: "", reviewerLineage: "unknown", ranAt: 0 };
	const restamped = withFreshReviewerPrecision(explicitlyUnknown, ledgerPath);
	expect(restamped.reviewerPrecision?.lineage).toBe("unknown");
});

// ── MEDIUM (gauntlet round 3, delta-verify): "vendor-not-harness-tag-derivation" — the bucket must come
// from the HARNESS that ran, not the configured model's vendor lineage. Failing input: the omp harness
// configured with a non-Anthropic model string still stamps a non-"openai" reviewerLineage from
// modelLineage(), but the judge that actually ran was omp, not codex — bucketing it as "codex" would
// credit a foreign reviewer with a native judge's track record.
test("REGRESSION FIX (gauntlet round 3): an omp-harness verdict configured with an openai-vendor MODEL string still buckets as 'native', not 'codex'", async () => {
	const ledgerPath = await tmpLedgerFile([]);
	await fs.writeFile(
		ledgerPath,
		[
			JSON.stringify({ at: "2026-08-01", lineage: "native", concernClass: "test-fixture", survived: true, source: "fixture", note: "native finding" }),
			JSON.stringify({ at: "2026-08-01", lineage: "codex", concernClass: "test-fixture", survived: true, source: "fixture", note: "codex finding" }),
		]
			.map((l) => `${l}\n`)
			.join(""),
	);
	// This is exactly what scoreAgainstCriteria would stamp for OMP_SQUAD_VALIDATOR_HARNESS=omp +
	// OMP_SQUAD_VALIDATOR_MODEL=openai/gpt-5.2: activeReviewer() never hardcodes model to "codex" or
	// "grok" outside its own codex/grok branches, so `model` here is the literal configured string —
	// but modelLineage("openai/gpt-5.2") resolves reviewerLineage to "openai" regardless of harness.
	const ompHarnessOpenaiModel: ValidationRecord = {
		verdict: "pass",
		agreement: 1,
		confidence: 1,
		perCriterion: [],
		rationale: "",
		model: "openai/gpt-5.2",
		reviewerLineage: "openai",
		ranAt: 0,
	};
	const restamped = withFreshReviewerPrecision(ompHarnessOpenaiModel, ledgerPath);
	expect(restamped.reviewerPrecision?.lineage).toBe("native");
	expect(restamped.reviewerPrecision?.lineage).not.toBe("codex");
	expect(restamped.reviewerPrecision).toEqual({ lineage: "native", n: 1, survived: 1, survivedRate: 1, provisional: true });
});

test("a record whose model IS the literal 'codex' still buckets as codex regardless of reviewerLineage (harness wins)", async () => {
	const ledgerPath = await tmpLedgerFile([]);
	await fs.writeFile(
		ledgerPath,
		[
			JSON.stringify({ at: "2026-08-01", lineage: "codex", concernClass: "test-fixture", survived: true, source: "fixture", note: "codex finding" }),
			JSON.stringify({ at: "2026-08-01", lineage: "codex", concernClass: "test-fixture", survived: false, source: "fixture", note: "codex finding two" }),
		]
			.map((l) => `${l}\n`)
			.join(""),
	);
	const codexHarness: ValidationRecord = { verdict: "pass", agreement: 1, confidence: 1, perCriterion: [], rationale: "", model: "codex", reviewerLineage: "openai", ranAt: 0 };
	const restamped = withFreshReviewerPrecision(codexHarness, ledgerPath);
	expect(restamped.reviewerPrecision).toEqual({ lineage: "codex", n: 2, survived: 1, survivedRate: 0.5, provisional: true });
});

// ── HIGH: env-ledger-shadow closed (gauntlet round 1, codex) — there is no environment-variable path
// into the reviewer-precision reader anymore; only ValidatorGateOpts.reviewerLedgerPath (DI) reaches it.
test("env-ledger-shadow CLOSED: an OMP_SQUAD_REVIEWER_LEDGER_PATH env var has NO effect on the land path — only explicit DI does", async () => {
	const { repo, worktree } = await repoWithBranch("vgate-precision-noenv-");
	const shadowLedger = await tmpLedgerFile([ledgerRow(true), ledgerRow(true), ledgerRow(true)]); // would read as 100% precision if honored
	process.env.OMP_SQUAD_REVIEWER_LEDGER_PATH = shadowLedger;
	try {
		const { record } = await validatorGate({ criteria: CRITERIA, repo, worktree, judge: passJudge }); // NO reviewerLedgerPath passed
		// Reads whatever the REAL default ledger says (n:0 in a repo with no plans/.reviews ledger at this
		// tmp path, or the real repo ledger if this process happens to run from the actual glance checkout)
		// — the point is it must NOT be the shadow ledger's fabricated 100%/n=3.
		expect(record.reviewerPrecision).not.toEqual({ lineage: "native", n: 3, survived: 3, survivedRate: 1, provisional: true });
	} finally {
		delete process.env.OMP_SQUAD_REVIEWER_LEDGER_PATH;
	}
});
