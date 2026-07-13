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

/** Resolved once, before any test shims PATH — the real `git` binary the shim delegates to. */
const REAL_GIT = Bun.which("git") ?? "/usr/bin/git";

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

	const finding = await staleBranchReason(repo, "unit");
	expect(finding?.reason).toContain("shared.txt");
	expect(finding?.reason).toContain("rebase");
	// eap-borrows audit fix: a GENUINE staleness finding (the probes all ran fine and found real
	// staleness+overlap) is never retryable — it's a real branch-vs-branch defect, not an
	// environmental hiccup, and must keep recording as a rejected outcome exactly as before.
	expect(finding?.retryable).toBe(false);

	// Fresh sibling branch forked from the CURRENT tip → not stale.
	await git(repo, "branch", "fresh");
	expect(await staleBranchReason(repo, "fresh")).toBeUndefined();
});

// Cross-lineage review (grok-4.5, eap-borrows) finding #4, control case: a genuinely orphan branch in
// a NON-shallow repo must keep reading as `undefined` (safe) — staleBranchReason's own doc explains
// why this axis differs from land-risk.ts's blast-radius gate: no common ancestor means no overlap, so
// no silent-clobber risk; the merge itself will surface whatever the orphan history actually contains.
// This proves the new shallow-repo guard (below) doesn't regress the ordinary case.
test("a genuine orphan branch (non-shallow repo) stays undefined — the merge path surfaces it, not this gate", async () => {
	const repo = await baseRepo("stale-orphan-");
	await git(repo, "checkout", "-q", "--orphan", "orphan-branch");
	await fs.writeFile(path.join(repo, "orphan.txt"), "unrelated history\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "orphan root");
	await git(repo, "checkout", "-q", "main");

	expect(await staleBranchReason(repo, "orphan-branch")).toBeUndefined();
});

// Finding #4 continued (shallow-clone twin): `git merge-base` emits the SAME exit-1/empty-streams
// signal for a shallow clone's independently-grafted branches as it does for a genuinely orphan
// branch — the carve-out above can't tell those apart, so a shallow repo must fail closed (probe
// failure, retryable:true) instead of reading it as "legitimately fresh". Reproduced with a REAL
// shallow clone (`git clone --depth 1 --no-single-branch`), not a mock of `--is-shallow-repository`.
test("shallow clone: the merge-base twin signal fails closed as a probe failure, not 'fresh'", async () => {
	const src = await baseRepo("stale-shallow-src-");
	await branchWorktree(src, "other", editSharedLine(1, "other branch edit"));

	const shallow = await fs.mkdtemp(path.join(os.tmpdir(), "stale-shallow-clone-"));
	tmps.push(shallow);
	const clone = Bun.spawnSync(["git", "clone", "-q", "--depth", "1", "--no-single-branch", `file://${src}`, shallow]);
	if (clone.exitCode !== 0) throw new Error("git clone --depth 1 failed");
	expect(new TextDecoder().decode(Bun.spawnSync(["git", "-C", shallow, "rev-parse", "--is-shallow-repository"]).stdout).trim()).toBe("true");

	const finding = await staleBranchReason(shallow, "origin/other");
	expect(finding).toBeDefined();
	expect(finding?.reason).toContain("stale-branch");
	expect(finding?.reason).toContain("SHALLOW clone");
	expect(finding?.retryable).toBe(true);
});

// finding #6 (eap-borrows wave 2): the ORIGINAL probe collapsed "genuinely fresh (fork point IS the
// tip)" and "the merge-base/rev-parse/diff probe itself FAILED" into the same `undefined` — a git
// hiccup silently let a genuinely stale, potentially clobbering merge through unchecked. Passing a
// baseRef that cannot be resolved at all reproduces a real probe failure (distinct from "no common
// ancestor", which staleBranchReason still treats as a legitimate non-stale outcome).
test("finding #6: a stale-branch PROBE FAILURE (unresolvable baseRef) blocks — does not silently read as fresh", async () => {
	const repo = await baseRepo("stale-probefail-");
	await branchWorktree(repo, "unit", editSharedLine(1, "branch edit"));

	const finding = await staleBranchReason(repo, "unit", "refs/heads/this-ref-does-not-exist-anywhere");

	// OLD behavior (fail-open): merge-base failure returned undefined (allow, "safe"). NEW behavior:
	// a distinct, non-`undefined` refusal — the caller (land.ts) blocks auto-land on it.
	expect(finding).toBeDefined();
	expect(finding?.reason).toContain("stale-branch");
	// eap-borrows audit fix: a probe FAILURE (couldn't prove anything either way) is a transient
	// environmental precondition, not a branch defect — it must be retryable so it never records as
	// a rejected task-outcome/model-outcome row (mirrors the dirty-main probe-failure polarity).
	expect(finding?.retryable).toBe(true);
});

// eap-borrows audit fix (polarity split): a probe FAILURE mid-land must surface as retryable:true on
// the LandResult itself, not just on the staleBranchReason return value — that's what actually gates
// squad-manager's outcome recording (`if (!result.retryable) …` writes a rejected task/model-outcome
// row; `else if (result.retryable) …` routes through fileLandBlockedFinding's blocked bucket instead,
// see land-blocked-recording.test.ts for the generic mechanism keyed purely on this flag). Repro: shim
// `git` on PATH so the FIRST `diff --name-only <mb>..HEAD` call (staleBranchReason's baseDiff probe,
// the exact spawn `classifyProbeFailure` models) fails with a transient error while every OTHER git
// invocation — including the merge that follows — behaves normally, delegating to the real binary.
test("probe FAILURE mid-land threads retryable:true onto the LandResult and rolls main back (does not silently allow OR permanently reject)", async () => {
	const repo = await baseRepo("stale-live-probefail-");
	const wt = await branchWorktree(repo, "unit", editSharedLine(1, "branch edit"));
	await advanceMain(repo, editSharedLine(20, "main evolved"));
	const head0 = await out(repo, "rev-parse", "HEAD");

	const shimDir = await fs.mkdtemp(path.join(os.tmpdir(), "git-shim-"));
	tmps.push(shimDir);
	await fs.writeFile(
		path.join(shimDir, "git"),
		`#!/usr/bin/env bash\nargs=("$@")\nlast="\${args[-1]}"\njoined=" \${args[*]} "\nif [[ "$joined" == *" diff "* && "$joined" == *" --name-only "* && "$last" == *"..HEAD" ]]; then\n  echo "fatal: simulated transient git failure (test probe hiccup)" >&2\n  exit 1\nfi\nexec ${REAL_GIT} "$@"\n`,
		{ mode: 0o755 },
	);

	const savedPath = process.env.PATH;
	process.env.PATH = `${shimDir}:${savedPath}`;
	let res: Awaited<ReturnType<typeof landAgent>>;
	try {
		res = await landAgent({ repo, worktree: wt, branch: "unit", message: "land unit", commitWip: false, verify: "" });
	} finally {
		process.env.PATH = savedPath;
	}

	expect(res.ok).toBe(false);
	expect(res.merged).toBe(false);
	expect(res.retryable).toBe(true);
	expect(res.detail).toContain("stale-branch");
	// Main was rolled back to head0 exactly like a genuine staleness finding — a probe failure must
	// never leave a possibly-clobbering clean merge sitting on main.
	expect(await out(repo, "rev-parse", "HEAD")).toBe(head0);
});

// eap-borrows audit fix, outcome-recording level: drives the SAME probe-failure repro through the
// REAL `SquadManager.land()` path (not landAgent in isolation) — the level at which "rejected
// task-outcome/model-outcome row" actually gets written. Mirrors land-blocked-recording.test.ts's
// TestManager/seedAgent convention exactly; a genuine staleness finding is the CONTROL, proving the
// non-retryable arm is untouched (still records `rejected`).
test("SquadManager.land(): a stale-probe FAILURE records `blocked` (never `rejected`) — a GENUINE stale finding still records `rejected` unchanged", async () => {
	const { modelOutcomes } = await import("../src/model-outcomes.ts");
	const { landFailureCount } = await import("../src/land-ledger.ts");
	const { recordProof } = await import("../src/proof.ts");
	const { SquadManager } = await import("../src/squad-manager.ts");
	const { SubagentTracker } = await import("../src/subagents.ts");
	type SM = InstanceType<typeof SquadManager>;

	class TestManager extends SquadManager {
		protected resolveLandModeFor(_repo: string): Promise<{ mode: "pr" | "local"; defaultBranch?: string; reason: string }> {
			return Promise.resolve({ mode: "local", reason: "forced local for stale-gate recording test" });
		}
	}

	function seedAgent(mgr: SM, id: string, repo: string, worktree: string, branch: string): void {
		const dto = {
			id, name: id, status: "idle" as const, kind: "omp-operator" as const, repo, worktree, branch,
			approvalMode: "yolo" as const, pending: [], lastActivity: 0, messageCount: 0,
		};
		const options = { id, name: id, repo, worktree, approvalMode: "yolo" as const };
		// biome-ignore lint: mirrors land-blocked-recording.test.ts's seedAgent exactly
		mgr.agents.set(id, { dto, agent: undefined as never, options, transcript: [], assistantBuf: "", streaming: false, subs: new SubagentTracker() });
	}

	// `force:true` also flips `staleGate: !force` off in SquadManager.land() (a human override clears
	// EVERY gate, stale included) — so reaching the stale gate through the real manager needs a
	// non-forced land with a fresh recorded proof (`requireProof: !force` still gates it). `auto`
	// defaults to true (unset here) — the confidence hold only fires when `dto.confidence` is set
	// (our seeded dto never sets it, so the hold never triggers), and `auto:true` is required for the
	// "rejected" write below (`if (!result.retryable && (auto || result.ok))`).
	async function operatorLand(mgr: SM, repo: string, wt: string): Promise<Awaited<ReturnType<SM["land"]>>> {
		await recordProof({ repo, worktree: wt, command: "test-proof", ok: true, detail: "seeded for stale-gate recording test" });
		return mgr.land("a1", undefined, { reason: "stale-gate recording test" });
	}

	// ── Case 1: probe failure (shimmed git) → blocked, NOT rejected ────────────────────────────────
	{
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "stale-rec-probefail-state-"));
		tmps.push(stateDir);
		const repo = await baseRepo("stale-rec-probefail-repo-");
		const wt = await branchWorktree(repo, "unit", editSharedLine(1, "branch edit"));
		await advanceMain(repo, editSharedLine(20, "main evolved"));

		const shimDir = await fs.mkdtemp(path.join(os.tmpdir(), "git-shim-rec-"));
		tmps.push(shimDir);
		await fs.writeFile(
			path.join(shimDir, "git"),
			`#!/usr/bin/env bash\nargs=("$@")\nlast="\${args[-1]}"\njoined=" \${args[*]} "\nif [[ "$joined" == *" diff "* && "$joined" == *" --name-only "* && "$last" == *"..HEAD" ]]; then\n  echo "fatal: simulated transient git failure (test probe hiccup)" >&2\n  exit 1\nfi\nexec ${REAL_GIT} "$@"\n`,
			{ mode: 0o755 },
		);

		const mgr = new TestManager({ stateDir });
		seedAgent(mgr, "a1", repo, wt, "unit");

		const savedPath = process.env.PATH;
		process.env.PATH = `${shimDir}:${savedPath}`;
		let result: Awaited<ReturnType<SM["land"]>>;
		try {
			result = await operatorLand(mgr, repo, wt);
		} finally {
			process.env.PATH = savedPath;
		}

		expect(result.ok).toBe(false);
		expect(result.retryable).toBe(true);
		// The environmental-refusal bucket got the count; landed/rejected stayed at zero.
		expect(modelOutcomes(stateDir, undefined, "mid")).toEqual({ landed: 0, rejected: 0, blocked: 1 });
		// A probe hiccup must never park a healthy branch's failure streak either.
		expect(landFailureCount(stateDir, "unit")).toBe(0);
	}

	// ── Case 2 (control): genuine staleness, no shim → rejected, unchanged from before this fix ────
	{
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "stale-rec-genuine-state-"));
		tmps.push(stateDir);
		const repo = await baseRepo("stale-rec-genuine-repo-");
		const wt = await branchWorktree(repo, "unit", editSharedLine(1, "branch edit"));
		await advanceMain(repo, editSharedLine(20, "main evolved"));

		const mgr = new TestManager({ stateDir });
		seedAgent(mgr, "a1", repo, wt, "unit");

		const result = await operatorLand(mgr, repo, wt);

		expect(result.ok).toBe(false);
		expect(result.retryable).toBeFalsy();
		expect(modelOutcomes(stateDir, undefined, "mid")).toEqual({ landed: 0, rejected: 1 });
		expect(landFailureCount(stateDir, "unit")).toBe(1);
	}
});
