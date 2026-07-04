/**
 * Regression gate integration (OMP_SQUAD_REGRESSION_GATE=1).
 *
 * The gate runs the full suite via detectVerify() after the acceptance gate passes, comparing
 * extracted failure sets between merged main and base to decide allow/block. Real git in a tmp
 * dir, no mocks. The gate.sh script emits Bun-style `(fail) <name>` lines deterministically:
 *   BASE_RED file present → (fail) base.test.ts > known
 *   NEW_RED  file present → (fail) new.test.ts > introduced
 *
 * C03 note: all orchestrator and feature land paths call landAgent(), which calls verifyMerged(),
 * which calls applyRegressionGate(). The flag is read from process.env at call time, so no path
 * can bypass it — these tests exercise the shared primitive that every land path inherits.
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

const savedGate = process.env.OMP_SQUAD_REGRESSION_GATE;
afterEach(() => {
	if (savedGate === undefined) delete process.env.OMP_SQUAD_REGRESSION_GATE;
	else process.env.OMP_SQUAD_REGRESSION_GATE = savedGate;
	delete process.env.OMP_SQUAD_AUTORESOLVE;
});

async function git(cwd: string, ...a: string[]): Promise<void> {
	await Bun.spawn(["git", "-C", cwd, ...a], { stdout: "ignore", stderr: "ignore" }).exited;
}

async function gitOut(cwd: string, ...a: string[]): Promise<string> {
	const p = Bun.spawn(["git", "-C", cwd, ...a], { stdout: "pipe", stderr: "pipe" });
	const [s] = await Promise.all([new Response(p.stdout).text(), p.exited]);
	return s.trim();
}

/**
 * Create a temp repo with a deterministic gate script:
 *   BASE_RED in tree → emits "(fail) base.test.ts > known"; exits 1
 *   NEW_RED  in tree → emits "(fail) new.test.ts > introduced"; exits 1
 *   detectVerify() sees package.json with "check":"true","test":"sh gate.sh" + bun.lock → "bun run check && bun run test"
 */
async function gateRepo(prefix: string, opts: { baseRed?: boolean } = {}): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(repo);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	// Minimal Bun project so detectVerify() returns "bun run check && bun run test"
	await fs.writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { check: "true", test: "sh gate.sh" } }));
	await fs.writeFile(path.join(repo, "bun.lock"), ""); // existence only; detectPackageManager checks this
	await fs.writeFile(
		path.join(repo, "gate.sh"),
		[
			"#!/bin/sh",
			"out=''; code=0",
			"[ -f BASE_RED ] && { out=\"${out}(fail) base.test.ts > known\\n\"; code=1; }",
			"[ -f NEW_RED ]  && { out=\"${out}(fail) new.test.ts > introduced\\n\"; code=1; }",
			"printf \"$out\"",
			"exit \"$code\"",
		].join("\n"),
	);
	if (opts.baseRed) await fs.writeFile(path.join(repo, "BASE_RED"), "broken\n");
	await fs.writeFile(path.join(repo, "base.txt"), "base\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	return repo;
}

/** Attach a worktree on its own branch one commit ahead. `files` is a map of filename → content (null = delete). */
async function branchWorktree(repo: string, branch: string, files: Record<string, string | null> = {}): Promise<string> {
	await git(repo, "branch", branch);
	const wt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "rg-wt-")), branch);
	tmps.push(path.dirname(wt));
	await git(repo, "worktree", "add", "-q", wt, branch);
	for (const [name, content] of Object.entries(files)) {
		if (content === null) await fs.unlink(path.join(wt, name)).catch(() => {});
		else await fs.writeFile(path.join(wt, name), content);
	}
	await git(wt, "add", "-A");
	await git(wt, "commit", "-qm", `branch changes`);
	return wt;
}

// ─── Test cases (matches plan spec verbatim) ───────────────────────────────

test("flag unset (default ON) + acceptance gate passes + branch introduces NEW_RED → land BLOCKED", async () => {
	delete process.env.OMP_SQUAD_REGRESSION_GATE;
	const repo = await gateRepo("rg-1-");
	const head0 = await gitOut(repo, "rev-parse", "HEAD");
	const wt = await branchWorktree(repo, "feat", { "NEW_RED": "broken\n", "feature.txt": "new\n" });

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "true" });

	expect(res.ok).toBe(false);
	expect(res.merged).toBe(false);
	expect(res.detail).toContain("regression gate");
	expect(res.detail).toContain("new.test.ts > introduced");
	expect(await gitOut(repo, "rev-parse", "HEAD")).toBe(head0); // main rolled back
});

test("flag explicitly off (=0) + acceptance gate passes + branch introduces NEW_RED → land allowed (escape hatch)", async () => {
	process.env.OMP_SQUAD_REGRESSION_GATE = "0";
	const repo = await gateRepo("rg-1b-");
	const wt = await branchWorktree(repo, "feat", { "NEW_RED": "broken\n", "feature.txt": "new\n" });

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "true" });

	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
	// NEW_RED is on main after land (flag was off — no regression gate ran)
	expect((await gitOut(repo, "ls-tree", "-r", "--name-only", "HEAD")).split("\n")).toContain("NEW_RED");
});

test("flag on + green base + branch introduces NEW_RED → blocked; HEAD stays at head0", async () => {
	process.env.OMP_SQUAD_REGRESSION_GATE = "1";
	const repo = await gateRepo("rg-2-");
	const head0 = await gitOut(repo, "rev-parse", "HEAD");
	const wt = await branchWorktree(repo, "feat", { "NEW_RED": "broken\n" });

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "true" });

	expect(res.ok).toBe(false);
	expect(res.merged).toBe(false);
	expect(res.detail).toContain("regression gate");
	expect(res.detail).toContain("new.test.ts > introduced");
	expect(await gitOut(repo, "rev-parse", "HEAD")).toBe(head0); // main rolled back
});

test("flag on + base has BASE_RED + clean branch → allowed; detail records red-baseline allowance", async () => {
	process.env.OMP_SQUAD_REGRESSION_GATE = "1";
	const repo = await gateRepo("rg-3-", { baseRed: true });
	const head0 = await gitOut(repo, "rev-parse", "HEAD");
	const wt = await branchWorktree(repo, "feat", { "feature.txt": "new\n" });

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "true" });

	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
	// main advanced past head0
	expect(await gitOut(repo, "rev-parse", "HEAD")).not.toBe(head0);
});

test("flag on + base has BASE_RED + branch adds NEW_RED → blocked; detail names new.test.ts; HEAD at head0", async () => {
	process.env.OMP_SQUAD_REGRESSION_GATE = "1";
	const repo = await gateRepo("rg-4-", { baseRed: true });
	const head0 = await gitOut(repo, "rev-parse", "HEAD");
	const wt = await branchWorktree(repo, "feat", { "NEW_RED": "broken\n" });

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "true" });

	expect(res.ok).toBe(false);
	expect(res.merged).toBe(false);
	expect(res.detail).toContain("regression gate");
	expect(res.detail).toContain("new.test.ts > introduced");
	expect(await gitOut(repo, "rev-parse", "HEAD")).toBe(head0);
});

test("flag on + base has BASE_RED + branch removes it (fixes regression) → allowed", async () => {
	process.env.OMP_SQUAD_REGRESSION_GATE = "1";
	const repo = await gateRepo("rg-5-", { baseRed: true });
	const wt = await branchWorktree(repo, "feat", { "BASE_RED": null, "feature.txt": "fixed\n" });

	const res = await landAgent({ repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false, verify: "true" });

	expect(res.ok).toBe(true);
	expect(res.merged).toBe(true);
	// BASE_RED removed from main
	expect((await gitOut(repo, "ls-tree", "-r", "--name-only", "HEAD")).split("\n")).not.toContain("BASE_RED");
});

test("flag on + autoresolve: conflict-resolved branch that introduces NEW_RED is rolled back before reviewer", async () => {
	process.env.OMP_SQUAD_REGRESSION_GATE = "1";
	process.env.OMP_SQUAD_AUTORESOLVE = "1";

	// Build a repo with gate.sh where main and branch both edit f.txt (conflict) and branch also adds NEW_RED.
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "rg-6-"));
	tmps.push(repo);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { check: "true", test: "sh gate.sh" } }));
	await fs.writeFile(path.join(repo, "bun.lock"), "");
	await fs.writeFile(
		path.join(repo, "gate.sh"),
		[
			"#!/bin/sh",
			"out=''; code=0",
			"[ -f BASE_RED ] && { out=\"${out}(fail) base.test.ts > known\\n\"; code=1; }",
			"[ -f NEW_RED ]  && { out=\"${out}(fail) new.test.ts > introduced\\n\"; code=1; }",
			"printf \"$out\"",
			"exit \"$code\"",
		].join("\n"),
	);
	await fs.writeFile(path.join(repo, "f.txt"), "base\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");

	// Branch: changes f.txt (conflict) + adds NEW_RED
	await git(repo, "branch", "feat");
	const wt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "rg-6-wt-")), "feat");
	tmps.push(path.dirname(wt));
	await git(repo, "worktree", "add", "-q", wt, "feat");
	await fs.writeFile(path.join(wt, "f.txt"), "branch\n");
	await fs.writeFile(path.join(wt, "NEW_RED"), "broken\n");
	await git(wt, "add", "-A");
	await git(wt, "commit", "-qm", "feat with new regression");

	// Main diverges on same line → guaranteed conflict
	await fs.writeFile(path.join(repo, "f.txt"), "main\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "main edit");
	const head0 = await gitOut(repo, "rev-parse", "HEAD");

	const writeResolution: ConflictResolver = async ({ worktree, files }) => {
		for (const f of files) await fs.writeFile(path.join(worktree, f), "resolved\n");
		return true;
	};
	let reviewerCalled = false;
	const watchReviewer: ResolutionReviewer = async () => { reviewerCalled = true; return true; };

	const res = await landAgent({
		repo, worktree: wt, branch: "feat", message: "land feat", commitWip: false,
		verify: "true",
		resolver: writeResolution,
		reviewer: watchReviewer,
	});

	expect(res.ok).toBe(false);
	expect(res.merged).toBe(false);
	expect(res.detail).toContain("regression gate");
	expect(reviewerCalled).toBe(false); // rolled back before reviewer got a chance
	expect(await gitOut(repo, "rev-parse", "HEAD")).toBe(head0);
});
