/**
 * src/orphan-audit.ts — the pure parse/classify primitives behind scripts/orphan-audit.ts's CLI
 * sweep and land-pr.ts's post-merge assertion. `parseCherry`/`orphanedShas`/`classifyOrphanCause`
 * are pure (no I/O) — tested directly against literal `git cherry` output. `cherryCheck` is the one
 * git-I/O wrapper; exercised against a REAL git repo (mirrors ahead-of-base-real-git.test.ts's
 * convention), never mocked, so the wrapper's parsing of ACTUAL `git cherry` output is proven, not
 * just its parsing of a hand-written string.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cherryCheck, classifyOrphanCause, orphanedShas, parseCherry } from "../src/orphan-audit.ts";

// ── parseCherry (pure) ──────────────────────────────────────────────────────────────────────────

test("parseCherry: reads + and - entries from real git-cherry-shaped output", () => {
	const output = ["+ 1234567890abcdef1234567890abcdef12345678 feat: added a thing", "- abcdef1234567890abcdef1234567890abcdef12 equivalent patch already upstream", ""].join("\n");
	const entries = parseCherry(output);
	expect(entries).toEqual([
		{ status: "+", sha: "1234567890abcdef1234567890abcdef12345678" },
		{ status: "-", sha: "abcdef1234567890abcdef1234567890abcdef12" },
	]);
});

test("parseCherry: empty output ⇒ empty array (upstream and head identical)", () => {
	expect(parseCherry("")).toEqual([]);
	expect(parseCherry("\n\n")).toEqual([]);
});

test("parseCherry: skips blank/malformed lines rather than throwing", () => {
	const output = "+ deadbeefdeadbeefdeadbeefdeadbeefdeadbeef ok\n\ngarbage line with no marker\n+ not-a-sha short\n";
	const entries = parseCherry(output);
	expect(entries).toEqual([{ status: "+", sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }]);
});

test("parseCherry: accepts abbreviated (7-char) SHAs, not just full 40-char", () => {
	const entries = parseCherry("+ 1234567 short sha subject\n");
	expect(entries).toEqual([{ status: "+", sha: "1234567" }]);
});

// ── orphanedShas (pure) ─────────────────────────────────────────────────────────────────────────

test("orphanedShas: filters to + entries only, drops -", () => {
	const entries = parseCherry("+ 1111111111111111111111111111111111111111 a\n- 2222222222222222222222222222222222222222 b\n+ 3333333333333333333333333333333333333333 c\n");
	expect(orphanedShas(entries)).toEqual(["1111111111111111111111111111111111111111", "3333333333333333333333333333333333333333"]);
});

test("orphanedShas: empty entries ⇒ empty array", () => {
	expect(orphanedShas([])).toEqual([]);
});

// ── classifyOrphanCause (pure) ──────────────────────────────────────────────────────────────────

test("classifyOrphanCause: commit dated AFTER the PR's mergedAt ⇒ post-merge-stranding cause", () => {
	const cause = classifyOrphanCause({
		commitDateIso: "2026-07-07T12:09:49-05:00",
		prMergedAtIso: "2026-07-07T16:28:38Z", // earlier (UTC 16:28 vs the commit's UTC-equivalent 17:09)
		prBaseRefName: "main",
		defaultBranch: "main",
	});
	expect(cause).toContain("AFTER the PR merged");
	expect(cause).toContain("post-merge stranding");
});

test("classifyOrphanCause: commit dated BEFORE mergedAt, base == default ⇒ falls through to unknown", () => {
	const cause = classifyOrphanCause({
		commitDateIso: "2026-07-07T10:00:00Z",
		prMergedAtIso: "2026-07-07T16:28:38Z",
		prBaseRefName: "main",
		defaultBranch: "main",
	});
	expect(cause).toContain("unknown");
});

test("classifyOrphanCause: PR base != default branch ⇒ stacked-PR cause, even with no date info", () => {
	const cause = classifyOrphanCause({
		prBaseRefName: "effect-phase1c-agent-host-frames",
		defaultBranch: "main",
	});
	expect(cause).toContain("stacked PR");
	expect(cause).toContain("effect-phase1c-agent-host-frames");
	expect(cause).toContain("main");
});

test("classifyOrphanCause: date-after-merge is checked BEFORE the stacked-PR fallback (both conditions true ⇒ post-merge wins)", () => {
	const cause = classifyOrphanCause({
		commitDateIso: "2026-07-08T00:00:00Z",
		prMergedAtIso: "2026-07-07T00:00:00Z",
		prBaseRefName: "some-other-branch",
		defaultBranch: "main",
	});
	expect(cause).toContain("AFTER the PR merged");
});

test("classifyOrphanCause: no date info, no base info ⇒ honest unknown, never fabricated", () => {
	const cause = classifyOrphanCause({ defaultBranch: "main" });
	expect(cause).toContain("unknown");
	expect(cause).toContain("main");
});

test("classifyOrphanCause: unparsable date strings degrade to the fallback chain, never throw", () => {
	const cause = classifyOrphanCause({ commitDateIso: "not-a-date", prMergedAtIso: "also-not-a-date", prBaseRefName: "main", defaultBranch: "main" });
	expect(cause).toContain("unknown");
});

// ── cherryCheck (real git, no mocking) ──────────────────────────────────────────────────────────

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

async function commit(repo: string, file: string, content: string, message: string): Promise<string> {
	await fs.writeFile(path.join(repo, file), content);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", message);
	return (await git(repo, "rev-parse", "HEAD")).stdout;
}

async function gitRepo(prefix: string): Promise<string> {
	const repo = await tmpDir(prefix);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	return repo;
}

test("cherryCheck: a branch fully merged (real --no-ff merge) into upstream reports 0 orphans", async () => {
	const repo = await gitRepo("cc-clean-");
	await commit(repo, "base.txt", "base\n", "base");
	await git(repo, "checkout", "-qb", "feature");
	const c1 = await commit(repo, "feature.txt", "one\n", "feature commit 1");
	await commit(repo, "feature.txt", "one\ntwo\n", "feature commit 2");
	await git(repo, "checkout", "-q", "main");
	await git(repo, "merge", "-q", "--no-ff", "feature", "-m", "merge feature");

	// Real merge preserves the original commits — cherry against upstream=main, head=feature must be clean.
	const check = await cherryCheck("main", "feature", repo);
	expect(check.ok).toBe(true);
	expect(orphanedShas(check.entries)).toEqual([]);
	expect(check.entries.every((e) => e.status === "-")).toBe(true);
	void c1;
});

test("cherryCheck: commits that never merged anywhere report as + orphans, matching the real orphaned-branch shape", async () => {
	const repo = await gitRepo("cc-orphan-");
	await commit(repo, "base.txt", "base\n", "base");
	await git(repo, "checkout", "-qb", "feature");
	const c1 = await commit(repo, "feature.txt", "one\n", "feature commit 1");
	const c2 = await commit(repo, "feature.txt", "one\ntwo\n", "feature commit 2");
	// main never merges feature — reproduces the exact live shape found on worktree-research-omnigent
	// (2 commits pushed to a branch whose PR already reported MERGED, never reflected in main).

	const check = await cherryCheck("main", "feature", repo);
	expect(check.ok).toBe(true);
	const orphans = orphanedShas(check.entries);
	expect(orphans.sort()).toEqual([c1, c2].sort());
});

test("cherryCheck: a rebase-equivalent commit (same patch, different SHA) is correctly marked - (not orphaned)", async () => {
	const repo = await gitRepo("cc-rebase-eq-");
	await commit(repo, "base.txt", "base\n", "base");
	await git(repo, "checkout", "-qb", "feature");
	await commit(repo, "feature.txt", "content\n", "feature work");
	await git(repo, "checkout", "-q", "main");
	// Simulate a squash/rebase landing: apply the SAME patch directly onto main under a NEW commit.
	await commit(repo, "feature.txt", "content\n", "feature work (rebased onto main)");

	const check = await cherryCheck("main", "feature", repo);
	expect(check.ok).toBe(true);
	expect(orphanedShas(check.entries)).toEqual([]); // patch-id equivalence recognizes it, no orphan
});

test("cherryCheck: a bad/unreachable ref degrades to ok:false with an error, never throws", async () => {
	const repo = await gitRepo("cc-badref-");
	await commit(repo, "base.txt", "base\n", "base");

	const check = await cherryCheck("origin/does-not-exist", "main", repo);
	expect(check.ok).toBe(false);
	expect(check.entries).toEqual([]);
	expect(check.error).toBeDefined();
});

test("cherryCheck: not a git repo at all degrades gracefully, never throws", async () => {
	const notARepo = await tmpDir("cc-not-a-repo-");
	const check = await cherryCheck("main", "feature", notARepo);
	expect(check.ok).toBe(false);
	expect(check.error).toBeDefined();
});
