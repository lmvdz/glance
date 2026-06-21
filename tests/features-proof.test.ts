/**
 * Feature proof summary — featureLandStatus attaches a per-member land-proof rollup
 * derived from src/proof.ts. Verified against real temp git repos across the four
 * states the dashboard renders: none / failed / stale / fresh.
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { featureLandStatus } from "../src/features.ts";
import { runProof } from "../src/proof.ts";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function git(cwd: string, ...a: string[]): Promise<void> {
	await Bun.spawn(["git", "-C", cwd, ...a], { stdout: "ignore", stderr: "ignore" }).exited;
}

async function baseRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "featproof-"));
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
	const wt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "featproof-wt-")), branch);
	tmps.push(path.dirname(wt));
	await git(repo, "worktree", "add", "-q", wt, branch);
	await fs.writeFile(path.join(wt, file), `${file}\n`);
	await git(wt, "add", "-A");
	await git(wt, "commit", "-qm", "work");
	return wt;
}

test("proof summary: 'none' when no proof has been recorded", async () => {
	const repo = await baseRepo();
	const wt = await branchWorktree(repo, "feat", "f.txt");
	const [s] = await featureLandStatus([{ worktree: wt, repo, branch: "feat" }]);
	expect(s.proof?.state).toBe("none");
	expect(s.proof?.artifacts).toBe(0);
	expect(s.proof?.ranAt).toBeUndefined();
});

test("proof summary: 'fresh' after a passing proof on the current HEAD", async () => {
	const repo = await baseRepo();
	const wt = await branchWorktree(repo, "feat", "f.txt");
	const proof = await runProof({ repo, worktree: wt, command: "true" });
	const [s] = await featureLandStatus([{ worktree: wt, repo, branch: "feat" }]);
	expect(s.proof?.state).toBe("fresh");
	expect(s.proof?.ranAt).toBe(proof.ranAt);
});

test("proof summary: 'stale' once HEAD moves past the recorded proof", async () => {
	const repo = await baseRepo();
	const wt = await branchWorktree(repo, "feat", "f.txt");
	await runProof({ repo, worktree: wt, command: "true" });
	await fs.writeFile(path.join(wt, "g.txt"), "g\n");
	await git(wt, "add", "-A");
	await git(wt, "commit", "-qm", "more");
	const [s] = await featureLandStatus([{ worktree: wt, repo, branch: "feat" }]);
	expect(s.proof?.state).toBe("stale");
});

test("proof summary: 'failed' when the recorded proof did not pass", async () => {
	const repo = await baseRepo();
	const wt = await branchWorktree(repo, "feat", "f.txt");
	await runProof({ repo, worktree: wt, command: "exit 1" });
	const [s] = await featureLandStatus([{ worktree: wt, repo, branch: "feat" }]);
	expect(s.proof?.state).toBe("failed");
});
