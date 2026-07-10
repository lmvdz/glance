/**
 * `aheadOfBase` (concern 05) — the ONE origin-aware "ahead" primitive. `land-mode.test.ts` already
 * covers the arithmetic itself (local-mode regression guard + PR-mode origin-aware counting); this
 * file's job is narrower per the concern's own Verify wording: prove every consumer — SquadManager's
 * `aheadOfMain`, `agentHasUnlandedWork`, and the worktree reaper — routes through the SAME shared
 * function rather than re-implementing the arithmetic.
 *
 * Injected via `SquadManager.computeAheadOfBaseFor` (the TestManager subclass below overrides it),
 * NOT `mock.module("../src/land-mode.ts", ...)`: bun's `mock.module` overwrites that module's exports
 * PROCESS-WIDE the moment it's called (per bun-types' own doc comment: "If the module is already
 * loaded, exports are overwritten...") and stays swapped for as long as it's registered, regardless
 * of which OTHER test file's tests happen to run meanwhile in the same `bun test` invocation — a
 * silent false pass/fail with no error for any file that needs `aheadOfBase`'s REAL git behavior
 * (e.g. `ahead-of-base-unknown.test.ts`'s PATH-shimmed git-fault repro). This is the SAME hazard
 * `resolveLandModeFor`'s own doc comment already flags for `resolveLandMode` — `computeAheadOfBaseFor`
 * is its sibling seam.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { recordDoneProof } from "../src/done-proof.ts";

interface AheadCall {
	repo: string;
	branch: string;
	cwd?: string;
}
let calls: AheadCall[] = [];
let canned = 0;

const { SquadManager } = await import("../src/squad-manager.ts");
const { SubagentTracker } = await import("../src/subagents.ts");
import type { AgentDTO, PersistedAgent } from "../src/types.ts";

class TestManager extends SquadManager {
	protected computeAheadOfBaseFor(opts: AheadCall): Promise<number> {
		calls.push(opts);
		return Promise.resolve(canned);
	}
	callAheadOfMain(a: AgentDTO): Promise<number> {
		return this.aheadOfMain(a);
	}
	callAgentHasUnlandedWork(id: string): Promise<boolean> {
		return this.agentHasUnlandedWork(id);
	}
	callReap(): Promise<void> {
		return this.reapDeadWorktrees();
	}
}

function seed(mgr: InstanceType<typeof TestManager>, id: string, over: Partial<PersistedAgent> = {}): void {
	const repo = over.repo ?? "/r";
	const worktree = over.worktree ?? "/r";
	const branch = over.branch ?? `squad/${id}`;
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

const ENV_KEYS = ["OMP_SQUAD_WORKTREE_GRACE_MS", "OMP_SQUAD_WORKTREE_REAP"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	calls = [];
	canned = 0;
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

// ── aheadOfMain routes through the shared primitive ─────────────────────────────────────────────

test("aheadOfMain routes its git-ahead question through aheadOfBase", async () => {
	canned = 3;
	const mgr = new TestManager({ stateDir: await tmpDir("aob-mgr-") });
	const a: AgentDTO = { id: "a", name: "a", status: "idle", kind: "omp-operator", repo: "/r", worktree: "/w", branch: "squad/x", approvalMode: "yolo", pending: [], lastActivity: 0, messageCount: 0 };
	const n = await mgr.callAheadOfMain(a);
	expect(n).toBe(3);
	expect(calls).toEqual([{ repo: "/r", branch: "squad/x", cwd: "/w" }]);
});

test("aheadOfMain short-circuits to -1 without touching aheadOfBase when the agent has no branch", async () => {
	const mgr = new TestManager({ stateDir: await tmpDir("aob-mgr2-") });
	const a: AgentDTO = { id: "a", name: "a", status: "idle", kind: "omp-operator", repo: "/r", worktree: "/w", approvalMode: "yolo", pending: [], lastActivity: 0, messageCount: 0 };
	const n = await mgr.callAheadOfMain(a);
	expect(n).toBe(-1);
	expect(calls).toEqual([]);
});

// ── agentHasUnlandedWork routes through the shared primitive ───────────────────────────────────

test("agentHasUnlandedWork: a clean worktree routes its ahead-check through aheadOfBase", async () => {
	canned = 2;
	const mgr = new TestManager({ stateDir: await tmpDir("ahw-") });
	seed(mgr, "a1", { repo: "/r", worktree: "/nonexistent-clean-dir-xyz", branch: "squad/a1" });
	const has = await mgr.callAgentHasUnlandedWork("a1");
	expect(has).toBe(true); // canned=2 > 0
	expect(calls).toEqual([{ repo: "/r", branch: "squad/a1", cwd: "/nonexistent-clean-dir-xyz" }]);
});

test("agentHasUnlandedWork: 0 from aheadOfBase and a clean worktree ⇒ no unlanded work", async () => {
	canned = 0;
	const mgr = new TestManager({ stateDir: await tmpDir("ahw-clean-") });
	seed(mgr, "a1", { repo: "/r", worktree: "/nonexistent-clean-dir-xyz", branch: "squad/a1" });
	expect(await mgr.callAgentHasUnlandedWork("a1")).toBe(false);
});

test("agentHasUnlandedWork: a dirty worktree short-circuits true WITHOUT ever calling aheadOfBase", async () => {
	const repo = await tmpDir("ahw-dirty-");
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await fs.writeFile(path.join(repo, "a.txt"), "a\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	await fs.writeFile(path.join(repo, "uncommitted.txt"), "dirty\n"); // untracked ⇒ dirty per worktreeStatus

	const mgr = new TestManager({ stateDir: await tmpDir("ahw-dirty-mgr-") });
	seed(mgr, "a2", { repo, worktree: repo, branch: "squad/a2" });
	const has = await mgr.callAgentHasUnlandedWork("a2");
	expect(has).toBe(true);
	expect(calls).toEqual([]); // dirty check short-circuits BEFORE the arithmetic
});

test("agentHasUnlandedWork: a recorded DoneProof short-circuits false even though aheadOfBase reports ahead>0 (out-of-band squash-merge)", async () => {
	canned = 5; // arithmetic alone would say "still ahead" — the squash-merge case DoneProof exists for
	const repo = await tmpDir("ahw-proof-repo-");
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await fs.writeFile(path.join(repo, "a.txt"), "a\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	await git(repo, "branch", "squad/a1");
	const tip = (await git(repo, "rev-parse", "squad/a1")).stdout;

	const stateDir = await tmpDir("ahw-proof-state-");
	const mgr = new TestManager({ stateDir });
	seed(mgr, "a1", { repo, worktree: "/nonexistent-clean-dir-xyz", branch: "squad/a1" });
	recordDoneProof(stateDir, {
		branch: "squad/a1",
		repo: "name:r",
		mode: "pr",
		method: "squash",
		commit: tip, // matches the branch's CURRENT tip — proof covers it
		baseRef: "origin/main",
		verified: "green",
		detail: "merged out-of-band via GitHub UI (squash)",
		provenAt: Date.now(),
	});

	expect(await mgr.callAgentHasUnlandedWork("a1")).toBe(false);
	expect(calls).toEqual([]); // proof short-circuits BEFORE the arithmetic ever runs
});

test("agentHasUnlandedWork regression: a proof recorded at T1 does NOT cover a later T2 commit on the same branch — falls back to arithmetic", async () => {
	canned = 1; // T2's follow-up commit is genuinely unlanded
	const repo = await tmpDir("ahw-proof-t2-repo-");
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await fs.writeFile(path.join(repo, "a.txt"), "a\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	await git(repo, "checkout", "-qb", "squad/a1");
	await fs.writeFile(path.join(repo, "b.txt"), "b\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "T1");
	const t1 = (await git(repo, "rev-parse", "squad/a1")).stdout;

	const stateDir = await tmpDir("ahw-proof-t2-state-");
	recordDoneProof(stateDir, {
		branch: "squad/a1",
		repo: "name:r",
		mode: "pr",
		commit: t1,
		baseRef: "origin/main",
		verified: "green",
		detail: "landed at T1",
		provenAt: Date.now(),
	});

	// T2: a follow-up commit pushed to the SAME branch AFTER the proof was recorded — the proof only
	// ever speaks to T1, so it must not be treated as covering this too.
	await fs.writeFile(path.join(repo, "c.txt"), "c\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "T2");

	const mgr = new TestManager({ stateDir });
	seed(mgr, "a1", { repo, worktree: "/nonexistent-clean-dir-xyz", branch: "squad/a1" });

	expect(await mgr.callAgentHasUnlandedWork("a1")).toBe(true); // T1 proof doesn't cover T2 ⇒ falls back to arithmetic
	expect(calls).toEqual([{ repo, branch: "squad/a1", cwd: "/nonexistent-clean-dir-xyz" }]);
});

// ── reapDeadWorktrees routes through the shared primitive ──────────────────────────────────────

test("reapDeadWorktrees computes its per-worktree ahead-count via the shared aheadOfBase primitive", async () => {
	process.env.OMP_SQUAD_WORKTREE_GRACE_MS = "1"; // "0" reads falsy (Number("0") || default) so use the smallest truthy grace
	const repo = await tmpDir("reap-repo-");
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await fs.writeFile(path.join(repo, "a.txt"), "a\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	await git(repo, "branch", "squad/reap-x");
	const wtParent = await tmpDir("reap-wt-");
	const worktreeDir = path.join(wtParent, "squad-reap-x");
	await git(repo, "worktree", "add", "-q", worktreeDir, "squad/reap-x");

	canned = 0; // "merged" per the mocked primitive ⇒ eligible for reap
	// worktreeBase must be an ancestor of worktreeDir — the reaper never touches an out-of-band
	// worktree outside its managed base (OMPSQ-41), so the test's temp worktree parent IS the base.
	const mgr = new TestManager({ stateDir: await tmpDir("reap-mgr-"), worktreeBase: wtParent });
	// A dummy agent whose repo is this temp repo (so reapDeadWorktrees' repo set includes it) but whose
	// OWN worktree is neither the primary checkout nor the worktree under test — stays "unowned".
	seed(mgr, "keepalive", { repo, worktree: path.join(repo, "does-not-exist"), branch: "squad/other" });

	await mgr.callReap();

	expect(calls.some((c) => c.repo === repo && c.branch === "squad/reap-x" && c.cwd === repo)).toBe(true);
	// canned=0 ⇒ merged ⇒ actually reaped (admin entry gone).
	const list = await git(repo, "worktree", "list", "--porcelain");
	expect(list.stdout).not.toContain(worktreeDir);
});

test("reapDeadWorktrees does NOT reap when the shared primitive reports still-ahead work", async () => {
	process.env.OMP_SQUAD_WORKTREE_GRACE_MS = "1";
	const repo = await tmpDir("reap-repo2-");
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await fs.writeFile(path.join(repo, "a.txt"), "a\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	await git(repo, "branch", "squad/reap-y");
	const wtParent = await tmpDir("reap-wt2-");
	const worktreeDir = path.join(wtParent, "squad-reap-y");
	await git(repo, "worktree", "add", "-q", worktreeDir, "squad/reap-y");

	canned = 2; // still ahead ⇒ not merged; issue-open (default openIdentifiers via listPlaneIssues ⇒ null since Plane unconfigured ⇒ merged-only reaping) ⇒ kept
	const mgr = new TestManager({ stateDir: await tmpDir("reap-mgr2-"), worktreeBase: wtParent });
	seed(mgr, "keepalive2", { repo, worktree: path.join(repo, "does-not-exist"), branch: "squad/other2" });

	await mgr.callReap();

	const list = await git(repo, "worktree", "list", "--porcelain");
	expect(list.stdout).toContain(worktreeDir); // still there — not reaped
});
