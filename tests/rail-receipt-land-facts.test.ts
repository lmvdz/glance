/**
 * Receipt attribution facts (T6, glance#334, gauntlet round 1 Cluster B) — the LOCAL land path must
 * stamp `head0` (pre-merge tip = rollback point) and `landedCommit` (post-merge HEAD) onto its
 * `LandResult`, captured IN-LOCK and keyed to THIS land. These are the STABLE SHAs the receipt diffs
 * and rolls back from, so a concurrent land moving HEAD afterward can never mis-attribute another
 * land's commit to this receipt (the TOCTOU the gauntlet flagged). Real git, no mocks.
 */
import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { landAgent } from "../src/land.ts";
import { setProofRoot } from "../src/proof.ts";

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
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}state-`));
	tmps.push(stateDir);
	setProofRoot(stateDir);
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
	await fs.writeFile(path.join(wt, file), `${file}\ntwo\nthree\n`);
	await git(wt, "add", "-A");
	await git(wt, "commit", "-qm", `add ${file}`);
	return wt;
}

test("landAgent stamps head0 (pre-merge tip) and landedCommit (post-merge HEAD) as stable SHAs", async () => {
	const repo = await baseRepo("land-facts-");
	const wt = await branchWorktree(repo, "feat", "feature.txt");
	const preMergeMain = await out(repo, "rev-parse", "HEAD");

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "echo verified-ok", requireProof: false, staleGate: false });

	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
	// head0 is the pre-merge main tip — the receipt's rollback point.
	expect(res.head0).toBe(preMergeMain);
	// landedCommit is main's HEAD AFTER the merge — the commit that actually landed.
	const postMergeMain = await out(repo, "rev-parse", "HEAD");
	expect(res.landedCommit).toBe(postMergeMain);
	// They differ (a real merge advanced main), and both are full SHAs the receipt can diff.
	expect(res.landedCommit).not.toBe(res.head0);
	const numstat = await out(repo, "diff", "--numstat", `${res.head0}..${res.landedCommit}`);
	expect(numstat).toContain("feature.txt");
});

test("a no-merge land (nothing ahead) stamps NO commit facts", async () => {
	const repo = await baseRepo("land-facts-noop-");
	// A worktree on a branch with NO commits ahead of main ⇒ nothing to land.
	await git(repo, "branch", "empty");
	const wtParent = await fs.mkdtemp(path.join(os.tmpdir(), "land-wt-noop-"));
	tmps.push(wtParent);
	const wt = path.join(wtParent, "empty");
	await git(repo, "worktree", "add", "-q", wt, "empty");

	const res = await landAgent({ repo, worktree: wt, branch: "empty", message: "nothing", commitWip: true, verify: "", requireProof: false, staleGate: false });

	expect(res.merged).toBe(false);
	expect(res.head0).toBeUndefined();
	expect(res.landedCommit).toBeUndefined();
});
