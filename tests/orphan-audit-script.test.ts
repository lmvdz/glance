/**
 * scripts/orphan-audit.ts — the CLI orchestration around src/orphan-audit.ts's pure primitives:
 * enumerate merged PRs (`gh`, mocked here — no real GitHub call in a test env, mirrors
 * tests/land-pr.test.ts's convention), resolve the default branch, and sweep each still-live head
 * branch with real git in a real repo + bare origin (mirrors tests/land-pr.test.ts's baseline()).
 */

import { afterEach, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface GhPrRaw {
	number: number;
	headRefName: string;
	baseRefName: string;
	url: string;
	mergedAt?: string;
	mergeCommit?: { oid: string };
}

let repoViewResponse: { defaultBranchRef?: { name: string } } | undefined;
let mergedPrs: GhPrRaw[] = [];
let mergedPrsFails = false;
const ghJsonCalls: string[][] = [];

async function mockGhJson(args: string[]): Promise<unknown> {
	ghJsonCalls.push(args);
	if (args[0] === "repo" && args[1] === "view") return repoViewResponse;
	if (args[0] === "pr" && args[1] === "list") return mergedPrsFails ? undefined : mergedPrs;
	return undefined;
}

mock.module("../src/gh.ts", () => ({
	gh: async () => ({ code: 0, stdout: "", stderr: "" }),
	ghJson: mockGhJson,
	ghAvailable: async () => true,
}));

const { auditPr, listMergedPrs, resolveDefaultBranch, runAudit } = await import("../scripts/orphan-audit.ts");

afterEach(() => {
	repoViewResponse = undefined;
	mergedPrs = [];
	mergedPrsFails = false;
	ghJsonCalls.length = 0;
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

/** repo + bare origin, one base commit on main already pushed. */
async function baseline(prefix: string): Promise<{ repo: string; origin: string }> {
	const repo = await tmpDir(prefix);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await commit(repo, "base.txt", "base\n", "base");
	const origin = await bareRepo(`${prefix}origin-`);
	await git(repo, "remote", "add", "origin", origin);
	await git(repo, "push", "-q", "origin", "main");
	return { repo, origin };
}

// ── resolveDefaultBranch ────────────────────────────────────────────────────────────────────────

test("resolveDefaultBranch: an explicit override wins without calling gh at all", async () => {
	const { repo } = await baseline("rdb-override-");
	const branch = await resolveDefaultBranch(repo, "trunk");
	expect(branch).toBe("trunk");
	expect(ghJsonCalls.length).toBe(0);
});

test("resolveDefaultBranch: falls back to gh repo view's defaultBranchRef", async () => {
	const { repo } = await baseline("rdb-view-");
	repoViewResponse = { defaultBranchRef: { name: "develop" } };
	expect(await resolveDefaultBranch(repo)).toBe("develop");
});

test("resolveDefaultBranch: gh repo view returning nothing falls back to \"main\"", async () => {
	const { repo } = await baseline("rdb-fallback-");
	repoViewResponse = undefined;
	expect(await resolveDefaultBranch(repo)).toBe("main");
});

// ── listMergedPrs ───────────────────────────────────────────────────────────────────────────────

test("listMergedPrs: passes --limit through and returns gh's parsed list", async () => {
	const { repo } = await baseline("lmp-");
	mergedPrs = [{ number: 5, headRefName: "squad/x", baseRefName: "main", url: "https://github.com/acme/app/pull/5" }];

	const prs = await listMergedPrs(repo, 7);

	expect(prs).toEqual(mergedPrs);
	const listCall = ghJsonCalls.find((c) => c[0] === "pr" && c[1] === "list");
	expect(listCall).toBeDefined();
	expect(listCall).toContain("--limit");
	expect(listCall).toContain("7");
});

test("listMergedPrs: gh failure (rate limit / auth) returns undefined, not a throw", async () => {
	const { repo } = await baseline("lmp-fail-");
	mergedPrsFails = true;
	expect(await listMergedPrs(repo, 50)).toBeUndefined();
});

// ── auditPr ─────────────────────────────────────────────────────────────────────────────────────

test("auditPr: head branch deleted from origin ⇒ skipped, not treated as an orphan", async () => {
	const { repo } = await baseline("ap-deleted-");
	// No branch named squad/gone ever pushed to origin.
	const pr: GhPrRaw = { number: 1, headRefName: "squad/gone", baseRefName: "main", url: "u" };

	const result = await auditPr(repo, pr, "main");

	expect(result.skipped?.reason).toContain("no longer exists");
	expect(result.orphans).toEqual([]);
});

test("auditPr: a cleanly real-merged branch reports 0 orphans", async () => {
	const { repo } = await baseline("ap-clean-");
	await git(repo, "checkout", "-qb", "squad/clean");
	await commit(repo, "f.txt", "1\n", "work");
	await git(repo, "checkout", "-q", "main");
	await git(repo, "merge", "-q", "--no-ff", "squad/clean", "-m", "merge squad/clean");
	await git(repo, "push", "-q", "origin", "main", "squad/clean");

	const pr: GhPrRaw = { number: 2, headRefName: "squad/clean", baseRefName: "main", url: "u" };
	const result = await auditPr(repo, pr, "main");

	expect(result.skipped).toBeUndefined();
	expect(result.orphans).toEqual([]);
});

test("auditPr: an unmerged branch reports its commits as orphans, classified as post-merge stranding when dated after mergedAt", async () => {
	const { repo } = await baseline("ap-orphan-");
	await git(repo, "checkout", "-qb", "squad/orphan");
	const c1 = await commit(repo, "f.txt", "1\n", "work 1");
	const c2 = await commit(repo, "f.txt", "1\n2\n", "work 2");
	await git(repo, "checkout", "-q", "main");
	await git(repo, "push", "-q", "origin", "main", "squad/orphan"); // pushed, but main never merged it

	// mergedAt deliberately far in the past — every commit made "now" by the test sorts after it,
	// reproducing the live worktree-research-omnigent shape (commits pushed after the PR's merge time).
	const pr: GhPrRaw = { number: 3, headRefName: "squad/orphan", baseRefName: "main", url: "https://github.com/acme/app/pull/3", mergedAt: "2000-01-01T00:00:00Z" };
	const result = await auditPr(repo, pr, "main");

	expect(result.skipped).toBeUndefined();
	expect(result.orphans.map((o) => o.sha).sort()).toEqual([c1, c2].sort());
	for (const o of result.orphans) {
		expect(o.branch).toBe("squad/orphan");
		expect(o.prNumber).toBe(3);
		expect(o.prUrl).toBe("https://github.com/acme/app/pull/3");
		expect(o.cause).toContain("AFTER the PR merged");
	}
});

test("auditPr: stacked-PR cause when baseRefName != defaultBranch and no date info applies", async () => {
	const { repo } = await baseline("ap-stacked-");
	await git(repo, "checkout", "-qb", "squad/stacked");
	await commit(repo, "f.txt", "1\n", "stacked work");
	await git(repo, "checkout", "-q", "main");
	await git(repo, "push", "-q", "origin", "main", "squad/stacked");

	const pr: GhPrRaw = { number: 4, headRefName: "squad/stacked", baseRefName: "some-parent-branch", url: "u" };
	const result = await auditPr(repo, pr, "main");

	expect(result.orphans.length).toBe(1);
	expect(result.orphans[0].cause).toContain("stacked PR");
	expect(result.orphans[0].cause).toContain("some-parent-branch");
});

test("auditPr: git cherry itself failing (bad default-branch ref) is reported as skipped, not a crash", async () => {
	const { repo } = await baseline("ap-badref-");
	await git(repo, "checkout", "-qb", "squad/x");
	await commit(repo, "f.txt", "1\n", "work");
	await git(repo, "checkout", "-q", "main");
	await git(repo, "push", "-q", "origin", "squad/x");

	const pr: GhPrRaw = { number: 6, headRefName: "squad/x", baseRefName: "main", url: "u" };
	const result = await auditPr(repo, pr, "does-not-exist-on-origin");

	expect(result.skipped?.reason).toContain("git cherry failed");
	expect(result.orphans).toEqual([]);
});

// ── runAudit (full sweep) ───────────────────────────────────────────────────────────────────────

test("runAudit: sweeps a mixed set (clean, orphaned, deleted-branch) and reports each correctly", async () => {
	const { repo } = await baseline("ra-mixed-");

	await git(repo, "checkout", "-qb", "squad/clean");
	await commit(repo, "clean.txt", "1\n", "clean work");
	await git(repo, "checkout", "-q", "main");
	await git(repo, "merge", "-q", "--no-ff", "squad/clean", "-m", "merge squad/clean");

	await git(repo, "checkout", "-qb", "squad/orphan");
	const orphanSha = await commit(repo, "orphan.txt", "1\n", "orphan work");
	await git(repo, "checkout", "-q", "main");

	await git(repo, "push", "-q", "origin", "main", "squad/clean", "squad/orphan");

	mergedPrs = [
		{ number: 10, headRefName: "squad/clean", baseRefName: "main", url: "u10" },
		{ number: 11, headRefName: "squad/orphan", baseRefName: "main", url: "u11", mergedAt: "2000-01-01T00:00:00Z" },
		{ number: 12, headRefName: "squad/deleted-already", baseRefName: "main", url: "u12" },
	];
	repoViewResponse = { defaultBranchRef: { name: "main" } };

	const report = await runAudit({ repo, limit: 50 });

	expect(report).toBeDefined();
	expect(report?.defaultBranch).toBe("main");
	expect(report?.prsSwept).toBe(3);
	expect(report?.skipped).toEqual([{ branch: "squad/deleted-already", prNumber: 12, reason: expect.stringContaining("no longer exists") }]);
	expect(report?.orphans.length).toBe(1);
	expect(report?.orphans[0]).toMatchObject({ branch: "squad/orphan", prNumber: 11, sha: orphanSha });
});

test("runAudit: PR enumeration failure (gh rate-limited/unauthenticated) returns undefined, not a partial/misleading report", async () => {
	const { repo } = await baseline("ra-fail-");
	mergedPrsFails = true;

	const report = await runAudit({ repo });

	expect(report).toBeUndefined();
});

test("runAudit: 0 merged PRs to sweep ⇒ clean report, no orphans, no skips", async () => {
	const { repo } = await baseline("ra-empty-");
	mergedPrs = [];

	const report = await runAudit({ repo });

	expect(report?.prsSwept).toBe(0);
	expect(report?.orphans).toEqual([]);
	expect(report?.skipped).toEqual([]);
});
