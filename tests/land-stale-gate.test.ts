/**
 * Stale-branch land gate (src/land.ts staleBranchReason + the clean --no-ff refusal).
 *
 * The visual-plan-blocks incident: a unit branch forked days earlier merged CLEANLY into a main
 * that had since evolved the same files — silently reverting newer work, with the acceptance gate
 * proving only "tests pass". The gate refuses exactly that case: fork point behind main + same-file
 * overlap + textually clean merge. Everything else lands as before: non-overlapping parallel work,
 * fast-forwards, and CONFLICTING stale branches (those keep flowing to autoresolve, whose rebase
 * surfaces the drift as conflicts a resolver must consciously clear).
 *
 * Real git in tmp dirs, no mocks — same conventions as land-base-gate.test.ts.
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { landAgent, staleBranchReason } from "../src/land.ts";

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

/** Twenty numbered lines so branch and main can edit far-apart regions of the same file cleanly. */
const LINES = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");

/** A repo on `main` with one base commit tracking shared.txt (20 lines) and base.txt. */
async function baseRepo(prefix: string): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(repo);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "shared.txt"), `${LINES}\n`);
	await fs.writeFile(path.join(repo, "base.txt"), "base\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	return repo;
}

/** A worktree on its own branch, one commit ahead, applying `edit` to the checkout. */
async function branchWorktree(repo: string, branch: string, edit: (wt: string) => Promise<void>): Promise<string> {
	await git(repo, "branch", branch);
	const wt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "stale-wt-")), branch);
	tmps.push(path.dirname(wt));
	await git(repo, "worktree", "add", "-q", wt, branch);
	await edit(wt);
	await git(wt, "add", "-A");
	await git(wt, "commit", "-qm", `branch ${branch}`);
	return wt;
}

/** Commit `edit` directly on main — advances it past the branch's fork point. */
async function advanceMain(repo: string, edit: (repo: string) => Promise<void>): Promise<void> {
	await edit(repo);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "main advances");
}

/** Rewrite one line of shared.txt (1-based), leaving the rest intact — far-apart edits merge cleanly. */
function editSharedLine(line: number, text: string): (dir: string) => Promise<void> {
	return async (dir) => {
		const p = path.join(dir, "shared.txt");
		const lines = (await fs.readFile(p, "utf8")).split("\n");
		lines[line - 1] = text;
		await fs.writeFile(p, lines.join("\n"));
	};
}

test("stale + same-file overlap + clean merge → refused, main rolled back", async () => {
	const repo = await baseRepo("stale-overlap-");
	// Branch edits the TOP of shared.txt; main then evolves the BOTTOM — textually clean merge.
	const wt = await branchWorktree(repo, "unit", editSharedLine(1, "branch edit"));
	await advanceMain(repo, editSharedLine(20, "main evolved"));
	const head0 = await out(repo, "rev-parse", "HEAD");

	const res = await landAgent({ repo, worktree: wt, branch: "unit", message: "land unit", commitWip: false, verify: "" });

	expect(res.ok).toBe(false);
	expect(res.merged).toBe(false);
	expect(res.detail).toContain("stale-branch gate");
	expect(res.detail).toContain("shared.txt");
	expect(await out(repo, "rev-parse", "HEAD")).toBe(head0); // merge undone — main untouched
});

test("stale but NO file overlap → lands as before (parallel work on different files)", async () => {
	const repo = await baseRepo("stale-disjoint-");
	const wt = await branchWorktree(repo, "unit", async (d) => fs.writeFile(path.join(d, "feature.txt"), "new\n"));
	await advanceMain(repo, async (d) => fs.writeFile(path.join(d, "other.txt"), "other\n"));

	const res = await landAgent({ repo, worktree: wt, branch: "unit", message: "land unit", commitWip: false, verify: "" });

	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
	expect((await out(repo, "ls-tree", "-r", "--name-only", "HEAD")).split("\n")).toContain("feature.txt");
});

test("fresh branch (fork point == main tip) → fast-forwards untouched by the gate", async () => {
	const repo = await baseRepo("stale-fresh-");
	const wt = await branchWorktree(repo, "unit", editSharedLine(1, "branch edit"));

	const res = await landAgent({ repo, worktree: wt, branch: "unit", message: "land unit", commitWip: false, verify: "" });

	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
	expect(res.detail).toContain("fast-forward");
});

test("staleGate:false (force-land) merges a stale overlapping branch", async () => {
	const repo = await baseRepo("stale-forced-");
	const wt = await branchWorktree(repo, "unit", editSharedLine(1, "branch edit"));
	await advanceMain(repo, editSharedLine(20, "main evolved"));

	const res = await landAgent({ repo, worktree: wt, branch: "unit", message: "land unit", commitWip: false, verify: "", staleGate: false });

	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
});

test("OMP_SQUAD_STALE_GATE=0 disables the gate globally", async () => {
	const repo = await baseRepo("stale-envoff-");
	const wt = await branchWorktree(repo, "unit", editSharedLine(1, "branch edit"));
	await advanceMain(repo, editSharedLine(20, "main evolved"));

	process.env.OMP_SQUAD_STALE_GATE = "0";
	try {
		const res = await landAgent({ repo, worktree: wt, branch: "unit", message: "land unit", commitWip: false, verify: "" });
		expect(res.ok).toBe(true);
		expect(res.merged).toBe(true);
	} finally {
		delete process.env.OMP_SQUAD_STALE_GATE;
	}
});

test("conflicting stale branch still reaches the conflict path (gate does not pre-empt autoresolve)", async () => {
	const repo = await baseRepo("stale-conflict-");
	// Both sides rewrite the SAME line — a real conflict, not a clean clobber.
	const wt = await branchWorktree(repo, "unit", editSharedLine(1, "branch version"));
	await advanceMain(repo, editSharedLine(1, "main version"));

	process.env.OMP_SQUAD_AUTORESOLVE = "0"; // conflict path without spawning a resolver agent
	try {
		const res = await landAgent({ repo, worktree: wt, branch: "unit", message: "land unit", commitWip: false, verify: "" });
		expect(res.ok).toBe(false);
		expect(res.detail).toContain("merge failed"); // the conflict verdict, NOT the stale-gate refusal
	} finally {
		delete process.env.OMP_SQUAD_AUTORESOLVE;
	}
});

test("staleBranchReason names the overlap and how to proceed", async () => {
	const repo = await baseRepo("stale-reason-");
	await branchWorktree(repo, "unit", editSharedLine(1, "branch edit"));
	await advanceMain(repo, editSharedLine(20, "main evolved"));

	const reason = await staleBranchReason(repo, "unit");
	expect(reason).toContain("shared.txt");
	expect(reason).toContain("rebase");

	// Fresh sibling branch forked from the CURRENT tip → not stale.
	await git(repo, "branch", "fresh");
	expect(await staleBranchReason(repo, "fresh")).toBeUndefined();
});

// finding #6 (eap-borrows wave 2): the ORIGINAL probe collapsed "genuinely fresh (fork point IS the
// tip)" and "the merge-base/rev-parse/diff probe itself FAILED" into the same `undefined` — a git
// hiccup silently let a genuinely stale, potentially clobbering merge through unchecked. Passing a
// baseRef that cannot be resolved at all reproduces a real probe failure (distinct from "no common
// ancestor", which staleBranchReason still treats as a legitimate non-stale outcome).
test("finding #6: a stale-branch PROBE FAILURE (unresolvable baseRef) blocks — does not silently read as fresh", async () => {
	const repo = await baseRepo("stale-probefail-");
	await branchWorktree(repo, "unit", editSharedLine(1, "branch edit"));

	const reason = await staleBranchReason(repo, "unit", "refs/heads/this-ref-does-not-exist-anywhere");

	// OLD behavior (fail-open): merge-base failure returned undefined (allow, "safe"). NEW behavior:
	// a distinct, non-`undefined` refusal — the caller (land.ts) blocks auto-land on it.
	expect(reason).toBeDefined();
	expect(reason).toContain("stale-branch");
});
