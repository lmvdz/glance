/**
 * Self-upgrade git helpers over real temp git repos: a bare "remote" with a
 * clone behind it, fast-forward pulls, dirty/no-upstream/non-repo refusals, and
 * a light reexec smoke. No model tokens spent.
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gitState, pullLatest, reexecDaemon } from "../src/upgrade.ts";

const tmps: string[] = [];

afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function run(cwd: string, args: string[]): Promise<void> {
	const p = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
	const code = await p.exited;
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}) in ${cwd}`);
}

async function out(cwd: string, args: string[]): Promise<string> {
	const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout] = await Promise.all([new Response(p.stdout).text(), p.exited]);
	return stdout.trim();
}

async function configRepo(repo: string): Promise<void> {
	await run(repo, ["config", "user.email", "t@t"]);
	await run(repo, ["config", "user.name", "t"]);
	await run(repo, ["config", "commit.gpgsign", "false"]);
}

interface Setup {
	remote: string;
	seed: string;
	clone: string;
}

/**
 * Build: bare `remote` (branch main) ← `seed` (commits c1 then c2, pushed) and
 * `clone` cloned at c1. So `clone` is exactly one commit behind once it fetches.
 */
async function setup(): Promise<Setup> {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), "upg-"));
	tmps.push(base);
	const remote = path.join(base, "remote.git");
	const seed = path.join(base, "seed");
	const clone = path.join(base, "clone");

	await run(base, ["init", "--bare", "-q", "-b", "main", remote]);
	await run(base, ["init", "-q", "-b", "main", seed]);
	await configRepo(seed);
	await fs.writeFile(path.join(seed, "f.txt"), "v1\n");
	await run(seed, ["add", "."]);
	await run(seed, ["commit", "-qm", "c1"]);
	await run(seed, ["remote", "add", "origin", remote]);
	await run(seed, ["push", "-q", "-u", "origin", "main"]);

	await run(base, ["clone", "-q", remote, clone]);
	await configRepo(clone);

	// New commit lands on the remote (via seed); clone is now behind by one.
	await fs.writeFile(path.join(seed, "f.txt"), "v2\n");
	await run(seed, ["commit", "-aqm", "c2"]);
	await run(seed, ["push", "-q", "origin", "main"]);

	return { remote, seed, clone };
}

test("gitState reports behind:1 after a fetch (clean tree, upstream set)", async () => {
	const { clone } = await setup();
	await run(clone, ["fetch", "-q"]);

	const st = await gitState(clone);
	expect(st.branch).toBe("main");
	expect(st.upstream).toBe("origin/main");
	expect(st.behind).toBe(1);
	expect(st.ahead).toBe(0);
	expect(st.dirty).toBe(false);
	expect(st.head.length).toBeGreaterThan(0);
});

test("pullLatest fast-forwards a behind clone, second call is already up to date", async () => {
	const { seed, clone } = await setup();

	const first = await pullLatest(clone);
	expect(first.ok).toBe(true);
	expect(first.updated).toBe(true);
	expect(first.from).toBeTruthy();
	expect(first.to).toBeTruthy();
	expect(first.from).not.toBe(first.to);

	// Fast-forward, not a merge commit: clone HEAD == remote HEAD and tree updated.
	expect(await out(clone, ["rev-parse", "HEAD"])).toBe(await out(seed, ["rev-parse", "HEAD"]));
	expect(await fs.readFile(path.join(clone, "f.txt"), "utf8")).toBe("v2\n");

	const second = await pullLatest(clone);
	expect(second.ok).toBe(true);
	expect(second.updated).toBe(false);
	expect(second.detail).toContain("already up to date");
});

test("pullLatest refuses a dirty tree without forcing", async () => {
	const { clone } = await setup();
	const before = await out(clone, ["rev-parse", "HEAD"]);
	await fs.writeFile(path.join(clone, "f.txt"), "local edit\n");

	const res = await pullLatest(clone);
	expect(res.updated).toBe(false);
	expect(res.ok).toBe(false);
	expect(res.detail).toContain("dirty");

	// The dirty edit and HEAD are untouched — nothing was forced.
	expect(await out(clone, ["rev-parse", "HEAD"])).toBe(before);
	expect(await fs.readFile(path.join(clone, "f.txt"), "utf8")).toBe("local edit\n");
});

test("non-git dir: gitState degrades, pullLatest reports not-a-repo", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "upg-nogit-"));
	tmps.push(dir);

	const st = await gitState(dir);
	expect(st.branch).toBe("");
	expect(st.behind).toBe(0);
	expect(st.ahead).toBe(0);
	expect(st.dirty).toBe(false);
	expect(st.upstream).toBeUndefined();

	const res = await pullLatest(dir);
	expect(res.ok).toBe(false);
	expect(res.updated).toBe(false);
	expect(res.detail).toContain("not a git repository");
});

test("pullLatest reports no-upstream for a repo without a tracking branch", async () => {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), "upg-noup-"));
	tmps.push(base);
	await run(base, ["init", "-q", "-b", "main", base]);
	await configRepo(base);
	await fs.writeFile(path.join(base, "a.txt"), "x\n");
	await run(base, ["add", "."]);
	await run(base, ["commit", "-qm", "init"]);

	const res = await pullLatest(base);
	expect(res.ok).toBe(false);
	expect(res.updated).toBe(false);
	expect(res.detail).toContain("no upstream");
});

test("reexecDaemon spawns a detached process and returns a numeric pid", () => {
	const res = reexecDaemon({ cmd: ["bun", "-e", ""], cwd: os.tmpdir() });
	expect(res.ok).toBe(true);
	expect(typeof res.pid).toBe("number");
	expect(res.pid).toBeGreaterThan(0);
});
