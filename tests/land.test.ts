/**
 * Land queue — two lands fired concurrently at the SAME repo must not race the main
 * checkout. Serialization guarantees both land (one fast-forward, one merge-commit)
 * and both branches' files end up on main. Without it, interleaved `git merge` in one
 * working dir trips index.lock / "merge in progress" and a land is dropped.
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { dirtyLandTargetWarnings, landAgent } from "../src/land.ts";
import { runProof } from "../src/proof.ts";

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

/** A repo on `main` with one base commit. gpgsign off so commits work on signed-by-default boxes. */
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

/** A worktree on its own branch, with one committed file the branch is ahead by. */
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

test("landAgent: concurrent lands on one repo serialize — both branches land", async () => {
	const repo = await baseRepo("land-");
	const wtA = await branchWorktree(repo, "feat-a", "a.txt");
	const wtB = await branchWorktree(repo, "feat-b", "b.txt");

	// Fire both WITHOUT awaiting between them — they hit the same main checkout at once.
	const [ra, rb] = await Promise.all([
		landAgent({ repo, worktree: wtA, branch: "feat-a", message: "land a", commitWip: false }),
		landAgent({ repo, worktree: wtB, branch: "feat-b", message: "land b", commitWip: false }),
	]);

	expect(ra.ok).toBe(true);
	expect(rb.ok).toBe(true);
	expect(ra.merged).toBe(true);
	expect(rb.merged).toBe(true);

	// Both branches' files are reachable on main HEAD — neither land was dropped.
	const tree = await out(repo, "ls-tree", "-r", "--name-only", "HEAD");
	expect(tree.split("\n").sort()).toEqual(["a.txt", "b.txt", "base.txt"]);
});

test("landAgent: nothing to land is reported, not failed", async () => {
	const repo = await baseRepo("land-noop-");
	const res = await landAgent({ repo, worktree: repo, branch: "main", message: "noop", commitWip: false });
	expect(res.ok).toBe(true);
	expect(res.merged).toBe(false);
});

test("landAgent: requireProof refuses missing proof and allows fresh proof", async () => {
	const repo = await baseRepo("land-proof-");
	const wt = await branchWorktree(repo, "feat-proof", "proof.txt");

	const blocked = await landAgent({ repo, worktree: wt, branch: "feat-proof", message: "land proof", commitWip: false, requireProof: true });
	expect(blocked.ok).toBe(false);
	expect(blocked.merged).toBe(false);
	expect(blocked.detail).toContain("no proof");

	await runProof({ repo, worktree: wt, command: "true" });
	const landed = await landAgent({ repo, worktree: wt, branch: "feat-proof", message: "land proof", commitWip: false, requireProof: true });
	expect(landed.ok).toBe(true);
	expect(landed.merged).toBe(true);
});

test("landAgent: a FORCED land without a passing proof is flagged forcedWithoutProof (unproven trust, made legible)", async () => {
	const repo = await baseRepo("land-force-unproven-");
	const wt = await branchWorktree(repo, "feat-forced", "forced.txt");

	// requireProof:false is the force override. No proof was ever run → the gate would have blocked,
	// so the merge is unproven and must be flagged for the audit trail.
	const res = await landAgent({ repo, worktree: wt, branch: "feat-forced", message: "force land", commitWip: false, requireProof: false });
	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
	expect(res.forcedWithoutProof).toBe(true);
	expect(res.detail).toContain("WITHOUT a passing proof gate (FORCED)");
});

test("landAgent: a forced land that HAS a fresh proof is NOT flagged (no crying wolf)", async () => {
	const repo = await baseRepo("land-force-proven-");
	const wt = await branchWorktree(repo, "feat-proven", "proven.txt");
	await runProof({ repo, worktree: wt, command: "true" }); // a genuine fresh proof exists

	const res = await landAgent({ repo, worktree: wt, branch: "feat-proven", message: "force land proven", commitWip: false, requireProof: false });
	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
	expect(res.forcedWithoutProof).toBeFalsy();
});

test("landAgent: a normal land (requireProof undefined) is never flagged as forced", async () => {
	const repo = await baseRepo("land-normal-noflag-");
	const wt = await branchWorktree(repo, "feat-normal", "normal.txt");
	const res = await landAgent({ repo, worktree: wt, branch: "feat-normal", message: "land normal", commitWip: false });
	expect(res.ok).toBe(true);
	expect(res.forcedWithoutProof).toBeFalsy();
});

test("dirtyLandTargetWarnings: flags only targets with uncommitted tracked changes", () => {
	const counts: Record<string, number> = { "/clean": 0, "/dirty": 3 };
	const warns = dirtyLandTargetWarnings(["/clean", "/dirty"], (r) => counts[r] ?? 0);
	expect(warns.length).toBe(1); // the clean target is silent
	expect(warns[0]).toContain("/dirty");
	expect(warns[0]).toContain("3 uncommitted");
	expect(warns[0]).toContain("DEDICATED checkout"); // points at the durable fix
});

test("landAgent: commitWip sweeps real work but never the .omp/ evidence dir", async () => {
	const repo = await baseRepo("land-omp-");
	const wt = await branchWorktree(repo, "feat-evidence", "work.txt");
	// Uncommitted real work + daemon evidence, both present at land time.
	await fs.writeFile(path.join(wt, "wip.txt"), "uncommitted work\n");
	await fs.mkdir(path.join(wt, ".omp", "proof"), { recursive: true });
	await fs.writeFile(path.join(wt, ".omp", "proof", "shot.png"), "png\n");

	const res = await landAgent({ repo, worktree: wt, branch: "feat-evidence", message: "land evidence test", commitWip: true });
	expect(res.ok).toBe(true);
	expect(res.committed).toBe(true);

	// The WIP landed on main; the screenshot did not, and stayed untracked in the worktree.
	expect(await out(repo, "ls-tree", "-r", "--name-only", "HEAD")).toContain("wip.txt");
	expect(await out(repo, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain(".omp/proof/shot.png");
	expect(await out(wt, "status", "--porcelain")).toContain(".omp/");
});

test("landAgent: commitWip with ONLY .omp/ evidence dirty commits nothing and still lands cleanly", async () => {
	const repo = await baseRepo("land-omp2-");
	const wt = await branchWorktree(repo, "feat-evidence-only", "work2.txt");
	await fs.mkdir(path.join(wt, ".omp", "proof"), { recursive: true });
	await fs.writeFile(path.join(wt, ".omp", "proof", "shot.png"), "png\n");

	const res = await landAgent({ repo, worktree: wt, branch: "feat-evidence-only", message: "land evidence-only test", commitWip: true });
	expect(res.ok).toBe(true);
	expect(res.committed).toBe(false); // nothing landable was dirty — no empty-commit attempt
	expect(res.merged).toBe(true); // the committed branch work still lands
});
