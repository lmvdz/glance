/**
 * `dirtyFiles` must mean exactly what LAND means by dirty, and nothing else.
 *
 * `land.ts` refuses on `git status --porcelain --untracked-files=no` against the repo — a TRACKED
 * modification. The refusal is classed RETRYABLE, so the fleet retries forever and the learning ledger
 * starves; that is why `doctor` calls this an error rather than a warning, and why it must not fire on a
 * stray build artifact that land happily ignores. A diagnostic that cries wolf gets turned off, and then
 * it is not there on the day the ledger really is starving. (grok-4.5)
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { repoFacts } from "../src/doctor-probe.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function git(args: string[], cwd: string): Promise<void> {
	const p = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
	await p.exited;
}

async function repo(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-repo-"));
	dirs.push(dir);
	await git(["init", "-q", "-b", "main"], dir);
	await git(["config", "user.email", "t@t.t"], dir);
	await git(["config", "user.name", "t"], dir);
	await fs.writeFile(path.join(dir, "a.txt"), "one\n");
	await git(["add", "."], dir);
	await git(["commit", "-qm", "init"], dir);
	return dir;
}

test("a clean repo reports clean", async () => {
	const f = await repoFacts(await repo());
	expect(f.exists).toBe(true);
	expect(f.isGitRepo).toBe(true);
	expect(f.dirtyFiles).toBe(0);
	expect(f.defaultBranch).toBe("main");
	expect(f.hasOrigin).toBe(false);
});

/** The one that matters: land ignores untracked files, so doctor must too. */
test("an untracked build artifact is NOT dirty — land ignores it, so doctor must", async () => {
	const dir = await repo();
	await fs.mkdir(path.join(dir, "dist"), { recursive: true });
	await fs.writeFile(path.join(dir, "dist", "bundle.js"), "// build output\n");
	await fs.writeFile(path.join(dir, "scratch.log"), "noise\n");

	expect((await repoFacts(dir)).dirtyFiles).toBe(0);
});

test("a tracked modification IS dirty — this is what makes every land refuse", async () => {
	const dir = await repo();
	await fs.writeFile(path.join(dir, "a.txt"), "two\n");
	expect((await repoFacts(dir)).dirtyFiles).toBe(1);
});

test("a staged deletion is dirty too", async () => {
	const dir = await repo();
	await git(["rm", "-q", "a.txt"], dir);
	expect((await repoFacts(dir)).dirtyFiles).toBe(1);
});

test("squad/* branches are counted; other branches are not", async () => {
	const dir = await repo();
	await git(["branch", "squad/ompsq-1"], dir);
	await git(["branch", "squad/ompsq-2"], dir);
	await git(["branch", "feat/unrelated"], dir);
	expect((await repoFacts(dir)).staleBranches).toBe(2);
});

test("a detached HEAD names no branch rather than inventing one", async () => {
	const dir = await repo();
	const rev = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dir }).stdout.toString().trim();
	await git(["checkout", "-q", "--detach", rev], dir);
	const f = await repoFacts(dir);
	expect(f.defaultBranch).toBeUndefined();
	expect(f.isGitRepo).toBe(true);
});

test("a path that is not a git repo, and one that does not exist", async () => {
	const plain = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-plain-"));
	dirs.push(plain);
	expect((await repoFacts(plain)).isGitRepo).toBe(false);

	const gone = await repoFacts("/definitely/not/here");
	expect(gone.exists).toBe(false);
	expect(gone.isGitRepo).toBe(false);
});
