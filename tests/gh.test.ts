/**
 * `gh.ts` — regression guard for the batch-2 review finding: `Bun.spawn` throws SYNCHRONOUSLY when
 * the `gh` binary itself is missing from `$PATH` (not a rejected/non-zero exit — an actual throw).
 * Before the fix, `ghRaw` didn't catch it, so `ghJson`/`ghAvailable`/`resolveLandMode` all rejected
 * instead of degrading to local mode, violating DESIGN.md risk 5 ("every gh failure degrades to loud
 * local mode or surfaced refusal, never a crash"). These tests run with a REAL `$PATH` that has no
 * `gh` on it — no module mocks — so a regression here would actually throw, not just fail an assertion.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const { gh, ghJson, ghAvailable } = await import("../src/gh.ts");

const originalPath = process.env.PATH;
afterEach(() => {
	process.env.PATH = originalPath;
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

/** A `$PATH` directory that has `git` (symlinked from the real one, since `hardenedGit`/`repoIdentity`
 *  still need it to build a repo fixture) but deliberately NO `gh` — the exact "gh not installed" shape
 *  this bug hits, without also breaking every git call these tests depend on. */
async function pathWithGitButNoGh(): Promise<string> {
	const dir = await tmpDir("gh-missing-bin-");
	const which = Bun.spawn(["which", "git"], { stdout: "pipe" });
	const realGit = (await new Response(which.stdout).text()).trim();
	await which.exited;
	await fs.symlink(realGit, path.join(dir, "git"));
	return dir;
}

test("gh() resolves (never throws) a non-zero result when the gh binary is missing from PATH", async () => {
	process.env.PATH = await pathWithGitButNoGh();
	const cwd = await tmpDir("gh-missing-cwd-");
	const r = await gh(["auth", "status"], cwd);
	expect(r.code).not.toBe(0);
	expect(r.stderr).toContain("gh unavailable");
});

test("ghJson() resolves undefined (never throws) when the gh binary is missing from PATH", async () => {
	process.env.PATH = await pathWithGitButNoGh();
	const cwd = await tmpDir("gh-missing-cwd2-");
	const r = await ghJson(["repo", "view", "acme/repo", "--json", "defaultBranchRef"], cwd);
	expect(r).toBeUndefined();
});

test("ghAvailable() resolves false (never throws) when the gh binary is missing from PATH", async () => {
	process.env.PATH = await pathWithGitButNoGh();
	const cwd = await tmpDir("gh-missing-cwd3-");
	expect(await ghAvailable(cwd)).toBe(false);
});

test("resolveLandMode() resolves to local (never rejects) when gh is missing from PATH", async () => {
	// Build the repo fixture BEFORE swapping PATH: `git` itself is on the constructed PATH too, so this
	// isn't strictly required, but keeps fixture setup unambiguous either way.
	const repo = await tmpDir("gh-missing-repo-");
	await Bun.spawn(["git", "init", "-q", "-b", "main"], { cwd: repo }).exited;
	await Bun.spawn(["git", "config", "user.email", "t@t"], { cwd: repo }).exited;
	await Bun.spawn(["git", "config", "user.name", "t"], { cwd: repo }).exited;
	await Bun.spawn(["git", "remote", "add", "origin", "git@github.com:acme/repo-xyz.git"], { cwd: repo }).exited;

	process.env.PATH = await pathWithGitButNoGh();

	const { resolveLandMode } = await import("../src/land-mode.ts");
	const resolved = await resolveLandMode(repo);
	expect(resolved.mode).toBe("local");
	expect(resolved.reason).toContain("gh repo view");
});
