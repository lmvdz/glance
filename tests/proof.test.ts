/**
 * Land proof — the deterministic gate that replaces "the agent says it works." Tested
 * against real temp git repos: a passing/failing acceptance run, freshness vs HEAD, the
 * land gate's block/clear/stale transitions, and vision-evidence collection.
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { headCommit, isFresh, type Proof, proofFor, proofGate, recordProof, runProof } from "../src/proof.ts";

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

test("runProof staged: all stages green → ok, per-stage receipts recorded in order", async () => {
	const repo = await baseRepo();
	const proof = await runProof({ repo, worktree: repo, command: "true && true", stages: [{ name: "typecheck", command: "true" }, { name: "test", command: "true" }] });
	expect(proof.ok).toBe(true);
	expect(proof.stages?.map((s) => s.name)).toEqual(["typecheck", "test"]);
	expect(proof.stages?.every((s) => s.exitCode === 0)).toBe(true);
	// command (and its fingerprint) stays the joined string, not the per-stage commands
	expect(proof.command).toBe("true && true");
});

test("runProof staged: FAIL-FAST — first red stage stops the run, later stages recorded as skipped", async () => {
	const repo = await baseRepo();
	const proof = await runProof({ repo, worktree: repo, command: "exit 3 && true", stages: [{ name: "typecheck", command: "exit 3" }, { name: "test", command: "true" }] });
	expect(proof.ok).toBe(false);
	expect(proof.stages?.[0]).toMatchObject({ name: "typecheck", exitCode: 3 });
	// the test stage never ran (fail-fast): recorded as skipped (exitCode null)
	expect(proof.stages?.[1]).toMatchObject({ name: "test", exitCode: null });
	// the failure names the stage for legibility
	expect(proof.detail).toContain("typecheck");
});

test("runProof single-command (no stages) is unchanged — stages undefined", async () => {
	const repo = await baseRepo();
	const proof = await runProof({ repo, worktree: repo, command: "true" });
	expect(proof.ok).toBe(true);
	expect(proof.stages).toBeUndefined();
});

test("isFresh: passing + matching fingerprint is fresh; mismatch, dirty, or failure is not", () => {
	const fp = { commit: "abc", tree: "tree", branch: "feat", dirty: false, baseCommit: "base", repo: "/repo", worktree: "/repo-wt", commandHash: "cmd", now: 10 };
	const b: Omit<Proof, "ok" | "commit"> = { tree: "tree", branch: "feat", dirty: false, baseCommit: "base", repo: "/repo", worktree: "/repo-wt", command: "x", commandHash: "cmd", ranAt: 0, ttlMs: 100, detail: "", artifacts: [] };
	expect(isFresh({ ...b, ok: true, commit: "abc" }, fp)).toBe(true);
	expect(isFresh({ ...b, ok: true, commit: "abc" }, { ...fp, tree: "other" })).toBe(false);
	expect(isFresh({ ...b, ok: true, commit: "abc", dirty: true }, fp)).toBe(false);
	expect(isFresh({ ...b, ok: true, commit: "abc" }, { ...fp, dirty: true })).toBe(false);
	expect(isFresh({ ...b, ok: false, commit: "abc" }, fp)).toBe(false);
	expect(isFresh(undefined, fp)).toBe(false);
	expect(isFresh({ ...b, ok: true, commit: "abc" }, { ...fp, now: 101 })).toBe(false);
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

test("proofGate: dirty same-commit tree invalidates a previously passing proof", async () => {
	const repo = await baseRepo();
	const wt = await branchWorktree(repo, "dirty-feat", "f.txt");
	await runProof({ repo, worktree: wt, command: "true" });
	expect(await proofGate(repo, wt, "dirty-feat")).toBeUndefined();

	await fs.writeFile(path.join(wt, "f.txt"), "changed but uncommitted\n");
	expect(await headCommit(wt)).toBe((await proofFor(repo, wt))?.commit);
	expect(await proofGate(repo, wt, "dirty-feat")).toMatch(/uncommitted changes/);
});

test("proofGate: an UNTRACKED file created after the proof blocks the land (commitWip would sweep it untested)", async () => {
	const repo = await baseRepo();
	const wt = await branchWorktree(repo, "untracked-feat", "f.txt");
	await runProof({ repo, worktree: wt, command: "true" });
	expect(await proofGate(repo, wt, "untracked-feat")).toBeUndefined();

	await fs.writeFile(path.join(wt, "brand-new.txt"), "never verified\n");
	expect(await proofGate(repo, wt, "untracked-feat")).toMatch(/uncommitted changes/);
});

test("proofGate: the daemon's own .omp/ evidence dir never dirties the fingerprint", async () => {
	const repo = await baseRepo();
	const wt = await branchWorktree(repo, "evidence-feat", "f.txt");
	await runProof({ repo, worktree: wt, command: "true" });

	await fs.mkdir(path.join(wt, ".omp", "proof"), { recursive: true });
	await fs.writeFile(path.join(wt, ".omp", "proof", "shot.png"), "png\n");
	expect(await proofGate(repo, wt, "evidence-feat")).toBeUndefined();
});

test("runProof refuses to record a passing proof for a dirty worktree", async () => {
	const repo = await baseRepo();
	const wt = await branchWorktree(repo, "dirty-proof", "f.txt");
	await fs.writeFile(path.join(wt, "f.txt"), "dirty before verify\n");
	const proof = await runProof({ repo, worktree: wt, command: "true" });
	expect(proof.ok).toBe(false);
	expect(proof.dirty).toBe(true);
	expect(proof.detail).toContain("uncommitted changes");
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

test("runProof on a MISSING worktree returns a failed proof and never throws (daemon-crash guard)", async () => {
	// Regression: a reaped/never-created worktree made Bun.spawn throw ENOENT, which surfaced as an
	// unhandled rejection from the orchestrator tick and crashed the whole daemon. runProof must be total.
	const gone = path.join(os.tmpdir(), `proof-gone-${Date.now()}`);
	const proof = await runProof({ repo: gone, worktree: gone, command: "true" });
	expect(proof.ok).toBe(false);
	expect(proof.detail).toContain("worktree missing");
});

test("runProof on a failing acceptance command returns ok:false without throwing", async () => {
	const repo = await baseRepo();
	const proof = await runProof({ repo, worktree: repo, command: "exit 3" });
	expect(proof.ok).toBe(false);
});

test("runProof stamps sandboxed:false on the host-fallback path (explicit host opt-out)", async () => {
	// Deterministic regardless of whether this box has docker: `host` forces the pre-sandbox host exec.
	const prev = process.env.OMP_SQUAD_GATE_SANDBOX;
	process.env.OMP_SQUAD_GATE_SANDBOX = "host";
	try {
		const repo = await baseRepo();
		const proof = await runProof({ repo, worktree: repo, command: "true" });
		expect(proof.ok).toBe(true);
		expect(proof.sandboxed).toBe(false); // an unsandboxed proof is stamped as the weaker proof it is
	} finally {
		if (prev === undefined) delete process.env.OMP_SQUAD_GATE_SANDBOX;
		else process.env.OMP_SQUAD_GATE_SANDBOX = prev;
	}
});

test("runProof stamps sandboxed:true when an explicit sandbox image is set (docker-independent)", async () => {
	// An explicit image always plans a `docker run`. We use a deliberately INVALID reference so the
	// spawn fails fast in ~50ms whether or not docker is installed (no network pull) — the point is
	// only that the record says sandboxed:true: the stamp reflects the PLAN, not the spawn outcome.
	const prev = process.env.OMP_SQUAD_GATE_SANDBOX;
	process.env.OMP_SQUAD_GATE_SANDBOX = "Invalid Image Ref";
	try {
		const repo = await baseRepo();
		const proof = await runProof({ repo, worktree: repo, command: "true" });
		expect(proof.sandboxed).toBe(true); // planned a container even though the run itself failed
		expect(proof.ok).toBe(false);
	} finally {
		if (prev === undefined) delete process.env.OMP_SQUAD_GATE_SANDBOX;
		else process.env.OMP_SQUAD_GATE_SANDBOX = prev;
	}
});

test("recordProof persists an already-run gate result as an inspectable proof of the merged main", async () => {
	const repo = await baseRepo();
	const rec = await recordProof({ repo, worktree: repo, command: "bun test", ok: true, detail: "post-merge", sandboxed: false });
	expect(rec.ok).toBe(true);
	expect(rec.commit).toBe(await headCommit(repo));
	expect(rec.sandboxed).toBe(false);
	const got = await proofFor(repo, repo);
	expect(got?.ok).toBe(true);
	expect(got?.detail).toBe("post-merge");
	expect(got?.command).toBe("bun test");
});
