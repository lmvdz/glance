/**
 * Conflict-marker gate wired into the land path (#330, per #327's resolution) — drives the REAL
 * `landAgent` end to end (real temp git repos, no mocks), covering both call sites:
 *   1. the ordinary pre-merge check in `landAgentImpl` (a branch that already carries a live marker
 *      line before any conflict ever happens), and
 *   2. the auto-resolve path in `attemptAutoResolve` (the scenario the ticket actually names: an
 *      AUTORESOLVE resolver — real or injected here — writes a "resolution" that still leaves live
 *      conflict-marker debris behind, which the verify gate's typecheck/test alone would never catch
 *      for a .md/.json/.txt file).
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ConflictResolver, landAgent, type ResolutionReviewer } from "../src/land.ts";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

const savedAuto = process.env.OMP_SQUAD_AUTORESOLVE;
afterEach(() => {
	if (savedAuto === undefined) delete process.env.OMP_SQUAD_AUTORESOLVE;
	else process.env.OMP_SQUAD_AUTORESOLVE = savedAuto;
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
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(repo);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "README.md"), "seed\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	return repo;
}

async function branchWorktree(repo: string, branch: string, edit: (wt: string) => Promise<void>): Promise<string> {
	await git(repo, "branch", branch);
	const wt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "cm-wt-")), branch);
	tmps.push(path.dirname(wt));
	await git(repo, "worktree", "add", "-q", wt, branch);
	await edit(wt);
	await git(wt, "add", "-A");
	await git(wt, "commit", "-qm", `branch ${branch}`);
	return wt;
}

// ── 1. Ordinary (non-conflicting) path: a branch that already carries a live marker ─────────────────

test("a branch adding a live conflict marker in a changed .md file is refused, main untouched", async () => {
	const repo = await baseRepo("cm-plain-");
	const head0 = await out(repo, "rev-parse", "HEAD");
	const wt = await branchWorktree(repo, "feat", async (dir) => {
		await fs.mkdir(path.join(dir, "docs"), { recursive: true });
		await fs.writeFile(path.join(dir, "docs", "plan.md"), ["# Plan", "", "<<<<<<< HEAD", "old approach", "=======", "new approach", ">>>>>>> feat", ""].join("\n"));
	});

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "" });

	expect(res.ok).toBe(false);
	expect(res.merged).toBe(false);
	expect(res.detail).toContain("conflict-markers gate:");
	expect(res.detail).toContain("docs/plan.md");
	expect(await out(repo, "rev-parse", "HEAD")).toBe(head0); // nothing merged, main untouched
});

test("a clean branch (no markers) lands normally — the gate never blocks ordinary work", async () => {
	const repo = await baseRepo("cm-clean-");
	const wt = await branchWorktree(repo, "feat", async (dir) => fs.writeFile(path.join(dir, "src.ts"), "export const a = 1;\n"));

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "" });

	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
});

test("conflictMarkerGate:false (force-land) merges a branch carrying markers", async () => {
	const repo = await baseRepo("cm-forced-");
	const wt = await branchWorktree(repo, "feat", async (dir) => fs.writeFile(path.join(dir, "notes.md"), ["<<<<<<< HEAD", "a", "=======", "b", ">>>>>>> feat", ""].join("\n")));

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "", conflictMarkerGate: false });

	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
});

test("OMP_SQUAD_CONFLICT_MARKER_GATE=0 disables the gate globally", async () => {
	const repo = await baseRepo("cm-envoff-");
	const wt = await branchWorktree(repo, "feat", async (dir) => fs.writeFile(path.join(dir, "notes.md"), ["<<<<<<< HEAD", "a", "=======", "b", ">>>>>>> feat", ""].join("\n")));

	process.env.OMP_SQUAD_CONFLICT_MARKER_GATE = "0";
	try {
		const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "" });
		expect(res.ok).toBe(true);
		expect(res.merged).toBe(true);
	} finally {
		delete process.env.OMP_SQUAD_CONFLICT_MARKER_GATE;
	}
});

// ── 2. The AUTORESOLVE path: the ticket's actual scenario ────────────────────────────────────────────
// A real divergent conflict, resolved by an injected "resolver" that (like a careless LLM resolver)
// writes a .md file that is perfectly valid content and would sail through typecheck+test, but still
// carries live `<<<<<<<`/`=======`/`>>>>>>>` debris. Only a textual scan catches this.

async function conflictRepo(fileName: string): Promise<{ repo: string; wt: string }> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "cm-ar-"));
	tmps.push(repo);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, fileName), "base\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");

	await git(repo, "branch", "feat");
	const wt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "cm-ar-wt-")), "feat");
	tmps.push(path.dirname(wt));
	await git(repo, "worktree", "add", "-q", wt, "feat");
	await fs.writeFile(path.join(wt, fileName), "branch version\n");
	await git(wt, "add", "-A");
	await git(wt, "commit", "-qm", "feat edit");

	await fs.writeFile(path.join(repo, fileName), "main version\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "main edit");
	return { repo, wt };
}

async function mainFile(repo: string, fileName: string): Promise<string> {
	return (await fs.readFile(path.join(repo, fileName), "utf8")).trim();
}

/** The bug this ticket closes: a "resolver" (standing in for an LLM) that reports success while
 *  leaving live conflict-marker debris in a doc file that still parses/compiles fine. */
const resolverLeavesMarkers: ConflictResolver = async ({ worktree, files }) => {
	for (const f of files) await fs.writeFile(path.join(worktree, f), ["<<<<<<< HEAD", "branch version", "=======", "main version", ">>>>>>> feat", ""].join("\n"));
	return true;
};
const resolverIsClean: ConflictResolver = async ({ worktree, files }) => {
	for (const f of files) await fs.writeFile(path.join(worktree, f), "properly resolved\n");
	return true;
};
const approve: ResolutionReviewer = async () => true;

test("AUTORESOLVE: a resolver that leaves live markers in a .md is refused, main rolled back", async () => {
	process.env.OMP_SQUAD_AUTORESOLVE = "1";
	const { repo, wt } = await conflictRepo("plan.md");
	const head0 = await out(repo, "rev-parse", "HEAD");

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "true", resolver: resolverLeavesMarkers, reviewer: approve });

	expect(res.ok).toBe(false);
	expect(res.merged).toBe(false);
	expect(res.detail).toContain("auto-resolve:");
	expect(res.detail).toContain("conflict-markers gate:");
	expect(await out(repo, "rev-parse", "HEAD")).toBe(head0); // main never advanced past head0
});

test("AUTORESOLVE: a genuinely clean resolution still lands (the gate never blocks a real fix)", async () => {
	process.env.OMP_SQUAD_AUTORESOLVE = "1";
	const { repo, wt } = await conflictRepo("plan.md");

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "true", resolver: resolverIsClean, reviewer: approve });

	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
	expect(await mainFile(repo, "plan.md")).toBe("properly resolved");
});

test("AUTORESOLVE: conflictMarkerGate:false (force-land) keeps a marker-laden auto-resolved merge", async () => {
	process.env.OMP_SQUAD_AUTORESOLVE = "1";
	const { repo, wt } = await conflictRepo("plan.md");

	const res = await landAgent({
		repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "true",
		resolver: resolverLeavesMarkers, reviewer: approve, conflictMarkerGate: false,
	});

	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
});
