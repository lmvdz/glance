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
import { SubagentTracker } from "../src/subagents.ts";
import type { AgentDTO, PersistedAgent, PersistedFeature } from "../src/types.ts";
import { validatorGate, type Judge } from "../src/validator.ts";

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
	const { readValidatorOverrides } = await import("../src/land-ledger.ts");
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
