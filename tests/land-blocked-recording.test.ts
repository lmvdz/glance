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
