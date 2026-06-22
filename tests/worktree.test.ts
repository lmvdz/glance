/**
 * Worktree isolation under fleet load (OMPSQ-40). Two guarantees:
 *  1. addWorktree retries TRANSIENT git lock contention (index/ref locks) but fails fast on a real error.
 *  2. resolveWorktree NEVER runs in-place on a git checkout when worktree creation fails — only a
 *     non-git "spawn anywhere" dir keeps the in-place fallback. Stubbed git runner → no real repo/agents.
 */

import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { addWorktree, type GitResult, type GitRunner, isGitRepo, resolveWorktree } from "../src/worktree.ts";

const LOCK: GitResult = { code: 128, stdout: "", stderr: "fatal: Unable to create '/r/.git/worktrees/x/index.lock': File exists" };
const OK: GitResult = { code: 0, stdout: "", stderr: "" };

/** A git runner that fakes the lookups addWorktree makes and replays `addOutcomes` for each `worktree add`. */
function stubRunner(addOutcomes: GitResult[]): { run: GitRunner; addCalls: () => number } {
	let addIdx = 0;
	const run: GitRunner = async (args) => {
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { code: 0, stdout: "/tmp/omp-fake-repo", stderr: "" };
		if (args[0] === "worktree" && args[1] === "list") return { code: 0, stdout: "", stderr: "" };
		if (args[0] === "rev-parse" && args[1] === "--verify") return { code: 1, stdout: "", stderr: "" }; // branch absent → -b path
		if (args[0] === "worktree" && args[1] === "add") return addOutcomes[Math.min(addIdx++, addOutcomes.length - 1)];
		return OK;
	};
	return { run, addCalls: () => addIdx };
}

test("addWorktree retries transient lock contention twice then succeeds", async () => {
	const { run, addCalls } = stubRunner([LOCK, LOCK, OK]);
	const wt = await addWorktree({ repo: "/tmp/omp-fake-repo", branch: "squad/x" }, run);
	expect(wt.branch).toBe("squad/x");
	expect(addCalls()).toBe(3); // initial + 2 retries
});

test("addWorktree fails fast on a non-lock error (no retry)", async () => {
	const fail: GitResult = { code: 128, stdout: "", stderr: "fatal: invalid reference: refs/heads/bad" };
	const { run, addCalls } = stubRunner([fail, fail, fail]);
	await expect(addWorktree({ repo: "/tmp/omp-fake-repo", branch: "squad/y" }, run)).rejects.toThrow(/git worktree add failed/);
	expect(addCalls()).toBe(1); // no retry on a genuine failure
});

test("resolveWorktree: a git repo whose worktree creation fails refuses in-place, surfaces the error", async () => {
	const failingAdd: typeof addWorktree = async () => {
		throw new Error("git worktree add failed: Unable to create index.lock");
	};
	const gitProbe: typeof isGitRepo = async () => true;
	// Must throw — running in-place here would mutate the shared checkout (the OMPSQ-40 bug).
	await expect(resolveWorktree("/some/git/repo", "squad/z", failingAdd, gitProbe)).rejects.toThrow();
});

test("resolveWorktree: a non-git dir keeps the in-place 'spawn anywhere' fallback", async () => {
	const failingAdd: typeof addWorktree = async () => {
		throw new Error("not a git repository");
	};
	const gitProbe: typeof isGitRepo = async () => false;
	const wt = await resolveWorktree("/some/plain/dir", "squad/z", failingAdd, gitProbe);
	expect(wt.inPlace).toBe(true);
	expect(wt.cwd).toBe("/some/plain/dir");
	expect(wt.repo).toBe("/some/plain/dir");
});

test("isGitRepo: true inside a checkout, false in a plain dir", async () => {
	expect(await isGitRepo(process.cwd())).toBe(true); // tests run inside this git worktree
	const plain = await fs.mkdtemp(path.join(os.tmpdir(), "omp-nongit-"));
	try {
		expect(await isGitRepo(plain)).toBe(false);
	} finally {
		await fs.rm(plain, { recursive: true, force: true });
	}
});
