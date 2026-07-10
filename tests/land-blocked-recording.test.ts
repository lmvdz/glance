/**
 * Blocked-land recording (research-sirvir/01-recording-unlock, part 2) — the durable decoupling of the
 * "cheap, always-on" model-outcome statistic from the retryable land gate.
 *
 * The live incident this guards against: the fleet's ONLY land failure mode for days was the retryable
 * dirty-main refusal (land.ts "uncommitted tracked changes"), and squad-manager's record branch was
 * gated `if (!result.retryable && (auto || result.ok))` — so NOTHING was ever recorded (not landed, not
 * rejected, not even "we tried") and every learning ledger sat empty while land-failures.json silently
 * grew. The fix records a retryable refusal in its OWN `blocked` bucket (never landed/rejected — a
 * dirty main is not the model's fault) and routes it loudly through the automation log + factory
 * status. These tests drive the REAL `SquadManager.land()` path over real git repos (the
 * land-seam.test.ts convention) — not the ledger helpers in isolation — so re-coupling the statistic
 * to `!retryable` in squad-manager.ts fails them even if model-outcomes.ts itself is untouched.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { landFailureCount } from "../src/land-ledger.ts";
import { modelOutcomes } from "../src/model-outcomes.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SubagentTracker } from "../src/subagents.ts";
import type { AgentDTO, PersistedAgent } from "../src/types.ts";

/** Force local land mode via the `resolveLandModeFor` seam (same rationale as land-seam.test.ts:
 *  another file's `mock.module` of land-mode.ts would otherwise leak into this suite). */
class TestManager extends SquadManager {
	protected resolveLandModeFor(_repo: string): Promise<{ mode: "pr" | "local"; defaultBranch?: string; reason: string }> {
		return Promise.resolve({ mode: "local", reason: "forced local for blocked-recording test" });
	}
}

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function tmpDir(prefix: string): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(d);
	return d;
}

async function git(cwd: string, ...a: string[]): Promise<void> {
	await Bun.spawn(["git", "-C", cwd, ...a], { stdout: "ignore", stderr: "ignore" }).exited;
}

async function baseRepo(prefix: string): Promise<string> {
	const repo = await tmpDir(prefix);
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
	const dir = path.join(await tmpDir(`${branch.replace(/\//g, "-")}-wt-`), "wt");
	await git(repo, "worktree", "add", "-q", "-b", branch, dir, "main");
	await fs.writeFile(path.join(dir, file), `${file}\n`);
	await git(dir, "add", "-A");
	await git(dir, "commit", "-qm", `add ${file}`);
	return dir;
}

function seedAgent(mgr: SquadManager, id: string, repo: string, worktree: string, branch: string): void {
	const dto: AgentDTO = {
		id,
		name: id,
		status: "idle",
		kind: "omp-operator",
		repo,
		worktree,
		branch,
		approvalMode: "yolo",
		pending: [],
		lastActivity: 0,
		messageCount: 0,
	};
	const options: PersistedAgent = { id, name: id, repo, worktree, approvalMode: "yolo" };
	mgr.agents.set(id, { dto, agent: undefined as never, options, transcript: [], assistantBuf: "", streaming: false, subs: new SubagentTracker() });
}

test("REGRESSION: a retryable dirty-main refusal records a `blocked` model outcome — the statistic must never be re-coupled to !retryable", async () => {
	const stateDir = await tmpDir("blocked-rec-state-");
	const repo = await baseRepo("blocked-rec-repo-");
	const wt = await branchWorktree(repo, "squad/a1", "x.txt");
	const mgr = new TestManager({ stateDir });
	seedAgent(mgr, "a1", repo, wt, "squad/a1");

	// Uncommitted TRACKED change in the main checkout — the exact live failure mode (113-file dirty
	// main) that starved all three learning ledgers. land.ts refuses this as retryable:true.
	await fs.writeFile(path.join(repo, "base.txt"), "base\nLOCAL UNCOMMITTED WORK\n");

	const result = await mgr.land("a1", undefined, { force: true, reason: "blocked-recording test" });

	expect(result.ok).toBe(false);
	expect(result.retryable).toBe(true);

	// The decoupled statistic: attempted-but-couldn't-land-cleanly lands in its OWN bucket…
	// (dto.model undefined → "default"; thinking undefined → "mid")
	expect(modelOutcomes(stateDir, undefined, "mid")).toEqual({ landed: 0, rejected: 0, blocked: 1 });
	// …and the landed/rejected land-rate signal the model router reads stays EXACTLY untouched:
	// no key in the ledger carries a landed or rejected count from an environmental refusal.
	const entry = modelOutcomes(stateDir, undefined, "mid");
	expect(entry.landed).toBe(0);
	expect(entry.rejected).toBe(0);
	// The branch failure streak is also untouched (pre-existing behavior, re-asserted: a retryable
	// refusal must never park a healthy branch).
	expect(landFailureCount(stateDir, "squad/a1")).toBe(0);
});

test("THROTTLE: the same dirty-main episode retried N times records blocked:1 and ONE warn row — not N (the orchestrator retries every ~30s)", async () => {
	const stateDir = await tmpDir("blocked-throttle-state-");
	const repo = await baseRepo("blocked-throttle-repo-");
	const wt = await branchWorktree(repo, "squad/a1", "x.txt");
	const mgr = new TestManager({ stateDir });
	seedAgent(mgr, "a1", repo, wt, "squad/a1");
	await fs.writeFile(path.join(repo, "base.txt"), "base\nLOCAL UNCOMMITTED WORK\n");

	// Same episode (same repo, branch, head, reason) driven three times — the tick-retry shape.
	for (let i = 0; i < 3; i++) {
		const r = await mgr.land("a1", undefined, { force: true, reason: `throttle test ${i}` });
		expect(r.retryable).toBe(true);
	}

	// Counter is edge-triggered per episode: 1, not 3.
	expect(modelOutcomes(stateDir, undefined, "mid")).toEqual({ landed: 0, rejected: 0, blocked: 1 });
	// Warn rows are cooldown-throttled per repo condition: 1, not 3.
	expect(mgr.automationActivity({ loop: "land" }).events.length).toBe(1);
	// The banner is still up off that single fresh row.
	expect(mgr.factoryStatus().landBlocked.blocked).toBe(true);
});

test("THROTTLE: a cooldown-expired repeat re-emits the warn (the banner's freshness feed), while the counter stays edge-triggered at 1", async () => {
	const stateDir = await tmpDir("blocked-reemit-state-");
	const repo = await baseRepo("blocked-reemit-repo-");
	const wt = await branchWorktree(repo, "squad/a1", "x.txt");
	const mgr = new TestManager({ stateDir });
	seedAgent(mgr, "a1", repo, wt, "squad/a1");
	await fs.writeFile(path.join(repo, "base.txt"), "base\nLOCAL UNCOMMITTED WORK\n");

	await mgr.land("a1", undefined, { force: true, reason: "reemit test 1" });
	// Simulate the cooldown elapsing (backdate by 10m > the ~4m cooldown) without wall-clock waiting.
	const warnAt = (mgr as unknown as { landBlockedWarnAt: Map<string, number> }).landBlockedWarnAt;
	expect(warnAt.size).toBe(1);
	for (const k of warnAt.keys()) warnAt.set(k, Date.now() - 600_000);
	await mgr.land("a1", undefined, { force: true, reason: "reemit test 2" });

	// Re-emitted once per elapsed cooldown period: 2 rows for 2 periods — never more.
	expect(mgr.automationActivity({ loop: "land" }).events.length).toBe(2);
	// Same episode throughout: still exactly one blocked increment.
	expect(modelOutcomes(stateDir, undefined, "mid")).toEqual({ landed: 0, rejected: 0, blocked: 1 });
});

test("THROTTLE: a fresh head on the branch opens a NEW episode — blocked:2", async () => {
	const stateDir = await tmpDir("blocked-episode-state-");
	const repo = await baseRepo("blocked-episode-repo-");
	const wt = await branchWorktree(repo, "squad/a1", "x.txt");
	const mgr = new TestManager({ stateDir });
	seedAgent(mgr, "a1", repo, wt, "squad/a1");
	await fs.writeFile(path.join(repo, "base.txt"), "base\nLOCAL UNCOMMITTED WORK\n");

	await mgr.land("a1", undefined, { force: true, reason: "episode test 1" });
	expect(modelOutcomes(stateDir, undefined, "mid")).toEqual({ landed: 0, rejected: 0, blocked: 1 });

	// New work lands on the branch (new headSha) — a genuinely new "attempted, couldn't land" fact.
	await fs.writeFile(path.join(wt, "y.txt"), "more work\n");
	await git(wt, "add", "-A");
	await git(wt, "commit", "-qm", "more work");
	await mgr.land("a1", undefined, { force: true, reason: "episode test 2" });

	expect(modelOutcomes(stateDir, undefined, "mid")).toEqual({ landed: 0, rejected: 0, blocked: 2 });
});

test("THROTTLE: a non-retryable outcome CLOSES the episode — the next refusal on the same head counts again", async () => {
	process.env.OMP_SQUAD_AUTORESOLVE = "0"; // the conflict below must reject, not spawn a resolver
	const stateDir = await tmpDir("blocked-close-state-");
	const repo = await baseRepo("blocked-close-repo-");
	const wt = await branchWorktree(repo, "squad/a1", "x.txt");
	await fs.writeFile(path.join(wt, "base.txt"), "branch version\n");
	await git(wt, "add", "-A");
	await git(wt, "commit", "-qm", "branch edit of base.txt");
	const mgr = new TestManager({ stateDir });
	seedAgent(mgr, "a1", repo, wt, "squad/a1");

	try {
		// 1. Dirty main → blocked episode opens.
		await fs.writeFile(path.join(repo, "base.txt"), "base\nLOCAL UNCOMMITTED WORK\n");
		await mgr.land("a1", undefined, { force: true, reason: "close test 1" });
		expect(modelOutcomes(stateDir, undefined, "mid")).toEqual({ landed: 0, rejected: 0, blocked: 1 });

		// 2. Main cleaned but COMMITTED a conflicting edit → non-retryable rejected land. The branch
		//    head is unchanged, but the non-retryable outcome must close the blocked episode.
		await fs.writeFile(path.join(repo, "base.txt"), "main version\n");
		await git(repo, "add", "-A");
		await git(repo, "commit", "-qm", "main edit of base.txt");
		const rejected = await mgr.land("a1", undefined, { force: true, reason: "close test 2" });
		expect(rejected.ok).toBe(false);
		expect(rejected.retryable).toBeFalsy();
		expect(modelOutcomes(stateDir, undefined, "mid")).toEqual({ landed: 0, rejected: 1, blocked: 1 });

		// 3. Main dirty again, SAME branch head, SAME reason — a new episode, so blocked:2. Without the
		//    close in step 2 this would stay at 1 (the edge-trigger would see an identical episode key).
		await fs.writeFile(path.join(repo, "base.txt"), "main version\nDIRTY AGAIN\n");
		const again = await mgr.land("a1", undefined, { force: true, reason: "close test 3" });
		expect(again.retryable).toBe(true);
		expect(modelOutcomes(stateDir, undefined, "mid")).toEqual({ landed: 0, rejected: 1, blocked: 2 });
	} finally {
		delete process.env.OMP_SQUAD_AUTORESOLVE;
	}
});

test("a retryable dirty-main refusal is LOUD: automation-log warn event + factory-status landBlocked banner", async () => {
	const stateDir = await tmpDir("blocked-loud-state-");
	const repo = await baseRepo("blocked-loud-repo-");
	const wt = await branchWorktree(repo, "squad/a1", "x.txt");
	const mgr = new TestManager({ stateDir });
	seedAgent(mgr, "a1", repo, wt, "squad/a1");
	await fs.writeFile(path.join(repo, "base.txt"), "base\nLOCAL UNCOMMITTED WORK\n");

	await mgr.land("a1", undefined, { force: true, reason: "blocked-loud test" });

	// Automation channel: one warn-level "land" event, tagged dirty-main, carrying the branch + reason.
	const { events } = mgr.automationActivity({ loop: "land" });
	expect(events.length).toBe(1);
	expect(events[0]?.level).toBe("warn");
	expect(events[0]?.skipReason).toBe("dirty-main");
	expect(events[0]?.repo).toBe(repo);
	expect(events[0]?.detail).toContain("squad/a1");
	expect(events[0]?.detail).toContain("uncommitted tracked changes");

	// Factory status: the operator-facing "fleet cannot land" banner is up, with the reason.
	const status = mgr.factoryStatus();
	expect(status.landBlocked.blocked).toBe(true);
	expect(status.landBlocked.reason).toContain("uncommitted tracked changes");
	expect(status.landBlocked.at).toBeGreaterThan(0);
});

test("a clean land records `landed` (not blocked), clears the banner path, and leaves no land event", async () => {
	const stateDir = await tmpDir("clean-land-state-");
	const repo = await baseRepo("clean-land-repo-");
	const wt = await branchWorktree(repo, "squad/a1", "x.txt");
	const mgr = new TestManager({ stateDir });
	seedAgent(mgr, "a1", repo, wt, "squad/a1");

	const result = await mgr.land("a1", undefined, { force: true, reason: "clean-land test" });

	expect(result.ok).toBe(true);
	expect(result.merged).toBe(true);
	// The normal statistic: landed bumps, and the entry carries NO blocked key (old exact shape).
	expect(modelOutcomes(stateDir, undefined, "mid")).toEqual({ landed: 1, rejected: 0 });
	// No spurious loudness on the happy path.
	expect(mgr.automationActivity({ loop: "land" }).events).toEqual([]);
	expect(mgr.factoryStatus().landBlocked.blocked).toBe(false);
});

// Cross-lineage review (grok-4.5, eap-borrows) finding #2: `autoLandFailCap` deliberately never sees a
// retryable refusal, so nothing else in this path ever escalates one — a persisting dirty-main window
// (or any other retryable refusal) retried forever at the ~30s tick cadence with ONLY a cooldown-
// throttled log line nobody watches. `landBlockedEscalateCap` bounds how many consecutive attempts on
// the SAME episode run before a "Needs you" attention item fires — this drives the REAL SquadManager
// path (not the ledger helper) with a small test cap so the budget doesn't require 20 real land() calls.
test("REGRESSION: a retryable refusal past the escalate cap fires ONE 'Needs you' attention item — never forever-soft", async () => {
	process.env.OMP_SQUAD_LAND_BLOCKED_ESCALATE_CAP = "3";
	try {
		const stateDir = await tmpDir("blocked-escalate-state-");
		const repo = await baseRepo("blocked-escalate-repo-");
		const wt = await branchWorktree(repo, "squad/a1", "x.txt");
		const mgr = new TestManager({ stateDir });
		seedAgent(mgr, "a1", repo, wt, "squad/a1");
		await fs.writeFile(path.join(repo, "base.txt"), "base\nLOCAL UNCOMMITTED WORK\n");

		// Same episode (same repo, branch, head, reason) driven exactly to the cap.
		for (let i = 0; i < 2; i++) {
			const r = await mgr.land("a1", undefined, { force: true, reason: `escalate test ${i}` });
			expect(r.retryable).toBe(true);
		}
		// Below the cap: no attention item yet.
		expect(mgr.agents.get("a1")?.dto.attentionEvents ?? []).toEqual([]);

		const atCap = await mgr.land("a1", undefined, { force: true, reason: "escalate test at cap" });
		expect(atCap.retryable).toBe(true);

		// Crossing the cap fires exactly one attention item, naming the branch and the attempt count.
		const events = mgr.agents.get("a1")?.dto.attentionEvents ?? [];
		expect(events.length).toBe(1);
		expect(events[0]?.summary).toContain("squad/a1");
		expect(events[0]?.summary).toContain("3 consecutive attempts");
		expect(events[0]?.summary).toContain("needs a human");
		expect(events[0]?.source).toBe("notify");

		// Idempotent: retrying the SAME still-stuck episode past the cap does not file a second item.
		const pastCap = await mgr.land("a1", undefined, { force: true, reason: "escalate test past cap" });
		expect(pastCap.retryable).toBe(true);
		expect((mgr.agents.get("a1")?.dto.attentionEvents ?? []).length).toBe(1);

		// A NEW episode (branch advances) resets the attempt budget and can escalate again.
		await fs.writeFile(path.join(wt, "y.txt"), "more work\n");
		await git(wt, "add", "-A");
		await git(wt, "commit", "-qm", "more work");
		for (let i = 0; i < 3; i++) {
			await mgr.land("a1", undefined, { force: true, reason: `escalate test new-episode ${i}` });
		}
		expect((mgr.agents.get("a1")?.dto.attentionEvents ?? []).length).toBe(2);
	} finally {
		delete process.env.OMP_SQUAD_LAND_BLOCKED_ESCALATE_CAP;
	}
});

test("landBlockedEscalateCap:0 disables the bounded escalation (pure opt-out, never fires)", async () => {
	process.env.OMP_SQUAD_LAND_BLOCKED_ESCALATE_CAP = "0";
	try {
		const stateDir = await tmpDir("blocked-escalate-off-state-");
		const repo = await baseRepo("blocked-escalate-off-repo-");
		const wt = await branchWorktree(repo, "squad/a1", "x.txt");
		const mgr = new TestManager({ stateDir });
		seedAgent(mgr, "a1", repo, wt, "squad/a1");
		await fs.writeFile(path.join(repo, "base.txt"), "base\nLOCAL UNCOMMITTED WORK\n");

		for (let i = 0; i < 5; i++) {
			await mgr.land("a1", undefined, { force: true, reason: `escalate-off test ${i}` });
		}
		expect(mgr.agents.get("a1")?.dto.attentionEvents ?? []).toEqual([]);
	} finally {
		delete process.env.OMP_SQUAD_LAND_BLOCKED_ESCALATE_CAP;
	}
});

test("a non-retryable land FAILURE still records `rejected` exactly as before (decoupling changed nothing here)", async () => {
	// Autoresolve is ON by default and would spawn a real resolver on the conflict below — this test
	// is about the RECORDING of a plain non-retryable failure, so turn it off for the duration.
	process.env.OMP_SQUAD_AUTORESOLVE = "0";
	const stateDir = await tmpDir("rejected-land-state-");
	const repo = await baseRepo("rejected-land-repo-");
	// A branch that CONFLICTS with main: same file, divergent content → non-retryable merge failure.
	const wt = await branchWorktree(repo, "squad/a1", "x.txt");
	await fs.writeFile(path.join(wt, "base.txt"), "branch version\n");
	await git(wt, "add", "-A");
	await git(wt, "commit", "-qm", "branch edit of base.txt");
	await fs.writeFile(path.join(repo, "base.txt"), "main version\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "main edit of base.txt");
	const mgr = new TestManager({ stateDir });
	seedAgent(mgr, "a1", repo, wt, "squad/a1");

	try {
		const result = await mgr.land("a1", undefined, { force: true, reason: "rejected-land test" });

		expect(result.ok).toBe(false);
		expect(result.retryable).toBeFalsy();
		expect(modelOutcomes(stateDir, undefined, "mid")).toEqual({ landed: 0, rejected: 1 });
		// A real branch failure bumps the streak (pre-existing behavior, re-asserted post-decouple).
		expect(landFailureCount(stateDir, "squad/a1")).toBe(1);
		// Not an environmental refusal → no "fleet cannot land" banner.
		expect(mgr.factoryStatus().landBlocked.blocked).toBe(false);
	} finally {
		delete process.env.OMP_SQUAD_AUTORESOLVE;
	}
});
