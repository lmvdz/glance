/**
 * Land proof — the deterministic gate that replaces "the agent says it works." Tested
 * against real temp git repos: a passing/failing acceptance run, freshness vs HEAD, the
 * land gate's block/clear/stale transitions, and vision-evidence collection.
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { headCommit, isFresh, type Proof, proofFor, proofGate, runProof } from "../src/proof.ts";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function git(cwd: string, ...a: string[]): Promise<void> {
	await Bun.spawn(["git", "-C", cwd, ...a], { stdout: "ignore", stderr: "ignore" }).exited;
}

async function baseRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "proof-"));
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
	const wt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "proof-wt-")), branch);
	tmps.push(path.dirname(wt));
	await git(repo, "worktree", "add", "-q", wt, branch);
	await fs.writeFile(path.join(wt, file), `${file}\n`);
	await git(wt, "add", "-A");
	await git(wt, "commit", "-qm", `add ${file}`);
	return wt;
}

test("runProof records a passing proof keyed to HEAD, retrievable via proofFor", async () => {
	const repo = await baseRepo();
	const proof = await runProof({ repo, worktree: repo, command: "true" });
	expect(proof.ok).toBe(true);
	expect(proof.commit).toBe(await headCommit(repo));
	const got = await proofFor(repo, repo);
	expect(got?.ok).toBe(true);
	expect(got?.commit).toBe(proof.commit);
});

test("runProof records a failing proof (non-zero exit)", async () => {
	const repo = await baseRepo();
	expect((await runProof({ repo, worktree: repo, command: "exit 3" })).ok).toBe(false);
});

test("isFresh: passing + matching commit is fresh; mismatch or failure is not", () => {
	const b: Omit<Proof, "ok" | "commit"> = { command: "x", ranAt: 0, detail: "", artifacts: [] };
	expect(isFresh({ ...b, ok: true, commit: "abc" }, "abc")).toBe(true);
	expect(isFresh({ ...b, ok: true, commit: "abc" }, "def")).toBe(false);
	expect(isFresh({ ...b, ok: false, commit: "abc" }, "abc")).toBe(false);
	expect(isFresh(undefined, "abc")).toBe(false);
	expect(isFresh({ ...b, ok: true, commit: "" }, "")).toBe(false);
});

test("proofGate: blocks without proof, clears when fresh, goes stale on a new commit, blocks on failure", async () => {
	const repo = await baseRepo();
	const wt = await branchWorktree(repo, "feat", "f.txt");

	expect(await proofGate(repo, wt, "feat")).toMatch(/no proof/);

	await runProof({ repo, worktree: wt, command: "true" });
	expect(await proofGate(repo, wt, "feat")).toBeUndefined();

	await fs.writeFile(path.join(wt, "g.txt"), "g\n");
	await git(wt, "add", "-A");
	await git(wt, "commit", "-qm", "more");
	expect(await proofGate(repo, wt, "feat")).toMatch(/stale/);

	await runProof({ repo, worktree: wt, command: "exit 1" });
	expect(await proofGate(repo, wt, "feat")).toMatch(/FAILED/);
});

test("proofGate: in-place agents (worktree === repo, or no branch) need no proof", async () => {
	const repo = await baseRepo();
	expect(await proofGate(repo, repo, "main")).toBeUndefined();
	const wt = await branchWorktree(repo, "feat2", "h.txt");
	expect(await proofGate(repo, wt, undefined)).toBeUndefined();
});

test("runProof collects screenshots under .omp/proof as vision evidence", async () => {
	const repo = await baseRepo();
	await fs.mkdir(path.join(repo, ".omp", "proof", "feat"), { recursive: true });
	await fs.writeFile(path.join(repo, ".omp", "proof", "feat", "shot.png"), "x");
	const proof = await runProof({ repo, worktree: repo, command: "true" });
	expect(proof.artifacts.some((a) => a.endsWith("shot.png"))).toBe(true);
});

test("runProof: vision off ⇒ deterministic proof only; injected producer ⇒ artifacts merge but gate is untouched", async () => {
	const repo = await baseRepo();

	// Vision off (no url, no producer): a correct deterministic proof, no vision artifacts.
	const plain = await runProof({ repo, worktree: repo, command: "true" });
	expect(plain.ok).toBe(true);
	expect(plain.commit).toBe(await headCommit(repo));
	expect(plain.artifacts.some((a) => a.includes(`${path.sep}vision${path.sep}`))).toBe(false);

	// Vision on with an injected fake producer, against a FAILING command. The producer "succeeds"
	// (writes a screenshot + notes.md), but the gate must still reflect only the command: ok=false.
	const fake = async ({ dir }: { worktree: string; url: string; dir: string }) => {
		await fs.writeFile(path.join(dir, "home.png"), "img");
		await fs.writeFile(path.join(dir, "notes.md"), "- page loads\n");
	};
	const visioned = await runProof({ repo, worktree: repo, command: "exit 1", visionUrl: "http://127.0.0.1:7777", producer: fake });
	expect(visioned.ok).toBe(false); // gate unaffected by a passing vision pass
	expect(visioned.commit).toBe(await headCommit(repo));
	expect(visioned.artifacts.some((a) => a.endsWith(`vision${path.sep}home.png`))).toBe(true);
	expect(visioned.artifacts.some((a) => a.endsWith(`vision${path.sep}notes.md`))).toBe(true);
});
