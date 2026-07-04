/**
 * PR land path (concern 06) — src/land-pr.ts. Real git in tmp dirs + a real bare "origin" remote
 * (mirrors land-mode.test.ts's convention); only `gh` itself is module-mocked, since there is no
 * real GitHub repo to hit in a test environment. Where a mocked `gh pr merge` needs to actually make
 * the branch's work reachable from `origin/<default>` (for the reachability assertion to have
 * something real to check), the mock performs a real git push to the bare origin as a side effect —
 * simulating what GitHub's merge button really does, not a rubber-stamp.
 */

import { afterEach, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface GhPr {
	number: number;
	url: string;
	state: "OPEN" | "CLOSED" | "MERGED";
	headRefOid?: string;
	mergeCommit?: { oid: string };
}

// One shared, mutable mock config — reset per test rather than re-registering mock.module (which
// only needs to run once, before the module under test is dynamically imported).
let prList: GhPr[] = [];
let nextPrNumber = 100;
let mergeShouldSucceed = true;
let readyShouldSucceed = true;
let mergeSimulator: ((cwd: string) => Promise<void>) | undefined;
let prViewResponse: GhPr | undefined;
const createCalls: string[][] = [];
const pushCalls: string[][] = [];
const readyCalls: string[][] = [];
const mergeCalls: string[][] = [];
let mergeCalled = false;

async function mockGh(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
	if (args[0] === "pr" && args[1] === "list") {
		return { code: 0, stdout: JSON.stringify(prList), stderr: "" };
	}
	if (args[0] === "pr" && args[1] === "create") {
		createCalls.push(args);
		const num = nextPrNumber++;
		return { code: 0, stdout: `https://github.com/acme/app/pull/${num}\n`, stderr: "" };
	}
	if (args[0] === "pr" && args[1] === "ready") {
		readyCalls.push(args);
		if (!readyShouldSucceed) return { code: 1, stdout: "", stderr: "pr ready blocked (simulated)" };
		return { code: 0, stdout: "", stderr: "" };
	}
	if (args[0] === "pr" && args[1] === "merge") {
		mergeCalls.push(args);
		mergeCalled = true;
		if (!mergeShouldSucceed) return { code: 1, stdout: "", stderr: "merge blocked (simulated)" };
		if (mergeSimulator) await mergeSimulator(cwd);
		return { code: 0, stdout: "", stderr: "" };
	}
	if (args[0] === "pr" && args[1] === "view") {
		return { code: 0, stdout: JSON.stringify(prViewResponse ?? {}), stderr: "" };
	}
	return { code: 0, stdout: "", stderr: "" };
}

mock.module("../src/gh.ts", () => ({
	gh: mockGh,
	ghJson: async (args: string[], cwd: string) => {
		const r = await mockGh(args, cwd);
		return r.code === 0 ? JSON.parse(r.stdout) : undefined;
	},
	ghAvailable: async () => true,
}));

const { ensurePr, landAgentPr, getPendingPr, listPendingPrs, assertMerged, mergeMethod } = await import("../src/land-pr.ts");
const { getDoneProofByBranch } = await import("../src/done-proof.ts");

const ENV_KEYS = ["OMP_SQUAD_PR_DRAFT", "OMP_SQUAD_PR_MERGE_METHOD", "OMP_SQUAD_REGRESSION_GATE"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	prList = [];
	nextPrNumber = 100;
	mergeShouldSucceed = true;
	readyShouldSucceed = true;
	mergeSimulator = undefined;
	prViewResponse = undefined;
	createCalls.length = 0;
	pushCalls.length = 0;
	readyCalls.length = 0;
	mergeCalls.length = 0;
	mergeCalled = false;
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

async function gitRepo(prefix: string): Promise<string> {
	const repo = await tmpDir(prefix);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	return repo;
}

async function commit(repo: string, file: string, content: string, message: string): Promise<string> {
	await fs.writeFile(path.join(repo, file), content);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", message);
	return gitOut(repo, "rev-parse", "HEAD");
}

async function bareRepo(prefix: string): Promise<string> {
	const dir = await tmpDir(prefix);
	await git(dir, "init", "-q", "--bare");
	return dir;
}

/** repo + bare origin, one base commit already pushed. */
async function baseline(prefix: string): Promise<{ repo: string; origin: string }> {
	const repo = await gitRepo(prefix);
	await commit(repo, "base.txt", "base\n", "base");
	const origin = await bareRepo(`${prefix}origin-`);
	await git(repo, "remote", "add", "origin", origin);
	await git(repo, "push", "-q", "origin", "main");
	return { repo, origin };
}

/** A branch worktree of `repo`, forked from `main`, with one commit. */
async function branchWorktree(repo: string, branch: string, files: Record<string, string>): Promise<string> {
	const dir = path.join(await tmpDir(`${branch.replace(/\//g, "-")}-wt-`), "wt");
	await git(repo, "worktree", "add", "-q", "-b", branch, dir, "main");
	for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(dir, name), content);
	await git(dir, "add", "-A");
	await git(dir, "commit", "-qm", `${branch} changes`);
	return dir;
}

/** Simulate GitHub's merge button: a detached scratch worktree merges `branch` into a fresh
 *  checkout of origin/<default> and pushes the result straight to origin's default ref. */
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

// ── ensurePr ─────────────────────────────────────────────────────────────────────────────────────

test("ensurePr adopts an existing OPEN PR — no push, no create", async () => {
	const { repo } = await baseline("ep-open-");
	const stateDir = await tmpDir("ep-open-state-");
	prList = [{ number: 77, url: "https://github.com/acme/app/pull/77", state: "OPEN" }];

	const r = await ensurePr({ repo, branch: "squad/a1", defaultBranch: "main", title: "t", stateDir });

	expect(r.ok).toBe(true);
	expect(r.prNumber).toBe(77);
	expect(createCalls.length).toBe(0);
	expect(getPendingPr(stateDir, "squad/a1")?.prNumber).toBe(77);
});

test("ensurePr does not re-record an OPEN PR already in the ledger", async () => {
	const { repo } = await baseline("ep-open2-");
	const stateDir = await tmpDir("ep-open2-state-");
	prList = [{ number: 88, url: "https://github.com/acme/app/pull/88", state: "OPEN" }];

	await ensurePr({ repo, branch: "squad/a1", defaultBranch: "main", title: "t", stateDir, issueIdentifier: "PROJ-1" });
	// Second call with a DIFFERENT issueIdentifier must not clobber the first-recorded entry.
	await ensurePr({ repo, branch: "squad/a1", defaultBranch: "main", title: "t", stateDir, issueIdentifier: "PROJ-2" });

	expect(getPendingPr(stateDir, "squad/a1")?.issueIdentifier).toBe("PROJ-1");
});

test("ensurePr with no PR at all: pushes plainly and creates a draft PR", async () => {
	const { repo, origin } = await baseline("ep-new-");
	const stateDir = await tmpDir("ep-new-state-");
	await branchWorktree(repo, "squad/a1", { "feature.txt": "new\n" });
	prList = [];

	const r = await ensurePr({ repo, branch: "squad/a1", defaultBranch: "main", title: "land squad/a1", stateDir });

	expect(r.ok).toBe(true);
	expect(r.prNumber).toBeGreaterThanOrEqual(100);
	expect(createCalls.length).toBe(1);
	expect(createCalls[0]).toContain("--draft"); // OMP_SQUAD_PR_DRAFT default ON
	expect(await gitOut(origin, "rev-parse", "refs/heads/squad/a1")).toBe(await gitOut(repo, "rev-parse", "squad/a1"));
	expect(getPendingPr(stateDir, "squad/a1")?.state).toBe("open");
});

test("ensurePr with OMP_SQUAD_PR_DRAFT=0 creates a ready-for-review PR (no --draft)", async () => {
	process.env.OMP_SQUAD_PR_DRAFT = "0";
	const { repo } = await baseline("ep-nodraft-");
	const stateDir = await tmpDir("ep-nodraft-state-");
	await branchWorktree(repo, "squad/a1", { "feature.txt": "new\n" });
	prList = [];

	await ensurePr({ repo, branch: "squad/a1", defaultBranch: "main", title: "t", stateDir });
	expect(createCalls[0]).not.toContain("--draft");
});

test("ensurePr adopting an OPEN PR whose remote head is stale (a prior attempt's gate-FAILED tip) syncs the local tip to origin before returning ok", async () => {
	// Reproduces the exact critical flow: attempt 1 pushes tip-1 and opens a PR (gate FAILS); the agent
	// commits a fix as tip-2 WITHOUT pushing; attempt 2 must NOT adopt the PR as-is (which would let
	// `gh pr merge` merge remote tip-1 — the code that already failed the gate — un-gated).
	const { repo, origin } = await baseline("ep-stale-ff-");
	const wt = await branchWorktree(repo, "squad/a1", { "feature.txt": "tip1\n" });
	const tip1 = await gitOut(wt, "rev-parse", "HEAD");
	await git(repo, "push", "-q", "origin", "squad/a1"); // attempt 1's push
	await commit(wt, "feature.txt", "tip1\ntip2\n", "fix after gate failure"); // tip-2, never pushed
	const tip2 = await gitOut(wt, "rev-parse", "HEAD");
	const stateDir = await tmpDir("ep-stale-ff-state-");
	prList = [{ number: 77, url: "https://github.com/acme/app/pull/77", state: "OPEN", headRefOid: tip1 }];

	const r = await ensurePr({ repo, branch: "squad/a1", defaultBranch: "main", title: "t", stateDir });

	expect(r.ok).toBe(true);
	expect(r.prNumber).toBe(77);
	expect(createCalls.length).toBe(0); // still adopting #77, not creating a new PR
	// The load-bearing assertion: origin's ref must now match the LOCAL tip (what the gate downstream
	// actually checks), never left pinned at the stale, gate-failed tip1.
	expect(await gitOut(origin, "rev-parse", "refs/heads/squad/a1")).toBe(tip2);
	expect(await gitOut(origin, "rev-parse", "refs/heads/squad/a1")).not.toBe(tip1);
});

test("ensurePr adopting an OPEN PR whose remote head diverged (rewritten, not just advanced) force-with-lease syncs it", async () => {
	const { repo, origin } = await baseline("ep-stale-diverge-");
	const wt = await branchWorktree(repo, "squad/a1", { "feature.txt": "tip1\n" });
	const tip1 = await gitOut(wt, "rev-parse", "HEAD");
	await git(repo, "push", "-q", "origin", "squad/a1");
	// Rewrite (not merely advance) the tip — tip1 is NOT an ancestor of the new tip, the non-fast-forward case.
	await fs.writeFile(path.join(wt, "feature.txt"), "tip1-rewritten\n");
	await git(wt, "add", "-A");
	await git(wt, "commit", "-q", "--amend", "-m", "rewritten fix");
	const tip2 = await gitOut(wt, "rev-parse", "HEAD");
	const stateDir = await tmpDir("ep-stale-diverge-state-");
	prList = [{ number: 78, url: "https://github.com/acme/app/pull/78", state: "OPEN", headRefOid: tip1 }];

	const r = await ensurePr({ repo, branch: "squad/a1", defaultBranch: "main", title: "t", stateDir });

	expect(r.ok).toBe(true);
	expect(await gitOut(origin, "rev-parse", "refs/heads/squad/a1")).toBe(tip2);
});

test("ensurePr adopting an OPEN PR whose remote head already matches the local tip: no sync push needed", async () => {
	const { repo, origin } = await baseline("ep-nostale-");
	const wt = await branchWorktree(repo, "squad/a1", { "feature.txt": "tip1\n" });
	const tip1 = await gitOut(wt, "rev-parse", "HEAD");
	await git(repo, "push", "-q", "origin", "squad/a1");
	const stateDir = await tmpDir("ep-nostale-state-");
	prList = [{ number: 79, url: "https://github.com/acme/app/pull/79", state: "OPEN", headRefOid: tip1 }];

	const r = await ensurePr({ repo, branch: "squad/a1", defaultBranch: "main", title: "t", stateDir });

	expect(r.ok).toBe(true);
	expect(await gitOut(origin, "rev-parse", "refs/heads/squad/a1")).toBe(tip1);
});

test("ensurePr force-with-lease pushes over a prior CLOSED PR's stale branch ref", async () => {
	const { repo, origin } = await baseline("ep-reuse-");
	// Simulate a prior (now-closed) PR: push an OLD commit to origin under the deterministic branch name.
	const oldWt = await branchWorktree(repo, "squad/a1", { "old.txt": "old\n" });
	await git(repo, "push", "-q", "origin", "squad/a1");
	// Re-dispatch: the daemon reuses the SAME branch name off a fresh main, with unrelated new commits —
	// diverged from the old (now stale) remote ref, exactly the non-fast-forward case force-with-lease is for.
	await git(repo, "worktree", "remove", "--force", oldWt);
	await git(repo, "branch", "-D", "squad/a1");
	const wt = await branchWorktree(repo, "squad/a1", { "new.txt": "new\n" });
	const stateDir = await tmpDir("ep-reuse-state-");
	prList = [{ number: 50, url: "https://github.com/acme/app/pull/50", state: "CLOSED" }];

	const r = await ensurePr({ repo, branch: "squad/a1", defaultBranch: "main", title: "t", stateDir });

	expect(r.ok).toBe(true); // a plain push here would have failed non-fast-forward
	expect(createCalls.length).toBe(1);
	expect(await gitOut(origin, "rev-parse", "refs/heads/squad/a1")).toBe(await gitOut(wt, "rev-parse", "HEAD"));
});

// ── landAgentPr — green path ─────────────────────────────────────────────────────────────────────

test("landAgentPr: scratch gate green ⇒ merges, asserts reachability, records DoneProof + PendingPr", async () => {
	const { repo, origin } = await baseline("lp-green-");
	const wt = await branchWorktree(repo, "squad/a1", { "feature.txt": "new\n" });
	const stateDir = await tmpDir("lp-green-state-");
	prList = [];
	mergeSimulator = githubMerge("squad/a1");
	const mainHead0 = await gitOut(repo, "rev-parse", "main");

	const res = await landAgentPr(
		{ repo, worktree: wt, branch: "squad/a1", message: "land squad/a1", commitWip: false, defaultBranch: "main", issueIdentifier: "PROJ-9" },
		stateDir,
	);

	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
	expect(res.mode).toBe("pr");
	expect(res.prState).toBe("merged");
	expect(res.prNumber).toBeDefined();

	const proof = getDoneProofByBranch(stateDir, "squad/a1");
	expect(proof?.mode).toBe("pr");
	expect(proof?.method).toBe("merge");
	expect(proof?.verified).toBe("green");
	expect(proof?.issueIdentifier).toBe("PROJ-9");

	const pending = getPendingPr(stateDir, "squad/a1");
	expect(pending?.state).toBe("merged");
	expect(pending?.proofAt).toBeDefined();

	// The PRIMARY checkout was never merged into — only the disposable scratch worktree was, and
	// origin (simulating GitHub) is what actually advanced.
	expect(await gitOut(repo, "rev-parse", "main")).toBe(mainHead0);
	expect(await gitOut(origin, "rev-parse", "main")).not.toBe(mainHead0);
});

test("landAgentPr: `gh pr ready` and `gh pr merge` are addressed with --repo <slug> (host-aliased-origin safe)", async () => {
	const { repo } = await baseline("lp-repo-slug-");
	const wt = await branchWorktree(repo, "squad/a1", { "feature.txt": "new\n" });
	const stateDir = await tmpDir("lp-repo-slug-state-");
	prList = [];
	mergeSimulator = githubMerge("squad/a1");

	const res = await landAgentPr({ repo, worktree: wt, branch: "squad/a1", message: "m", commitWip: false, defaultBranch: "main" }, stateDir);

	expect(res.ok).toBe(true);
	expect(readyCalls.length).toBe(1);
	expect(readyCalls[0]).toContain("--repo");
	expect(mergeCalls.length).toBe(1);
	expect(mergeCalls[0]).toContain("--repo");
});

test("landAgentPr: `gh pr ready` failing on a draft PR is refused (retryable) before attempting `gh pr merge`", async () => {
	const { repo } = await baseline("lp-ready-fail-");
	const wt = await branchWorktree(repo, "squad/a1", { "feature.txt": "new\n" });
	const stateDir = await tmpDir("lp-ready-fail-state-");
	prList = []; // draftEnabled() defaults ON ⇒ the created PR is a draft
	readyShouldSucceed = false;

	const res = await landAgentPr({ repo, worktree: wt, branch: "squad/a1", message: "m", commitWip: false, defaultBranch: "main" }, stateDir);

	expect(res.ok).toBe(false);
	expect(res.retryable).toBe(true);
	expect(res.detail).toContain("gh pr ready failed");
	expect(mergeCalled).toBe(false); // never reached gh pr merge
});

test("landAgentPr: default merge method preserves ancestry (assertMerged ok via isAncestor)", async () => {
	const { repo } = await baseline("lp-method-");
	const wt = await branchWorktree(repo, "squad/a1", { "feature.txt": "new\n" });
	const stateDir = await tmpDir("lp-method-state-");
	prList = [];
	mergeSimulator = githubMerge("squad/a1");

	expect(mergeMethod()).toBe("merge");
	const res = await landAgentPr({ repo, worktree: wt, branch: "squad/a1", message: "m", commitWip: false, defaultBranch: "main" }, stateDir);
	expect(res.ok).toBe(true);
});

// ── landAgentPr — scratch gate red (acceptance) ──────────────────────────────────────────────────

test("landAgentPr: acceptance gate fails on scratch merge ⇒ refused, PR stays open, no DoneProof", async () => {
	const { repo } = await baseline("lp-accept-fail-");
	const wt = await branchWorktree(repo, "squad/a1", { "feature.txt": "new\n" });
	const stateDir = await tmpDir("lp-accept-fail-state-");
	prList = [];

	const res = await landAgentPr(
		{ repo, worktree: wt, branch: "squad/a1", message: "m", commitWip: false, defaultBranch: "main", verify: "false" },
		stateDir,
	);

	expect(res.ok).toBe(false);
	expect(res.merged).toBe(false);
	expect(res.detail).toContain("acceptance failed on scratch merge");
	expect(mergeCalled).toBe(false); // never reached gh pr merge
	expect(getDoneProofByBranch(stateDir, "squad/a1")).toBeUndefined();
	expect(getPendingPr(stateDir, "squad/a1")?.state).toBe("open");
});

// ── landAgentPr — scratch gate red (regression) ──────────────────────────────────────────────────

/** Deterministic gate.sh, mirrors tests/land-regression-gate.test.ts's fixture exactly. */
async function gateRepoBaseline(prefix: string): Promise<{ repo: string; origin: string }> {
	const repo = await gitRepo(prefix);
	await fs.writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { check: "true", test: "sh gate.sh" } }));
	await fs.writeFile(path.join(repo, "bun.lock"), "");
	await fs.writeFile(
		path.join(repo, "gate.sh"),
		["#!/bin/sh", "out=''; code=0", "[ -f NEW_RED ]  && { out=\"${out}(fail) new.test.ts > introduced\\n\"; code=1; }", 'printf "$out"', 'exit "$code"'].join("\n"),
	);
	await commit(repo, "base.txt", "base\n", "base");
	const origin = await bareRepo(`${prefix}origin-`);
	await git(repo, "remote", "add", "origin", origin);
	await git(repo, "push", "-q", "origin", "main");
	return { repo, origin };
}

test("landAgentPr: regression gate blocks a NEW_RED branch on the scratch merge — refused, no DoneProof", async () => {
	delete process.env.OMP_SQUAD_REGRESSION_GATE; // default ON (concern 03)
	const { repo } = await gateRepoBaseline("lp-regress-");
	const wt = await branchWorktree(repo, "squad/a1", { NEW_RED: "broken\n" });
	const stateDir = await tmpDir("lp-regress-state-");
	prList = [];

	// verify:"true" (acceptance) passes trivially — the SEPARATE, auto-detected full-suite regression
	// gate (gate.sh, via detectVerify) is what must catch NEW_RED.
	const res = await landAgentPr(
		{ repo, worktree: wt, branch: "squad/a1", message: "m", commitWip: false, defaultBranch: "main", verify: "true" },
		stateDir,
	);

	expect(res.ok).toBe(false);
	expect(res.detail).toContain("regression gate");
	expect(res.detail).toContain("new.test.ts > introduced");
	expect(mergeCalled).toBe(false);
	expect(getDoneProofByBranch(stateDir, "squad/a1")).toBeUndefined();
});

test("landAgentPr: regression gate allows a clean branch through to merge", async () => {
	delete process.env.OMP_SQUAD_REGRESSION_GATE;
	const { repo } = await gateRepoBaseline("lp-regress-ok-");
	const wt = await branchWorktree(repo, "squad/a1", { "feature.txt": "clean\n" });
	const stateDir = await tmpDir("lp-regress-ok-state-");
	prList = [];
	mergeSimulator = githubMerge("squad/a1");

	const res = await landAgentPr(
		{ repo, worktree: wt, branch: "squad/a1", message: "m", commitWip: false, defaultBranch: "main", verify: "true" },
		stateDir,
	);

	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
	expect(getDoneProofByBranch(stateDir, "squad/a1")).toBeDefined();
});

// ── landAgentPr — conflict handling ──────────────────────────────────────────────────────────────

test("landAgentPr: a genuine same-file conflict is refused (retryable:false) with the exact file list", async () => {
	const { repo } = await baseline("lp-conflict-");
	const wt = await branchWorktree(repo, "squad/a1", { "f.txt": "branch-edit\n" });
	// Advance origin's main independently, touching the SAME file — guaranteed conflict in either
	// merge direction (verified empirically: git's 3-way merge conflict outcome is direction-independent
	// for the same pair of commits/merge-base, so the agent-worktree clean-automerge retry cannot
	// resolve a genuine overlapping-edit conflict either — it only re-confirms the same conflict once,
	// then this refuses, exactly the fallback the design specifies).
	await commit(repo, "f.txt", "main-edit\n", "main advances");
	await git(repo, "push", "-q", "origin", "main");
	const stateDir = await tmpDir("lp-conflict-state-");
	prList = [];

	const res = await landAgentPr({ repo, worktree: wt, branch: "squad/a1", message: "m", commitWip: false, defaultBranch: "main" }, stateDir);

	expect(res.ok).toBe(false);
	expect(res.retryable).toBe(false);
	expect(res.detail).toContain("conflict in");
	expect(res.detail).toContain("f.txt");
	expect(mergeCalled).toBe(false);
	// The agent's own worktree was left clean (the failed retry-merge was aborted), not mid-conflict.
	expect(await gitOut(wt, "status", "--porcelain")).toBe("");
});

test("landAgentPr: non-conflicting divergence (disjoint files) lands straight through without needing a retry", async () => {
	const { repo } = await baseline("lp-trailing-");
	const wt = await branchWorktree(repo, "squad/a1", { "feature.txt": "new\n" });
	// Origin's main advances with a DISJOINT file — no overlap, so the scratch merge succeeds cleanly
	// on the first attempt (the common "trailing main" case in practice never conflicts to begin with).
	await commit(repo, "unrelated.txt", "main-only\n", "main advances (disjoint)");
	await git(repo, "push", "-q", "origin", "main");
	const stateDir = await tmpDir("lp-trailing-state-");
	prList = [];
	mergeSimulator = githubMerge("squad/a1");

	const res = await landAgentPr({ repo, worktree: wt, branch: "squad/a1", message: "m", commitWip: false, defaultBranch: "main" }, stateDir);

	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
});

// ── per-method reachability assertion ────────────────────────────────────────────────────────────

test("assertMerged: method=merge checks ancestry via isAncestor", async () => {
	const { repo } = await baseline("am-merge-");
	const tip = await commit(repo, "x.txt", "x\n", "tip");
	await git(repo, "push", "-q", "origin", "main");

	const ok = await assertMerged({ repo, defaultBranch: "main", branchTipSha: tip, prNumber: 1 }, "merge");
	expect(ok.ok).toBe(true);
	expect(ok.commit).toBe(tip);
});

test("assertMerged: method=merge fails when the tip never reached origin", async () => {
	const { repo } = await baseline("am-merge-fail-");
	const wt = await branchWorktree(repo, "squad/a1", { "feature.txt": "x\n" });
	const tip = await gitOut(wt, "rev-parse", "HEAD"); // never pushed/merged to origin

	const res = await assertMerged({ repo, defaultBranch: "main", branchTipSha: tip, prNumber: 1 }, "merge");
	expect(res.ok).toBe(false);
	expect(res.detail).toContain("not an ancestor");
});

test("assertMerged: method=squash requires gh pr view state MERGED + matching headRefOid + reachable mergeCommit", async () => {
	const { repo } = await baseline("am-squash-ok-");
	const mergeCommit = await commit(repo, "x.txt", "x\n", "squash-merge-commit");
	await git(repo, "push", "-q", "origin", "main");
	prViewResponse = { number: 1, url: "u", state: "MERGED", headRefOid: "branchtip123", mergeCommit: { oid: mergeCommit } };

	const res = await assertMerged({ repo, defaultBranch: "main", branchTipSha: "branchtip123", prNumber: 1 }, "squash");
	expect(res.ok).toBe(true);
	expect(res.mergeCommit).toBe(mergeCommit);
});

test("assertMerged: method=squash refused when gh reports a state other than MERGED", async () => {
	const { repo } = await baseline("am-squash-notmerged-");
	prViewResponse = { number: 1, url: "u", state: "OPEN", headRefOid: "x" };

	const res = await assertMerged({ repo, defaultBranch: "main", branchTipSha: "x", prNumber: 1 }, "squash");
	expect(res.ok).toBe(false);
	expect(res.detail).toContain("expected MERGED");
});

test("assertMerged: method=rebase refused when headRefOid doesn't match the branch tip we actually landed", async () => {
	const { repo } = await baseline("am-rebase-headmismatch-");
	const mergeCommit = await commit(repo, "x.txt", "x\n", "c");
	await git(repo, "push", "-q", "origin", "main");
	prViewResponse = { number: 1, url: "u", state: "MERGED", headRefOid: "some-other-force-pushed-sha", mergeCommit: { oid: mergeCommit } };

	const res = await assertMerged({ repo, defaultBranch: "main", branchTipSha: "branchtip123", prNumber: 1 }, "rebase");
	expect(res.ok).toBe(false);
	expect(res.detail).toContain("force-push");
});

test("assertMerged: method=rebase refused when the reported merge commit isn't reachable from origin/<default>", async () => {
	const { repo } = await baseline("am-rebase-unreachable-");
	prViewResponse = { number: 1, url: "u", state: "MERGED", headRefOid: "branchtip123", mergeCommit: { oid: "0123456789abcdef0123456789abcdef01234567" } };

	const res = await assertMerged({ repo, defaultBranch: "main", branchTipSha: "branchtip123", prNumber: 1 }, "rebase");
	expect(res.ok).toBe(false);
	expect(res.detail).toContain("not reachable");
});

// ── PendingPr ledger — corrupt / missing file, matches done-proof.ts's contract ─────────────────

test("listPendingPrs / getPendingPr return the empty shape on a missing ledger file, never throw", async () => {
	const stateDir = await tmpDir("pp-missing-");
	expect(listPendingPrs(stateDir)).toEqual([]);
	expect(getPendingPr(stateDir, "squad/a1")).toBeUndefined();
});

test("listPendingPrs returns the empty shape on a corrupt ledger file, never throws", async () => {
	const stateDir = await tmpDir("pp-corrupt-");
	await fs.writeFile(path.join(stateDir, "pending-prs.json"), "{ not json");
	expect(listPendingPrs(stateDir)).toEqual([]);
});
