/**
 * Land-seam enforcement (concern 06, §2): `landBranch` is the universal mode-dispatching point, and
 * `landFeature` — which used to call `landAgent` directly, bypassing it — is rerouted through the
 * same seam. This asserts the invariant the design calls out explicitly: in PR mode, NEITHER
 * `land()` NOR `landFeature()` ever runs a real `git merge` against the PRIMARY checkout. A Bun.spawn
 * spy records every real git invocation's argv + cwd (distinguishing the primary checkout from the
 * disposable scratch worktree `landAgentPr` merges into); a control test in LOCAL mode proves the spy
 * itself actually detects a `git merge` against the primary checkout when one really happens, so the
 * PR-mode assertion isn't vacuously true.
 *
 * Real git in tmp dirs + a real bare "origin" remote (mirrors land-mode.test.ts's convention); only
 * `gh` is module-mocked.
 */

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SubagentTracker } from "../src/subagents.ts";
import type { AgentDTO, PersistedAgent, PersistedFeature } from "../src/types.ts";

let prList: { number: number; url: string; state: string }[] = [];
let nextPrNumber = 700;
let mergeSimulator: ((cwd: string) => Promise<void>) | undefined;

async function mockGh(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
	if (args[0] === "pr" && args[1] === "list") return { code: 0, stdout: JSON.stringify(prList), stderr: "" };
	if (args[0] === "pr" && args[1] === "create") {
		const num = nextPrNumber++;
		return { code: 0, stdout: `https://github.com/acme/app/pull/${num}\n`, stderr: "" };
	}
	if (args[0] === "pr" && args[1] === "ready") return { code: 0, stdout: "", stderr: "" };
	if (args[0] === "pr" && args[1] === "merge") {
		if (mergeSimulator) await mergeSimulator(cwd);
		return { code: 0, stdout: "", stderr: "" };
	}
	return { code: 0, stdout: "", stderr: "" };
}

mock.module("../src/gh.ts", () => ({
	gh: mockGh,
	ghJson: async (args: string[], cwd: string) => {
		if (args[0] === "repo" && args[1] === "view") return { defaultBranchRef: { name: "main" } };
		const r = await mockGh(args, cwd);
		return r.code === 0 ? JSON.parse(r.stdout) : undefined;
	},
	ghAvailable: async () => true,
}));

const { SquadManager } = await import("../src/squad-manager.ts");

/**
 * Force PR/local mode via the `resolveLandModeFor` seam rather than `OMP_SQUAD_LAND_MODE` +
 * land-mode.ts's real probe: a DIFFERENT test file (ahead-of-base.test.ts) module-mocks
 * `land-mode.ts` wholesale for its own, unrelated reason, and `bun test`'s process-wide
 * `mock.module` semantics mean that mock permanently rebinds squad-manager.ts's `resolveLandMode`
 * import for the rest of the suite the moment squad-manager.ts is first evaluated by ANY file —
 * regardless of load order relative to this one. The seam sidesteps that entirely.
 */
class TestManager extends SquadManager {
	forcedMode: "pr" | "local" = "pr";
	protected resolveLandModeFor(_repo: string): Promise<{ mode: "pr" | "local"; defaultBranch?: string; reason: string }> {
		return Promise.resolve(
			this.forcedMode === "pr"
				? { mode: "pr", defaultBranch: "main", reason: "forced for seam test" }
				: { mode: "local", reason: "forced local for control test" },
		);
	}
}

afterEach(() => {
	prList = [];
	nextPrNumber = 700;
	mergeSimulator = undefined;
});

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function tmpDir(prefix: string): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(d);
	return d;
}

async function git(cwd: string, ...a: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const p = Bun.spawn(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function gitOut(cwd: string, ...a: string[]): Promise<string> {
	return (await git(cwd, ...a)).stdout;
}

/** A repo checked out on `main`, converged with a real bare origin (all 5 land-mode probes pass). */
async function convergedRepo(prefix: string): Promise<{ repo: string; origin: string }> {
	const repo = await tmpDir(prefix);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "base.txt"), "base\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	const origin = await tmpDir(`${prefix}origin-`);
	await git(origin, "init", "-q", "--bare");
	await git(repo, "remote", "add", "origin", origin);
	await git(repo, "push", "-q", "origin", "main");
	return { repo, origin };
}

async function branchWorktree(repo: string, branch: string, files: Record<string, string>): Promise<string> {
	const dir = path.join(await tmpDir(`${branch.replace(/\//g, "-")}-wt-`), "wt");
	await git(repo, "worktree", "add", "-q", "-b", branch, dir, "main");
	for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(dir, name), content);
	await git(dir, "add", "-A");
	await git(dir, "commit", "-qm", `${branch} changes`);
	return dir;
}

function githubMerge(branch: string, defaultBranch = "main"): (cwd: string) => Promise<void> {
	return async (cwd: string) => {
		await git(cwd, "fetch", "-q", "origin", defaultBranch);
		const tmp = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "gh-merge-")), "m");
		await git(cwd, "worktree", "add", "-q", "--detach", tmp, `origin/${defaultBranch}`);
		await git(tmp, "merge", "-q", "--no-ff", branch, "-m", "merge via gh (simulated)");
		await git(tmp, "push", "-q", "origin", `HEAD:${defaultBranch}`);
		await git(cwd, "worktree", "remove", "--force", tmp);
	};
}

// ── Bun.spawn spy — records every real subprocess invocation ────────────────────────────────────

interface SpawnCall {
	argv: string[];
	cwd?: string;
}
let spawnLog: SpawnCall[] = [];
// biome-ignore lint: test-only global patch, restored in afterEach
const realSpawn: typeof Bun.spawn = Bun.spawn.bind(Bun);

beforeEach(() => {
	spawnLog = [];
	// @ts-expect-error — test-only monkeypatch of a global to observe every real subprocess call.
	Bun.spawn = (argv: unknown, opts?: { cwd?: string }) => {
		if (Array.isArray(argv)) spawnLog.push({ argv: argv.map(String), cwd: opts?.cwd });
		// biome-ignore lint: forwarding to the real implementation
		return realSpawn(argv as never, opts as never);
	};
});
afterEach(() => {
	Bun.spawn = realSpawn;
});

/** Every recorded real `git merge` (excluding `merge-base`) invocation whose cwd resolves to `dir`. */
function mergeCallsAgainst(dir: string): SpawnCall[] {
	const resolved = path.resolve(dir);
	return spawnLog.filter((c) => c.argv[0] === "git" && c.argv.includes("merge") && !c.argv.includes("merge-base") && c.cwd !== undefined && path.resolve(c.cwd) === resolved);
}

function seedAgent(mgr: InstanceType<typeof SquadManager>, id: string, repo: string, worktree: string, branch: string, featureId?: string): void {
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

// ── land() ───────────────────────────────────────────────────────────────────────────────────────

test("land(): PR mode never runs git merge against the primary checkout", async () => {
	const stateDir = await tmpDir("seam-land-state-");
	const { repo, origin } = await convergedRepo("seam-land-");
	const wt = await branchWorktree(repo, "squad/a1", { "feature.txt": "new\n" });
	const mgr = new TestManager({ stateDir });
	seedAgent(mgr, "a1", repo, wt, "squad/a1");
	mergeSimulator = githubMerge("squad/a1");
	const mainHead0 = await gitOut(repo, "rev-parse", "main");

	const result = await mgr.land("a1", undefined, { force: true, reason: "seam test" });

	expect(result.mode).toBe("pr");
	expect(result.merged).toBe(true);
	expect(mergeCallsAgainst(repo)).toEqual([]); // zero real `git merge` against the PRIMARY checkout
	expect(await gitOut(repo, "rev-parse", "main")).toBe(mainHead0); // primary never advanced
	expect(await gitOut(origin, "rev-parse", "main")).not.toBe(mainHead0); // origin (GitHub) did
	expect(mgr.agents.get("a1")?.dto.prUrl).toBeDefined();
	expect(mgr.agents.get("a1")?.dto.prState).toBe("merged");
});

test("land(): CONTROL — local mode DOES run git merge against the primary checkout (proves the spy detects it)", async () => {
	const stateDir = await tmpDir("seam-land-local-state-");
	const { repo } = await convergedRepo("seam-land-local-");
	const wt = await branchWorktree(repo, "squad/a1", { "feature.txt": "new\n" });
	const mgr = new TestManager({ stateDir });
	mgr.forcedMode = "local";
	seedAgent(mgr, "a1", repo, wt, "squad/a1");

	const result = await mgr.land("a1", undefined, { force: true, reason: "seam control" });

	expect(result.mode).toBeUndefined(); // local mode sets no `mode` field
	expect(result.merged).toBe(true);
	expect(mergeCallsAgainst(repo).length).toBeGreaterThan(0);
});

// ── landFeature() ────────────────────────────────────────────────────────────────────────────────

test("landFeature(): PR mode never runs git merge against the primary checkout", async () => {
	const stateDir = await tmpDir("seam-feat-state-");
	const { repo, origin } = await convergedRepo("seam-feat-");
	const wt = await branchWorktree(repo, "squad/m1", { "feature.txt": "new\n" });
	const mgr = new TestManager({ stateDir });
	seedAgent(mgr, "m1", repo, wt, "squad/m1", "f1");
	const pf: PersistedFeature = { id: "f1", title: "Feature One", repo, createdAt: 0, updatedAt: 0 };
	(mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore.set("f1", pf);
	mergeSimulator = githubMerge("squad/m1");
	const mainHead0 = await gitOut(repo, "rev-parse", "main");

	const result = await mgr.landFeature("f1", true, undefined, "seam test");

	expect(result.ok).toBe(true);
	expect(result.results[0]?.ok).toBe(true);
	expect(mergeCallsAgainst(repo)).toEqual([]);
	expect(await gitOut(repo, "rev-parse", "main")).toBe(mainHead0);
	expect(await gitOut(origin, "rev-parse", "main")).not.toBe(mainHead0);
	expect(mgr.agents.get("m1")?.dto.prState).toBe("merged");
});
