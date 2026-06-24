/**
 * Base-aware land gate (src/land.ts verifyMerged). The gate distinguishes "this branch regressed a
 * green base" from "the base was already red". A branch onto a green base behaves byte-for-byte as
 * before (land if green, roll back if red). A branch onto an already-red base LANDS with a logged
 * note instead of being refused — otherwise a brownfield repo could never land anything.
 *
 * Driven deterministically via the `verify` override: the gate `test ! -f RED` fails iff a tracked
 * `RED` marker exists in the checkout, so committing/omitting RED on base vs. branch toggles
 * base/merged red/green. Real git in a tmp dir, no mocks.
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { landAgent } from "../src/land.ts";

const GATE = "test ! -f RED"; // exit 0 (green) when RED absent, exit 1 (red) when present
const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function git(cwd: string, ...a: string[]): Promise<void> {
	await Bun.spawn(["git", "-C", cwd, ...a], { stdout: "ignore", stderr: "ignore" }).exited;
}

async function out(cwd: string, ...a: string[]): Promise<string> {
	const p = Bun.spawn(["git", "-C", cwd, ...a], { stdout: "pipe", stderr: "pipe" });
	const [s] = await Promise.all([new Response(p.stdout).text(), p.exited]);
	return s.trim();
}

/** A repo on `main` with one base commit. `red` ⇒ the base commit also tracks the RED marker. */
async function baseRepo(prefix: string, red: boolean): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(repo);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "base.txt"), "base\n");
	if (red) await fs.writeFile(path.join(repo, "RED"), "broken\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	return repo;
}

/** A worktree on its own branch ahead by one commit adding `file`. */
async function branchWorktree(repo: string, branch: string, file: string): Promise<string> {
	await git(repo, "branch", branch);
	const wt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "land-wt-")), branch);
	tmps.push(path.dirname(wt));
	await git(repo, "worktree", "add", "-q", wt, branch);
	await fs.writeFile(path.join(wt, file), `${file}\n`);
	await git(wt, "add", "-A");
	await git(wt, "commit", "-qm", `add ${file}`);
	return wt;
}

test("base green + clean branch → lands, verified (unchanged)", async () => {
	const repo = await baseRepo("land-base-greengreen-", false);
	const wt = await branchWorktree(repo, "feat", "feature.txt");

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: GATE });

	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
	expect(res.detail).toContain("verified");
	expect((await out(repo, "ls-tree", "-r", "--name-only", "HEAD")).split("\n")).toContain("feature.txt");
});

test("base green + branch breaks the gate → blocked, main reset to head0 (unchanged)", async () => {
	const repo = await baseRepo("land-base-greenred-", false);
	const head0 = await out(repo, "rev-parse", "HEAD");
	const wt = await branchWorktree(repo, "feat", "RED"); // branch introduces the RED marker

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: GATE });

	expect(res.ok).toBe(false);
	expect(res.merged).toBe(false);
	expect(res.detail).toContain("rolled main back");
	expect(await out(repo, "rev-parse", "HEAD")).toBe(head0); // main rolled back, stays green
});

test("base already red + clean branch → lands onto the red baseline with a logged note", async () => {
	const repo = await baseRepo("land-base-redred-", true); // base tracks RED ⇒ already red
	const head0 = await out(repo, "rev-parse", "HEAD");
	const wt = await branchWorktree(repo, "feat", "feature.txt");

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: GATE });

	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
	expect(res.detail).toContain("landed onto a red baseline");
	expect(await out(repo, "rev-parse", "HEAD")).not.toBe(head0); // main advanced past the red base
	expect((await out(repo, "ls-tree", "-r", "--name-only", "HEAD")).split("\n")).toContain("feature.txt");
});
