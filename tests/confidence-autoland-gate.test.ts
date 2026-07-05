/**
 * Epic 5 propose-only ENFORCEMENT (review SIGNIFICANT) — the confidence cap must gate the AUTONOMOUS
 * land, not just the UI fields. The leaf-03 cap sets effectiveMode="assist" + strips "land" from
 * availableActions, but those gate ONLY the webapp land-ready row + operator verify; the autonomous
 * land path (autoLandWorkflow and the orchestrator's landAgentWork, both via `land(id)` with auto:true)
 * never read them, so a sub-floor run was auto-MERGED anyway. These tests assert the MERGE ITSELF is
 * prevented on the auto path (not just that the fields changed) while an OPERATOR land (auto:false) in
 * assist mode STILL succeeds — the intended propose-only approval flow.
 *
 * Real git in tmp dirs + a genuine fresh proof (so proofGate passes and the confidence gate — placed
 * AFTER proofGate — is actually reached), mirroring tests/validator-land-gate.test.ts's convention. A
 * `SpyManager` subclass counts `landBranch` calls so "the merge was never attempted" is a direct
 * assertion, corroborated by main's working tree (the branch's file is absent until a real merge).
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runProof } from "../src/proof.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SubagentTracker } from "../src/subagents.ts";
import type { AgentDTO, PersistedAgent } from "../src/types.ts";
import type { LandResult } from "../src/land.ts";

const tmps: string[] = [];
const savedFloor = process.env.OMP_SQUAD_CONFIDENCE_FLOOR;
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
	if (savedFloor === undefined) delete process.env.OMP_SQUAD_CONFIDENCE_FLOOR;
	else process.env.OMP_SQUAD_CONFIDENCE_FLOOR = savedFloor;
});

async function tmpDir(prefix: string): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(d);
	return d;
}

async function git(cwd: string, ...a: string[]): Promise<void> {
	await Bun.spawn(["git", ...a], { cwd, stdout: "ignore", stderr: "ignore" }).exited;
}

/** A repo on `main` (one base commit), plus a worktree branch that adds `feature.txt` — a real,
 *  non-empty diff. `feature.txt` is absent on main until a genuine merge lands it, which is exactly
 *  what the "was the merge prevented?" assertion keys off. */
async function repoWithBranch(prefix: string): Promise<{ repo: string; worktree: string; branch: string }> {
	const repo = await tmpDir(prefix);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "base.txt"), `base ${prefix}\n`);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	const branch = "squad/conf-gate";
	const worktree = path.join(await tmpDir(`${prefix}wt-`), "wt");
	await git(repo, "worktree", "add", "-q", "-b", branch, worktree, "main");
	await fs.writeFile(path.join(worktree, "feature.txt"), `new ${prefix}\n`);
	await git(worktree, "add", "-A");
	await git(worktree, "commit", "-qm", "add feature");
	return { repo, worktree, branch };
}

class SpyManager extends SquadManager {
	landBranchCalls = 0;
	protected async landBranch(opts: Parameters<SquadManager["landBranch"]>[0]): Promise<LandResult> {
		this.landBranchCalls++;
		return super.landBranch(opts);
	}
}

function seedAgent(mgr: SquadManager, id: string, repo: string, worktree: string, branch: string, confidence: number): void {
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
		confidence, // the run-end score (below the floor) — the leaf-03 cap will read it in syncAuthority
	};
	const options: PersistedAgent = { id, name: id, repo, worktree, approvalMode: "yolo" };
	mgr.agents.set(id, { dto, agent: undefined as never, options, transcript: [], assistantBuf: "", streaming: false, subs: new SubagentTracker() } as never);
}

/** Whether the branch's file has actually reached main (proof the merge happened). */
async function mergedOntoMain(repo: string): Promise<boolean> {
	return fs.access(path.join(repo, "feature.txt")).then(() => true).catch(() => false);
}

test("an AUTONOMOUS land (auto:true) on a confidence-capped run is HELD, not merged — the merge is never attempted", async () => {
	process.env.OMP_SQUAD_CONFIDENCE_FLOOR = "0.4";
	const stateDir = await tmpDir("conf-gate-auto-state-");
	const { repo, worktree, branch } = await repoWithBranch("conf-gate-auto-");
	const mgr = new SpyManager({ stateDir, autoLand: true }); // sets the module proof root to stateDir
	seedAgent(mgr, "a1", repo, worktree, branch, 0.2); // 0.2 < 0.4 floor → capped to assist
	await runProof({ repo, worktree, command: "true" }); // genuine fresh proof so proofGate passes

	const result = await mgr.land("a1"); // auto defaults to true — the autonomous entry both callers use

	// The merge is HELD, not attempted: no landBranch call, nothing on main, staged for approval.
	expect(result.ok).toBe(false);
	expect(result.merged).toBe(false);
	expect(result.staged).toBe(true); // ⇒ the orchestrator HOLDS (never parks/fails)
	expect(mgr.landBranchCalls).toBe(0); // the merge primitive was never even reached
	expect(await mergedOntoMain(repo)).toBe(false); // ground truth: main is untouched
	// The cap is genuinely in effect (a real capped-to-assist run, not a coincidence). Note the fresh
	// proof means `availableActions` still lists "land" — that is CORRECT and load-bearing: it's how the
	// operator's one-tap propose-only approval stays clickable in assist mode. The autonomous/auto path
	// is what the new gate blocks, keyed on effectiveMode (assist ⇒ not autodrive), not on that list.
	const dto = mgr.agents.get("a1")!.dto;
	expect(dto.effectiveMode).toBe("assist"); // capped below autodrive by the sub-floor confidence
	expect(dto.landReady).toBe(true); // surfaces the propose-only "needs you" row for a one-tap Land
});

test("an OPERATOR land (auto:false) on the SAME capped run STILL merges — propose-only approval works", async () => {
	process.env.OMP_SQUAD_CONFIDENCE_FLOOR = "0.4";
	const stateDir = await tmpDir("conf-gate-op-state-");
	const { repo, worktree, branch } = await repoWithBranch("conf-gate-op-");
	const mgr = new SpyManager({ stateDir, autoLand: true });
	seedAgent(mgr, "a1", repo, worktree, branch, 0.2); // still capped to assist
	await runProof({ repo, worktree, command: "true" });

	// Sanity: the autonomous path holds it (same as the test above).
	const auto = await mgr.land("a1");
	expect(auto.staged).toBe(true);
	expect(await mergedOntoMain(repo)).toBe(false);

	// The operator explicitly clicks Land (auto:false) — the intended propose-only approval. It merges
	// despite the agent still being capped to assist: the gate is scoped to the AUTONOMOUS path only.
	const op = await mgr.land("a1", undefined, { auto: false });
	expect(op.ok).toBe(true);
	expect(op.merged).toBe(true);
	expect(mgr.landBranchCalls).toBe(1); // only the operator land reached the merge primitive
	expect(await mergedOntoMain(repo)).toBe(true); // ground truth: the branch's file is now on main
});

test("a high-confidence run (≥ floor) auto-lands normally — the gate is inert above the floor", async () => {
	process.env.OMP_SQUAD_CONFIDENCE_FLOOR = "0.4";
	const stateDir = await tmpDir("conf-gate-high-state-");
	const { repo, worktree, branch } = await repoWithBranch("conf-gate-high-");
	const mgr = new SpyManager({ stateDir, autoLand: true });
	seedAgent(mgr, "a1", repo, worktree, branch, 0.9); // 0.9 ≥ 0.4 floor → NOT capped
	await runProof({ repo, worktree, command: "true" });

	const result = await mgr.land("a1"); // autonomous
	expect(result.ok).toBe(true);
	expect(result.merged).toBe(true);
	expect(mgr.landBranchCalls).toBe(1);
	expect(await mergedOntoMain(repo)).toBe(true);
});
