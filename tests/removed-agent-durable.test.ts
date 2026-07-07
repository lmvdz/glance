/**
 * Durable-removal fix (rm-doesn't-stick incident): an operator ran `glance rm <id>` for 7 stuck
 * (CATASTROPHE/escalate-capped) workflow agents; the CLI reported "removed" for all 7, but the
 * SAME ids reappeared on the roster minutes later, twice.
 *
 * Traced mechanism (two layers, both fixed here):
 *  1. `applyCommand`'s universal chokepoint did `const rec = this.agents.get(cmd.id); if (!rec)
 *     return;` BEFORE the switch that dispatches "remove" — so a `rm` for an id that wasn't
 *     resident in THIS instance's in-memory roster never even reached `remove()`. It's now handled
 *     in its own early branch (alongside "message"/"set-mode"), same as this file's other
 *     id-need-not-be-resident commands.
 *  2. `remove()` itself ALSO silently no-op'd (`if (!rec) return`) for the same reason, so even
 *     after fixing (1) the persisted row would have survived untouched.
 * In DB-root/multi-tenant mode, `ManagerRegistry.evictIdle` detaches an idle org's manager and
 * lazily re-creates a fresh one on the next request, so a `rm` landing on a freshly re-created (or
 * about-to-be-evicted) instance hit both no-ops and left the persisted roster row completely
 * untouched. The very next `start()` for that org (the next evict+recreate cycle) then reattaches
 * the still-persisted TERMINAL-marked workflow record verbatim — `reconnectLive`'s
 * `reattachTerminal` path re-adds it unconditionally, keyed on the record's own `id`, with no "was
 * this removed" gate (none existed) — reproducing the identical id the operator thought was gone.
 *
 * This test seeds a persisted terminal-marked workflow record directly (bypassing the need for a
 * real live workflow run), issues an explicit `rm` against a manager instance that never loaded it
 * into memory (the exact race), then boots a SECOND manager instance against the SAME stateDir —
 * mirroring the next evict+recreate cycle — and asserts the id never comes back.
 */
import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileStore } from "../src/dal/store.ts";
import { openRemovedLedger } from "../src/removed-ledger.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { PersistedAgent } from "../src/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function makeRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "removed-agent-repo-"));
	tmps.push(repo);
	const git = async (args: string[]) => {
		await Bun.spawn(["git", ...args], { cwd: repo, stdout: "ignore", stderr: "ignore" }).exited;
	};
	await git(["init", "-q"]);
	await git(["config", "user.email", "t@t"]);
	await git(["config", "user.name", "t"]);
	await git(["config", "commit.gpgsign", "false"]);
	await fs.writeFile(path.join(repo, "README.md"), "x\n");
	await git(["add", "."]);
	await git(["commit", "-qm", "init"]);
	return repo;
}

function terminalWorkflowRecord(id: string, repo: string, worktree: string): PersistedAgent {
	return {
		id,
		name: "stuck-unit",
		repo,
		worktree,
		approvalMode: "yolo",
		kind: "workflow",
		workflow: { path: "verify" },
		workflowState: {
			goal: "ship it",
			currentNode: "escalate",
			visits: { escalate: 2 },
			vars: {},
			index: 4,
			coldReentryCount: 0,
			rollup: [],
			terminal: { reason: 'node "escalate" exceeded its visit cap (2)', at: Date.now(), forkPoint: { runId: "run-1", seq: 4 } },
		},
	};
}

test('rm on a terminal-marked workflow durably tombstones the id, even when the record was never resident in THIS manager instance', async () => {
	const repo = await makeRepo();
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "removed-agent-state-"));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "removed-agent-wt-"));
	tmps.push(stateDir, worktreeBase);

	const id = "ompsq-422-mrb7dh74-3-528e10f5";
	// Seed the persisted store directly — simulates the record surviving from a PRIOR manager
	// instance/boot, exactly as it would on disk in DB-root mode.
	await new FileStore(stateDir).save({ agents: [terminalWorkflowRecord(id, repo, path.join(worktreeBase, "stuck"))], transcripts: {}, features: [] });

	// A manager instance that never called start() — `this.agents` is empty, reproducing the race
	// where `rm` lands on an instance that hasn't (re)loaded the persisted row yet.
	const racyMgr = new SquadManager({ stateDir, worktreeBase });
	await racyMgr.applyCommand({ type: "remove", id, deleteWorktree: false });

	// Fix (a): durably removed from the store the daemon reads EVEN THOUGH `rec` was never resident.
	expect(openRemovedLedger(stateDir).has(id)).toBe(true);

	// Fix (b): a FRESH manager instance against the same stateDir (the next evict+recreate cycle in
	// DB-root mode) must never resurrect it via reconnectLive's terminal-reattach path.
	const mgr2 = new SquadManager({ stateDir, worktreeBase });
	await mgr2.start();
	try {
		expect(mgr2.getAgent(id)).toBeUndefined();
		expect(mgr2.list().find((a) => a.id === id)).toBeUndefined();
	} finally {
		await mgr2.stop();
	}
});

test("rm on a live, resident agent still removes it from the roster (no regression on the ordinary path)", async () => {
	const repo = await makeRepo();
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "removed-agent-state2-"));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "removed-agent-wt2-"));
	tmps.push(stateDir, worktreeBase);

	const mgr = new SquadManager({ stateDir, worktreeBase });
	await mgr.start();
	const dto = await mgr.create({ name: "chat", repo, approvalMode: "yolo" });
	await mgr.applyCommand({ type: "remove", id: dto.id, deleteWorktree: false });
	expect(mgr.getAgent(dto.id)).toBeUndefined();
	expect(openRemovedLedger(stateDir).has(dto.id)).toBe(true);
	await mgr.stop();
});

test("a fresh dispatch for the SAME issue after an rm gets a new, non-deterministic agent id — not blacklisted", async () => {
	const repo = await makeRepo();
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "removed-agent-state3-"));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "removed-agent-wt3-"));
	tmps.push(stateDir, worktreeBase);

	const mgr = new SquadManager({ stateDir, worktreeBase });
	await mgr.start();
	const first = await mgr.create({ name: "worker", repo, approvalMode: "yolo" });
	await mgr.applyCommand({ type: "remove", id: first.id, deleteWorktree: false });
	// The tombstone is keyed on the AGENT id, not an issue id — a later create() for "the same
	// work" mints an unrelated fresh id and is completely unaffected by the tombstone.
	const second = await mgr.create({ name: "worker", repo, approvalMode: "yolo" });
	expect(second.id).not.toBe(first.id);
	expect(mgr.getAgent(second.id)).toBeDefined();
	await mgr.stop();
});

test("a tombstoned id with a resumable checkpoint and an on-disk worktree is never re-adopted (fix (b), the adopt path)", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "removed-agent-state4-"));
	const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "removed-agent-adopt-wt-"));
	tmps.push(stateDir, worktree);

	const id = "orphan-tombstoned-1";
	const persisted: PersistedAgent = {
		id,
		name: "orphan",
		repo: "(none)",
		worktree,
		approvalMode: "yolo",
		// Resumable checkpoint + a real on-disk worktree ⇒ agentsToAdopt/selectAdoptable would treat
		// this as adoptable "unlanded work" absent the tombstone (see tests/adopt-cap.test.ts).
		kind: "workflow",
		workflowState: { goal: "g", currentNode: "n1", visits: {}, vars: {}, index: 0, rollup: [] },
	};
	await new FileStore(stateDir).save({ agents: [persisted], transcripts: {}, features: [] });
	// Simulates a PRIOR `rm` of this exact id (e.g. right before an evict+recreate cycle) — the
	// tombstone survives independently of the roster snapshot.
	openRemovedLedger(stateDir).add(id);

	const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true });
	await mgr.start(); // hasState() true → reconnectLive (no live host) → adoptOrphanedAgents
	const roster = mgr.list();
	expect(roster.length).toBe(0); // NOT adopted under a fresh id, and NOT reattached under its own id
	await mgr.stop();
});
