/**
 * Regression guard for the batch-2 review finding: `aheadOfMain`/`agentHasUnlandedWork` used to pass
 * the agent's OWN worktree as `cwd` into `aheadOfBase`, and local-mode `rev-list HEAD..branch` run
 * FROM that worktree is always 0 (inside its own worktree, HEAD *is* the branch). `ahead-of-base.test.ts`
 * only proves the call sites route through `aheadOfBase` via a module-mock spy, and `land-mode.test.ts`
 * only exercises the arithmetic at the repo root — neither composes the real call site (worktree cwd)
 * with real git. This file does, deliberately WITHOUT mocking `../src/land-mode.ts` or `../src/gh.ts`.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const { SquadManager } = await import("../src/squad-manager.ts");
const { SubagentTracker } = await import("../src/subagents.ts");
import type { AgentDTO, PersistedAgent } from "../src/types.ts";

class TestManager extends SquadManager {
	callAheadOfMain(a: AgentDTO): Promise<number> {
		return this.aheadOfMain(a);
	}
	callAgentHasUnlandedWork(id: string): Promise<boolean> {
		return this.agentHasUnlandedWork(id);
	}
}

function seed(mgr: InstanceType<typeof TestManager>, id: string, over: Partial<PersistedAgent>): void {
	const repo = over.repo!;
	const worktree = over.worktree!;
	const branch = over.branch!;
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
	};
	const options: PersistedAgent = { id, name: id, repo, worktree, branch, approvalMode: "yolo", ...over };
	mgr.agents.set(id, { dto, agent: undefined as never, options, transcript: [], assistantBuf: "", streaming: false, subs: new SubagentTracker() });
}

const ENV_KEYS = ["OMP_SQUAD_LAND_MODE", "OMP_SQUAD_LAND_MODE_TTL_MS"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
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

async function commit(repo: string, file: string, content: string, message: string): Promise<void> {
	await fs.writeFile(path.join(repo, file), content);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", message);
}

test("real worktree, local mode: aheadOfMain and agentHasUnlandedWork see the unlanded commit, not 0", async () => {
	process.env.OMP_SQUAD_LAND_MODE = "local"; // bypass the gh probe entirely — no origin needed

	const repo = await tmpDir("aob-real-repo-");
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await commit(repo, "a.txt", "a\n", "base");

	await git(repo, "branch", "squad/work");
	const wtParent = await tmpDir("aob-real-wt-");
	const worktree = path.join(wtParent, "squad-work");
	await git(repo, "worktree", "add", "-q", worktree, "squad/work");
	// One unlanded commit made ON the branch, from inside its own worktree — this is exactly the
	// call-site shape that broke: `aheadOfMain`/`agentHasUnlandedWork` pass `cwd: worktree`, and
	// inside `worktree`, HEAD *is* `squad/work`, so a naive `HEAD..branch` there is always 0.
	await commit(worktree, "b.txt", "b\n", "one unlanded commit");

	const mgr = new TestManager({ stateDir: await tmpDir("aob-real-mgr-") });
	const a: AgentDTO = {
		id: "a1",
		name: "a1",
		status: "idle",
		kind: "omp-operator",
		repo,
		worktree,
		branch: "squad/work",
		approvalMode: "yolo",
		pending: [],
		lastActivity: 0,
		messageCount: 0,
	};

	expect(await mgr.callAheadOfMain(a)).toBeGreaterThan(0);

	seed(mgr, "a1", { repo, worktree, branch: "squad/work" });
	expect(await mgr.callAgentHasUnlandedWork("a1")).toBe(true);
});

test("real worktree, local mode: a fully-landed branch reads 0, not falsely ahead", async () => {
	process.env.OMP_SQUAD_LAND_MODE = "local";

	const repo = await tmpDir("aob-real-landed-repo-");
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await commit(repo, "a.txt", "a\n", "base");
	await git(repo, "branch", "squad/landed");

	const wtParent = await tmpDir("aob-real-landed-wt-");
	const worktree = path.join(wtParent, "squad-landed");
	await git(repo, "worktree", "add", "-q", worktree, "squad/landed");
	await commit(worktree, "b.txt", "b\n", "work");

	// Land it: merge into the repo's checked-out HEAD (main), matching local-mode's own base semantics.
	await git(repo, "merge", "-q", "--no-ff", "-m", "merge squad/landed", "squad/landed");

	const mgr = new TestManager({ stateDir: await tmpDir("aob-real-landed-mgr-") });
	const a: AgentDTO = {
		id: "a2",
		name: "a2",
		status: "idle",
		kind: "omp-operator",
		repo,
		worktree,
		branch: "squad/landed",
		approvalMode: "yolo",
		pending: [],
		lastActivity: 0,
		messageCount: 0,
	};

	expect(await mgr.callAheadOfMain(a)).toBe(0);
});
