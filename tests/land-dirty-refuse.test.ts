/**
 * Safety: landAgent must REFUSE when the MAIN checkout has uncommitted changes, because its
 * failed-gate rollback (`git reset --hard`) would otherwise destroy them. Regression test for the
 * autoland reset loop that wiped uncommitted work in the shared checkout.
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { landAgent } from "../src/land.ts";

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

async function baseRepo(prefix: string): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(repo);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "base.txt"), "base\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	return repo;
}

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

test("landAgent refuses a dirty main checkout, preserving uncommitted work", async () => {
	const repo = await baseRepo("land-dirty-");
	const wt = await branchWorktree(repo, "feat-x", "x.txt");

	// Uncommitted LOCAL work in the main checkout — a `git reset --hard` rollback would destroy this.
	await fs.writeFile(path.join(repo, "base.txt"), "base\nLOCAL UNCOMMITTED WORK\n");
	const head0 = await out(repo, "rev-parse", "HEAD");

	const res = await landAgent({ repo, worktree: wt, branch: "feat-x", message: "land x", commitWip: false });

	expect(res.ok).toBe(false);
	expect(res.merged).toBe(false);
	expect(res.detail ?? "").toContain("uncommitted");

	// The local edit survived, main HEAD did not move, and the branch was NOT merged.
	expect(await fs.readFile(path.join(repo, "base.txt"), "utf8")).toContain("LOCAL UNCOMMITTED WORK");
	expect(await out(repo, "rev-parse", "HEAD")).toBe(head0);
	expect((await out(repo, "ls-tree", "-r", "--name-only", "HEAD")).split("\n")).not.toContain("x.txt");
});

test("landAgent still lands cleanly when the main checkout is clean (guard does not over-refuse)", async () => {
	const repo = await baseRepo("land-clean-");
	const wt = await branchWorktree(repo, "feat-y", "y.txt");

	const res = await landAgent({ repo, worktree: wt, branch: "feat-y", message: "land y", commitWip: false });

	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
	expect((await out(repo, "ls-tree", "-r", "--name-only", "HEAD")).split("\n")).toContain("y.txt");
});

test("landAgent lands despite an untracked file in main (untracked is not destroyed by reset --hard)", async () => {
	const repo = await baseRepo("land-untracked-");
	const wt = await branchWorktree(repo, "feat-z", "z.txt");
	await fs.writeFile(path.join(repo, "scratch.txt"), "local scratch\n"); // untracked — a hard reset never removes it
	const res = await landAgent({ repo, worktree: wt, branch: "feat-z", message: "land z", commitWip: false });
	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
	expect((await out(repo, "ls-tree", "-r", "--name-only", "HEAD")).split("\n")).toContain("z.txt");
	expect(await fs.readFile(path.join(repo, "scratch.txt"), "utf8")).toContain("local scratch");
});
