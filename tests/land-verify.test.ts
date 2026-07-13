/**
 * Land verification gate — a textually-clean merge can still be semantically broken, so after
 * merging a branch into main the land runs a verification command and ROLLS BACK the merge if it
 * fails. main is always left green. These tests drive the contract deterministically via the
 * `verify` override (no real toolchain): "exit 1" simulates a broken build, "true" a passing one.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { landAgent } from "../src/land.ts";
import { proofFor, setProofRoot } from "../src/proof.ts";

const tmps: string[] = [];
beforeAll(async () => {
	// Isolate the post-merge proof records this suite writes into a throwaway state dir.
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "land-verify-state-"));
	tmps.push(stateDir);
	setProofRoot(stateDir);
});
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

test("landAgent: gate failure rolls back the merge, main stays green", async () => {
	const repo = await baseRepo("land-verify-fail-");
	const wt = await branchWorktree(repo, "feat", "feature.txt");
	const mainHead0 = await out(repo, "rev-parse", "HEAD");
	const branchHead = await out(repo, "rev-parse", "feat");

	// Base-green gate: passes at head0 (no feature.txt yet), fails once the branch merges feature.txt
	// in — i.e. the branch regressed a green base, so the merge must roll back.
	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "test ! -f feature.txt" });

	expect(res.ok).toBe(false);
	expect(res.merged).toBe(false);
	// main was reset back to its pre-merge HEAD — the broken merge did not stick.
	expect(await out(repo, "rev-parse", "HEAD")).toBe(mainHead0);
	// feature.txt never made it onto main.
	expect((await out(repo, "ls-tree", "-r", "--name-only", "HEAD")).split("\n")).not.toContain("feature.txt");
	// The worktree branch keeps its commit — only main was rolled back, so it can be re-landed.
	expect(await out(repo, "rev-parse", "feat")).toBe(branchHead);
	expect((await out(repo, "ls-tree", "-r", "--name-only", "feat")).split("\n")).toContain("feature.txt");
});

test("landAgent: gate success lands normally", async () => {
	const repo = await baseRepo("land-verify-ok-");
	const wt = await branchWorktree(repo, "feat", "feature.txt");

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "true" });

	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
	expect((await out(repo, "ls-tree", "-r", "--name-only", "HEAD")).split("\n")).toContain("feature.txt");
});

test("landAgent: a successful gate land records a durable post-merge proof of the merged main", async () => {
	const repo = await baseRepo("land-verify-postproof-");
	const wt = await branchWorktree(repo, "feat", "feature.txt");

	await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "true" });

	// The landed main is backed by an inspectable proof keyed to the merged HEAD — not just an
	// in-the-moment pass. It is stored against the main checkout (worktree === repo).
	const mainHead = await out(repo, "rev-parse", "HEAD");
	const proof = await proofFor(repo, repo);
	expect(proof?.ok).toBe(true);
	expect(proof?.commit).toBe(mainHead);
	expect(proof?.command).toBe("true");
	expect(proof?.branch).toBe("main");
});

test("landAgent: no-acceptance-gate land still records a post-merge proof (no gate ran)", async () => {
	const repo = await baseRepo("land-verify-nogate-");
	const wt = await branchWorktree(repo, "feat", "feature.txt");

	await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "" });

	const proof = await proofFor(repo, repo);
	expect(proof?.ok).toBe(true);
	expect(proof?.command).toBe("(no acceptance gate)");
	expect(proof?.commit).toBe(await out(repo, "rev-parse", "HEAD"));
});

test("landAgent: empty verify string skips the gate (back-compat)", async () => {
	const repo = await baseRepo("land-verify-skip-");
	const wt = await branchWorktree(repo, "feat", "feature.txt");

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "" });

	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
	expect((await out(repo, "ls-tree", "-r", "--name-only", "HEAD")).split("\n")).toContain("feature.txt");
});

// finding #10 (eap-borrows wave 2): detectVerify() collapses "genuinely no toolchain" and "package.json
// exists but is unreadable/malformed" into the SAME undefined — the OLD land path then treated a
// broken node repo exactly like a legitimate non-node repo ("no acceptance gate", proceed and land
// unverified). NEW behavior: refused, distinct from the "no verify command at all" case above.

test("landAgent: finding #10 — a malformed package.json refuses the land instead of silently skipping acceptance", async () => {
	const repo = await baseRepo("land-verify-badpkg-");
	const wt = await branchWorktree(repo, "feat", "feature.txt");
	await fs.writeFile(path.join(repo, "package.json"), "{ this is not json");
	const head0 = await out(repo, "rev-parse", "HEAD");

	// opts.verify left undefined — auto-detect is actually consulted (unlike the "" back-compat case above).
	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false });

	expect(res.ok).toBe(false);
	expect(res.merged).toBe(false);
	expect(res.retryable).toBe(true);
	expect(res.detail ?? "").toContain("could not detect");
	// The merge is never even attempted — main's HEAD never moved and the branch content isn't there.
	expect(await out(repo, "rev-parse", "HEAD")).toBe(head0);
	expect((await out(repo, "ls-tree", "-r", "--name-only", "HEAD")).split("\n")).not.toContain("feature.txt");
});

test("landAgent: finding #10 guard-rail — a repo with NO package.json at all still lands with no acceptance gate (never blocks for lacking one)", async () => {
	const repo = await baseRepo("land-verify-nopkg-");
	const wt = await branchWorktree(repo, "feat", "feature.txt");

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false });

	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
});
