/**
 * eap-borrows follow-up 7 — Part B of the validator "abstain" hole: `computeLandDiff` used to return
 * `""` on BOTH a genuine no-op land AND a real git FAILURE (an unresolvable base, or the `diff` command
 * itself exiting non-zero), so `scoreAgainstCriteria` silently abstained on an environmental hiccup —
 * and an abstain LANDS, meaning a unit with declared acceptance criteria could land with NO semantic
 * check at all just because git hiccuped mid-land. (Part A — an unreachable/unparseable JUDGE abstaining
 * — was adjudicated WORKING AS DESIGNED in plans/eap-borrows/07-fail-closed-wave-2.md and is untouched.)
 *
 * Fix: `computeLandDiff` now returns `string | null` (`null` ⇐ a real failure, distinct from a computed-
 * and-empty `""`), `validatorGate` turns a `null` diff WITH declared criteria into a new `"inconclusive"`
 * verdict (never cached — see validator.ts), and `SquadManager.runValidatorGate` turns that into a
 * RETRYABLE `LandResult` (never a silent pass, never a permanent park) — the exact same bounded-
 * escalation lane every other environmental land refusal already uses.
 *
 * Real git in tmp dirs, real git FAULTS via a PATH shim (mirrors land-stale-gate.test.ts's convention;
 * no return-value stubs) — the shim fails ONLY `computeLandDiff`'s primary `diff --no-ext-diff
 * <base>...HEAD` call (discriminated by `--no-ext-diff` + a `...HEAD` tail), delegating every other git
 * invocation, including the merge that follows on a healthy retry, to the real binary.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runProof } from "../src/proof.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SubagentTracker } from "../src/subagents.ts";
import type { AgentDTO, PersistedAgent, PersistedFeature } from "../src/types.ts";
import { validatorGate, type Judge } from "../src/validator.ts";

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function tmpDir(prefix: string): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(d);
	return d;
}

/** Resolved once, before any test shims PATH — the real `git` binary the shim delegates to. */
const REAL_GIT = Bun.which("git") ?? "/usr/bin/git";

async function git(cwd: string, ...a: string[]): Promise<void> {
	await Bun.spawn(["git", ...a], { cwd, stdout: "ignore", stderr: "ignore" }).exited;
}

async function gitOut(cwd: string, ...a: string[]): Promise<string> {
	const p = Bun.spawn(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
	const [s] = await Promise.all([new Response(p.stdout).text(), p.exited]);
	return s.trim();
}

/** A repo on `main` with one base commit, plus a worktree branched off it with one committed file — a
 *  real, non-empty diff so `computeLandDiff`'s PRIMARY path (not the in-place recovery branch) is the
 *  one exercised, matching validator-land-gate.test.ts's `repoWithBranch` convention. */
async function repoWithBranch(prefix: string): Promise<{ repo: string; worktree: string; branch: string }> {
	const repo = await tmpDir(prefix);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "base.txt"), `base ${prefix}\n`);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	const branch = "squad/vfault";
	const worktree = path.join(await tmpDir(`${prefix}wt-`), "wt");
	await git(repo, "worktree", "add", "-q", "-b", branch, worktree, "main");
	await fs.writeFile(path.join(worktree, "feature.txt"), `new ${prefix}\n`);
	await git(worktree, "add", "-A");
	await git(worktree, "commit", "-qm", "add feature");
	return { repo, worktree, branch };
}

/** A shimmed `git` on PATH that fails ONLY `computeLandDiff`'s primary diff call (`--no-ext-diff` +
 *  three-dot `...HEAD` range) with a real non-zero exit — everything else delegates to the real binary. */
async function installDiffFaultShim(): Promise<{ dir: string; restore: () => void }> {
	const dir = await tmpDir("git-shim-difffault-");
	await fs.writeFile(
		path.join(dir, "git"),
		`#!/usr/bin/env bash\nargs=("$@")\nlast="\${args[-1]}"\njoined=" \${args[*]} "\nif [[ "$joined" == *" --no-ext-diff "* && "$last" == *"...HEAD" ]]; then\n  echo "fatal: simulated transient git failure (test probe hiccup)" >&2\n  exit 1\nfi\nexec ${REAL_GIT} "$@"\n`,
		{ mode: 0o755 },
	);
	const saved = process.env.PATH;
	process.env.PATH = `${dir}:${saved}`;
	return { dir, restore: () => { process.env.PATH = saved; } };
}

const CRITERIA = [
	{ id: "c1", text: "adds the endpoint", completed: false },
	{ id: "c2", text: "the endpoint is authenticated", completed: false },
];

/** Would veto if ever actually invoked — proves the judge is never reached on an inconclusive diff. */
const vetoJudgeIfCalled: Judge = async () => ({ perCriterion: [{ id: "c1", satisfied: true }, { id: "c2", satisfied: false, note: "auth missing" }], confidence: 0.8, rationale: "should never be called" });

// ── validatorGate() unit level ──────────────────────────────────────────────────────────────────────

test('a real git diff FAILURE with declared criteria ⇒ verdict "inconclusive" (never a silent abstain-and-land, never a veto)', async () => {
	const { repo, worktree } = await repoWithBranch("vfault-unit-");
	const shim = await installDiffFaultShim();
	try {
		const { record, veto, inconclusive } = await validatorGate({ criteria: CRITERIA, repo, worktree, judge: vetoJudgeIfCalled });
		expect(record.verdict).toBe("inconclusive");
		expect(veto).toBeUndefined();
		expect(inconclusive).toBeDefined();
		expect(inconclusive).toContain("could not be computed");
	} finally {
		shim.restore();
	}
});

test("an inconclusive verdict is NEVER cached — a retry on the SAME proof re-attempts the diff instead of replaying the stale fault forever", async () => {
	const { repo, worktree } = await repoWithBranch("vfault-nocache-");
	const baseCommit = await gitOut(repo, "rev-parse", "HEAD");
	// Deliberately DISTINCT from validator-land-gate.test.ts's fake proof literal ("deadbeef"/"cafef00d")
	// — the gateCache is module-level state shared across test FILES in one `bun test` process; reusing
	// that exact (commit,tree,criteria) key would let this test's cache entry silently satisfy (or be
	// satisfied by) the OTHER file's caching test instead of exercising its own.
	const proof = { ok: true, commit: "difffault-c0mm1t", tree: "difffault-tr33", branch: "b", dirty: false, baseCommit, repo, worktree, command: "test", commandHash: "h", ranAt: 1, ttlMs: 1000, detail: "", artifacts: [] };
	const passJudge: Judge = async () => ({ perCriterion: [{ id: "c1", satisfied: true }, { id: "c2", satisfied: true }] });

	const shim = await installDiffFaultShim();
	let first: Awaited<ReturnType<typeof validatorGate>>;
	try {
		first = await validatorGate({ criteria: CRITERIA, repo, worktree, proof, judge: passJudge });
	} finally {
		shim.restore();
	}
	expect(first.record.verdict).toBe("inconclusive");

	// SAME (commit,tree) cache key, but the git fault is gone now — a cached "inconclusive" would replay
	// forever and wedge every future retry; the fix must re-attempt and resolve normally instead.
	const second = await validatorGate({ criteria: CRITERIA, repo, worktree, proof, judge: passJudge });
	expect(second.record.verdict).toBe("pass");
});

test("control: a GENUINE empty diff (in-place, no upstream) still abstains and is NOT reclassified as inconclusive", async () => {
	// worktree === repo, no commits on top, no upstream configured — computeLandDiff's honest-abstain
	// path, untouched by this fix.
	const repo = await tmpDir("vfault-genuine-empty-");
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "base.txt"), "base\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");

	const { record, veto, inconclusive } = await validatorGate({ criteria: CRITERIA, repo, worktree: repo, judge: vetoJudgeIfCalled });
	expect(record.verdict).toBe("abstain");
	expect(veto).toBeUndefined();
	expect(inconclusive).toBeUndefined();
});

// ── SquadManager.land() level — the wedge-avoidance proof ──────────────────────────────────────────

class TestManager extends SquadManager {
	judge: Judge | undefined;
	protected validatorJudgeOverride(): Judge | undefined {
		return this.judge;
	}
	protected resolveLandModeFor(_repo: string): Promise<{ mode: "pr" | "local"; defaultBranch?: string; reason: string }> {
		return Promise.resolve({ mode: "local", reason: "forced local for diff-fault test" });
	}
}

function seedAgent(mgr: SquadManager, id: string, repo: string, worktree: string, branch: string, featureId?: string): void {
	const dto: AgentDTO = {
		id, name: id, status: "idle", kind: "omp-operator", repo, worktree, branch,
		approvalMode: "yolo", pending: [], lastActivity: 0, messageCount: 0, featureId,
	};
	const options: PersistedAgent = { id, name: id, repo, worktree, approvalMode: "yolo" };
	mgr.agents.set(id, { dto, agent: undefined as never, options, transcript: [], assistantBuf: "", streaming: false, subs: new SubagentTracker() });
}

test("SquadManager.land(): a diff-computation FAILURE is retryable and never lands — declared criteria are never silently skipped by a git hiccup", async () => {
	const stateDir = await tmpDir("vfault-mgr-state-");
	const { repo, worktree, branch } = await repoWithBranch("vfault-mgr-");
	const mgr = new TestManager({ stateDir });
	let judgeCalls = 0;
	// Always PASSES when actually invoked — isolates the assertion to "was the judge reached at all",
	// which is the thing an inconclusive-diff fault must prevent (never a fabricated veto OR pass).
	mgr.judge = async () => {
		judgeCalls++;
		return { perCriterion: [{ id: "c1", satisfied: true }, { id: "c2", satisfied: true }] };
	};
	seedAgent(mgr, "a1", repo, worktree, branch, "f1");
	(mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore.set("f1", { id: "f1", title: "F1", repo, createdAt: 0, updatedAt: 0, acceptanceCriteria: CRITERIA });
	await runProof({ repo, worktree, command: "true" });

	const shim = await installDiffFaultShim();
	let result: Awaited<ReturnType<SquadManager["land"]>>;
	try {
		result = await mgr.land("a1", undefined, {});
	} finally {
		shim.restore();
	}

	expect(result.ok).toBe(false);
	expect(result.merged).toBe(false);
	expect(result.retryable).toBe(true);
	expect(result.detail).toContain("inconclusive");
	expect(mgr.agents.get("a1")?.dto.validation?.verdict).toBe("inconclusive");
	// Not landed, not vetoed, not silently passed — the judge was never even reached.
	expect(result.detail).not.toContain("validator veto");
	expect(judgeCalls).toBe(0);

	// The wedge-avoidance proof: once the environment recovers (shim removed), the SAME unit's retry
	// re-computes the diff, reaches the real judge, and lands — an "inconclusive" hold always clears
	// (nothing caches it), it never permanently parks the branch the way a genuine veto or a stale-branch
	// finding would.
	const retry = await mgr.land("a1", undefined, {});
	expect(retry.ok).toBe(true);
	expect(retry.merged).toBe(true);
	expect(judgeCalls).toBe(1);
});
