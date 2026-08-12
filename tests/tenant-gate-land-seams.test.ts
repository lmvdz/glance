import { afterAll, expect, test, describe } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { landAgent, runManifestLandGate } from "../src/land.ts";
import { setProofRoot, proofFor } from "../src/proof.ts";
import { resolveStateDir } from "../src/state-dir.ts";
import type { TenantGateManifest } from "../src/tenant-gates.ts";
import type { ManifestRunOutcome } from "../src/tenant-gate-run.ts";

/**
 * ROUND 2 — the manifest driven through the land SEAMS that reached green without it (gauntlet round
 * 1: C-1 auto-resolve, C-3 in-place, C-4 thrown runner). These use REAL git repos and the REAL
 * runner (host exec — the suite pins OMP_SQUAD_GATE_SANDBOX=host and the fixtures set
 * `sandboxStrict:false`), because the fail-closed matrix being proven only against stubs is exactly
 * why C-1/C-3 were invisible to a green suite. Each Critical is re-verified by flip-test: a gate that
 * refuses must leave main at head0 with no green proof; a gate that passes must land and record one.
 */

const tmps: string[] = [];
let proofDir = "";
afterAll(async () => {
	setProofRoot(resolveStateDir());
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

async function proofRoot(): Promise<void> {
	if (!proofDir) {
		proofDir = await fs.mkdtemp(path.join(os.tmpdir(), "seam-proof-"));
		tmps.push(proofDir);
	}
	setProofRoot(proofDir);
}

/** A repo on `main` with one base commit tracking a 10-line shared.txt. */
async function baseRepo(prefix: string): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(repo);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "shared.txt"), `${Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n")}\n`);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	return repo;
}

/** A gate whose command is a literal shell snippet — so a test dictates exact stdout + exit code. */
function shellGate(name: string, command: string, expects: TenantGateManifest["gates"][number]["expects"]): TenantGateManifest["gates"][number] {
	return { name, command, timeoutMs: 60_000, expects };
}
function manifestOf(repo: string, gates: TenantGateManifest["gates"]): TenantGateManifest {
	return { version: 1, repo, policy: { sandboxStrict: false }, gates };
}

// A resolver that clears the conflict by taking the branch's side, and a reviewer that approves —
// so the ONLY thing that can still refuse the auto-resolved land is the manifest gate.
const resolveToBranch = async ({ worktree, files }: { worktree: string; files: string[] }): Promise<boolean> => {
	for (const f of files) await fs.writeFile(path.join(worktree, f), "branch-resolved\n");
	return true;
};
const approve = async (): Promise<boolean> => true;

/** Base + a branch worktree and main both editing the SAME line ⇒ a merge conflict ⇒ auto-resolve. */
async function conflictingBranch(prefix: string): Promise<{ repo: string; wt: string; head0: string }> {
	const repo = await baseRepo(prefix);
	await git(repo, "branch", "unit");
	const wtParent = await fs.mkdtemp(path.join(os.tmpdir(), "seam-wt-"));
	tmps.push(wtParent);
	const wt = path.join(wtParent, "unit");
	await git(repo, "worktree", "add", "-q", wt, "unit");
	await fs.writeFile(path.join(wt, "shared.txt"), "branch change\n");
	await git(wt, "add", "-A");
	await git(wt, "commit", "-qm", "branch edit");
	// main edits the same file so the merge conflicts.
	await fs.writeFile(path.join(repo, "shared.txt"), "main change\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "main edit");
	const head0 = await out(repo, "rev-parse", "HEAD");
	return { repo, wt, head0 };
}

describe("C-1 · conflict auto-resolve runs the manifest fail-closed", () => {
	test("FLIP: a zero-tests gate on the auto-resolved merge REFUSES, restores head0, writes no green proof", async () => {
		await proofRoot();
		const { repo, wt, head0 } = await conflictingBranch("seam-c1-refuse-");
		// The receipt's exact flip: minTests:12, command prints a vitest zero-marker at exit 0.
		const manifest = manifestOf(repo, [shellGate("suite", "echo 'No test files found'", { exit: 0, parser: "vitest", minTests: 12 })]);

		const res = await landAgent({ repo, worktree: wt, branch: "unit", message: "land unit", commitWip: false, verify: "", manifest, resolver: resolveToBranch, reviewer: approve });

		expect(res.ok).toBe(false);
		expect(res.merged).toBe(false);
		expect(res.detail).toContain("REFUSED");
		expect(res.detail).toContain("zero-tests");
		// The load-bearing assertion: main is exactly where it started — the auto-resolved merge was undone.
		expect(await out(repo, "rev-parse", "HEAD")).toBe(head0);
		const proof = await proofFor(repo, repo);
		expect(proof?.ok).not.toBe(true); // no green post-merge proof for a refused land
	}, 60_000);

	test("PASS: a satisfied contract on the auto-resolved merge LANDS and records the contract hash", async () => {
		await proofRoot();
		const { repo, wt, head0 } = await conflictingBranch("seam-c1-pass-");
		const manifest = manifestOf(repo, [shellGate("suite", "echo ' Tests  12 passed (12)'", { exit: 0, parser: "vitest", minTests: 12 })]);

		const res = await landAgent({ repo, worktree: wt, branch: "unit", message: "land unit", commitWip: false, verify: "", manifest, resolver: resolveToBranch, reviewer: approve });

		expect(res.ok).toBe(true);
		expect(res.merged).toBe(true);
		expect(res.detail).toContain("verified against tenant contract");
		expect(await out(repo, "rev-parse", "HEAD")).not.toBe(head0); // main advanced — the land stuck
	}, 60_000);
});

describe("C-3 · in-place land (worktree === repo) runs the manifest", () => {
	test("FLIP: a failing gate on the in-place commit REFUSES — the old path returned ok:true before any gate", async () => {
		await proofRoot();
		const repo = await baseRepo("seam-c3-refuse-");
		await fs.writeFile(path.join(repo, "shared.txt"), "in-place edit\n"); // uncommitted change to sweep
		const ran = path.join(repo, "GATE_RAN"); // the gate touches this — proof it actually executed
		const manifest = manifestOf(repo, [shellGate("suite", `touch ${JSON.stringify(ran)}; echo 'Ran 0 tests'`, { exit: 0, parser: "bun-test", minTests: 5 })]);

		const res = await landAgent({ repo, worktree: repo, branch: "main", message: "in place", commitWip: true, verify: "", manifest });

		expect(res.ok).toBe(false);
		expect(res.detail).toContain("zero-tests");
		expect(await fs.exists(ran)).toBe(true); // the gate RAN (the C-3 defect was that it never did)
	}, 60_000);

	test("PASS: a satisfied gate on the in-place commit lands green and records a proof", async () => {
		await proofRoot();
		const repo = await baseRepo("seam-c3-pass-");
		await fs.writeFile(path.join(repo, "shared.txt"), "in-place edit\n");
		const manifest = manifestOf(repo, [shellGate("suite", "echo ' 7 pass'", { exit: 0, parser: "bun-test", minTests: 5 })]);

		const res = await landAgent({ repo, worktree: repo, branch: "main", message: "in place", commitWip: true, verify: "", manifest });

		expect(res.ok).toBe(true);
		expect(res.detail).toContain("verified against tenant contract");
		expect((await proofFor(repo, repo))?.ok).toBe(true);
	}, 60_000);

	test("an in-place land with NOTHING to commit does not invent a gate run", async () => {
		await proofRoot();
		const repo = await baseRepo("seam-c3-noop-");
		const manifest = manifestOf(repo, [shellGate("suite", "exit 1", { exit: 0, parser: "raw" })]);
		const res = await landAgent({ repo, worktree: repo, branch: "main", message: "noop", commitWip: true, verify: "", manifest });
		expect(res.ok).toBe(true); // nothing committed ⇒ nothing to gate
		expect(res.detail).toContain("no changes to commit");
	}, 60_000);
});

describe("C-4 · a thrown runner restores head0 (never leaves main merged on a throw)", () => {
	test("runManifestLandGate resets to rollbackTo when the runner throws, and refuses retryable", async () => {
		const repo = await baseRepo("seam-c4-");
		const head0 = await out(repo, "rev-parse", "HEAD");
		// Advance main (as a merge would have), then a runner that throws must restore head0.
		await fs.writeFile(path.join(repo, "shared.txt"), "merged\n");
		await git(repo, "add", "-A");
		await git(repo, "commit", "-qm", "pretend-merge");
		expect(await out(repo, "rev-parse", "HEAD")).not.toBe(head0);

		const throwingRunner = (): Promise<ManifestRunOutcome> => Promise.reject(new Error("EROFS: read-only file system, mkdtemp"));
		const manifest = manifestOf(repo, [shellGate("suite", "true", { exit: 0, parser: "raw" })]);
		const result = await runManifestLandGate({ manifest, repo, rollbackTo: head0, committed: true, message: "m", runner: throwingRunner });

		expect("refusal" in result).toBe(true);
		if (!("refusal" in result)) throw new Error("unreachable");
		expect(result.refusal.retryable).toBe(true);
		expect(result.refusal.detail).toContain("threw before it could judge");
		expect(await out(repo, "rev-parse", "HEAD")).toBe(head0); // main restored — not left merged
	}, 60_000);
});
