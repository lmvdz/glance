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
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { FileStore } from "../src/dal/store.ts";
import { openRemovedLedger } from "../src/removed-ledger.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { PersistedAgent, RpcSessionState } from "../src/types.ts";

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

class NoopDriver extends EventEmitter implements AgentDriver {
	readonly isReady = true;
	readonly isAlive = true;
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async prompt(): Promise<void> {}
	async abort(): Promise<unknown> {
		return undefined;
	}
	async getState(): Promise<RpcSessionState> {
		return { todoPhases: [], isStreaming: false } as RpcSessionState;
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

interface DriverFactoryHost {
	makeDriver: (p: PersistedAgent) => AgentDriver;
}

function useNoopDriver(mgr: SquadManager): void {
	const host = mgr as unknown as DriverFactoryHost;
	host.makeDriver = () => new NoopDriver();
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

/**
 * THE TEST THAT WAS MISSING (tombstone-by-name incident): every test above drives `rm` with the
 * agent's true id directly. The live incident drove it with the agent's bare display NAME instead
 * (`glance rm ompsq-422`, not `glance rm ompsq-422-mrb7dh74-3-528e10f5`) — exactly what a human
 * operator types, since the roster UI/CLI list agents by name. Before the fix, `remove()` tombstoned
 * the raw name string verbatim; every resurrection guard filters by the record's real `id`, which
 * never equals the bare name, so the tombstone protected nothing and the persisted record — never
 * actually removed under its real id — reattached verbatim on the very next restart.
 */
test("rm by NAME on a terminal-marked, non-resident workflow record resolves to the real id and durably tombstones it — survives restart", async () => {
	const repo = await makeRepo();
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "removed-agent-byname-state-"));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "removed-agent-byname-wt-"));
	tmps.push(stateDir, worktreeBase);

	const id = "ompsq-422-mrb7dh74-3-528e10f5";
	const name = "ompsq-422";
	// Seed the persisted store directly — simulates the record surviving from a PRIOR manager
	// instance/boot (the exact eviction-race window in DB-root mode), named after its Plane ticket.
	const record = terminalWorkflowRecord(id, repo, path.join(worktreeBase, "stuck"));
	record.name = name;
	await new FileStore(stateDir).save({ agents: [record], transcripts: {}, features: [] });

	// A manager instance that never called start() — `this.agents` is empty, reproducing the race
	// where `rm` lands on an instance that hasn't (re)loaded the persisted row yet. The operator
	// types the ticket's short name, not the internal suffixed id.
	const racyMgr = new SquadManager({ stateDir, worktreeBase });
	await racyMgr.applyCommand({ type: "remove", id: name, deleteWorktree: false });

	// THE FIX: the tombstone must be keyed on the record's REAL id — the resurrection guards only
	// ever check `p.id`, never the display name. Without this, `has(id)` is false here and the
	// assertion below (restart resurrection) fails exactly as it did live.
	expect(openRemovedLedger(stateDir).has(id)).toBe(true);
	// Defense-in-depth: the raw name is ALSO recorded alongside the resolved id (never in place of it).
	expect(openRemovedLedger(stateDir).has(name)).toBe(true);

	// Simulate restart: a FRESH manager instance against the SAME stateDir (the next evict+recreate
	// cycle in DB-root mode, or a plain daemon restart) must never resurrect the record via
	// reconnectLive's terminal-reattach path, adoptOrphanedAgents, or loadPersisted.
	const mgr2 = new SquadManager({ stateDir, worktreeBase });
	await mgr2.start();
	try {
		expect(mgr2.getAgent(id)).toBeUndefined();
		expect(mgr2.list().find((a) => a.id === id || a.name === name)).toBeUndefined();
	} finally {
		await mgr2.stop();
	}
});

test("rm by NAME on a live, resident agent resolves to the real id, stops it, and tombstones the id (not just the name)", async () => {
	const repo = await makeRepo();
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "removed-agent-byname-state2-"));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "removed-agent-byname-wt2-"));
	tmps.push(stateDir, worktreeBase);

	const mgr = new SquadManager({ stateDir, worktreeBase });
	useNoopDriver(mgr);
	await mgr.start();
	const dto = await mgr.create({ name: "chat", repo, approvalMode: "yolo" });
	expect(dto.id).not.toBe(dto.name); // sanity: newAgentId always suffixes, id and name diverge

	await mgr.applyCommand({ type: "remove", id: dto.name, deleteWorktree: false });
	expect(mgr.getAgent(dto.id)).toBeUndefined();
	expect(openRemovedLedger(stateDir).has(dto.id)).toBe(true);

	// A fresh manager over the same stateDir must not reattach it either (belt-and-suspenders on top
	// of the in-process removal above).
	const mgr2 = new SquadManager({ stateDir, worktreeBase });
	await mgr2.start();
	try {
		expect(mgr2.getAgent(dto.id)).toBeUndefined();
	} finally {
		await mgr2.stop();
	}
	await mgr.stop();
}, 60_000); // live omp spawns — full-suite parallel load can starve host startup/removal beyond 30s

test("rm by a name that matches MULTIPLE live agents refuses to guess — tombstones the raw string, neither agent's real id", async () => {
	const repo = await makeRepo();
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "removed-agent-ambiguous-state-"));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "removed-agent-ambiguous-wt-"));
	tmps.push(stateDir, worktreeBase);

	const mgr = new SquadManager({ stateDir, worktreeBase });
	useNoopDriver(mgr);
	await mgr.start();
	const a = await mgr.create({ name: "dup", repo, approvalMode: "yolo" });
	const b = await mgr.create({ name: "dup", repo, approvalMode: "yolo" });
	expect(a.id).not.toBe(b.id);

	const found = await (mgr as unknown as { remove(id: string, deleteWorktree: boolean): Promise<boolean> }).remove("dup", false);
	expect(found).toBe(false); // "dup" never equals either real id, so `this.agents.get("dup")` misses
	expect(openRemovedLedger(stateDir).has("dup")).toBe(true); // fallback: raw string tombstoned
	expect(openRemovedLedger(stateDir).has(a.id)).toBe(false); // neither real id was touched — no guess
	expect(openRemovedLedger(stateDir).has(b.id)).toBe(false);
	// Both agents are untouched — an ambiguous name is not silently resolved to an arbitrary one.
	expect(mgr.getAgent(a.id)).toBeDefined();
	expect(mgr.getAgent(b.id)).toBeDefined();
	await mgr.stop();
}, 120_000); // live omp spawns — full-suite parallel load can starve host startup/removal beyond 60s

test("rm on a live, resident agent still removes it from the roster (no regression on the ordinary path)", async () => {
	const repo = await makeRepo();
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "removed-agent-state2-"));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "removed-agent-wt2-"));
	tmps.push(stateDir, worktreeBase);

	const mgr = new SquadManager({ stateDir, worktreeBase });
	useNoopDriver(mgr);
	await mgr.start();
	const dto = await mgr.create({ name: "chat", repo, approvalMode: "yolo" });
	await mgr.applyCommand({ type: "remove", id: dto.id, deleteWorktree: false });
	expect(mgr.getAgent(dto.id)).toBeUndefined();
	expect(openRemovedLedger(stateDir).has(dto.id)).toBe(true);
	await mgr.stop();
}, 60_000); // live omp spawns — full-suite parallel load can starve host startup/removal beyond 30s

test("a fresh dispatch for the SAME issue after an rm gets a new, non-deterministic agent id — not blacklisted", async () => {
	const repo = await makeRepo();
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "removed-agent-state3-"));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "removed-agent-wt3-"));
	tmps.push(stateDir, worktreeBase);

	const mgr = new SquadManager({ stateDir, worktreeBase });
	useNoopDriver(mgr);
	await mgr.start();
	const first = await mgr.create({ name: "worker", repo, approvalMode: "yolo" });
	await mgr.applyCommand({ type: "remove", id: first.id, deleteWorktree: false });
	// The tombstone is keyed on the AGENT id, not an issue id — a later create() for "the same
	// work" mints an unrelated fresh id and is completely unaffected by the tombstone.
	const second = await mgr.create({ name: "worker", repo, approvalMode: "yolo" });
	expect(second.id).not.toBe(first.id);
	expect(mgr.getAgent(second.id)).toBeDefined();
	await mgr.stop();
}, 120_000); // live omp spawns — full-suite parallel load can starve host startup/removal beyond 60s

test("an authorized re-creation under a tombstoned id CLEARS the tombstone, and the resurrected run survives the next restart (HIGH 2)", async () => {
	const repo = await makeRepo();
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "removed-agent-state5-"));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "removed-agent-wt5-"));
	tmps.push(stateDir, worktreeBase);

	// Deterministic-id shape: workflow branch ids derive purely from (runId, branchKey, nodeId), so a
	// legitimate workflow resume RE-SPAWNS the exact id an operator may have rm'd minutes earlier.
	const id = "br-1a2b3c4d-implement";

	// Operator rm's the stuck branch — tombstoned durably (the rm-doesn't-stick fix).
	const mgr1 = new SquadManager({ stateDir, worktreeBase });
	await mgr1.applyCommand({ type: "remove", id, deleteWorktree: false });
	expect(openRemovedLedger(stateDir).has(id)).toBe(true);

	// A workflow resume (spawnFleetBranch → createInternal) deliberately re-creates the SAME id.
	// Without the tombstone-clear, this run would execute once and then silently vanish at the next
	// restart — reconnect/adopt/restore all filter tombstoned ids.
	const mgr2 = new SquadManager({ stateDir, worktreeBase });
	await mgr2.start();
	(mgr2 as unknown as DriverFactoryHost).makeDriver = () => new NoopDriver();
	interface InternalCreator {
		createInternal(opts: Record<string, unknown>): Promise<{ id: string }>;
	}
	const dto = await (mgr2 as unknown as InternalCreator).createInternal({
		explicitId: id,
		name: "resumed-branch",
		repo,
		approvalMode: "yolo",
		workflow: "verify",
		// Terminal-marked state makes the record land on reconnectLive's unconditional reattachTerminal
		// path in the next boot — the exact same-id reattach mechanism the incident traced — so mgr3
		// below discriminates cleanly: tombstone still set ⇒ filtered/gone; cleared ⇒ present.
		workflowState: terminalWorkflowRecord(id, repo, path.join(worktreeBase, "unused")).workflowState,
		bypassCap: true,
	});
	expect(dto.id).toBe(id);
	expect(openRemovedLedger(stateDir).has(id)).toBe(false); // durable clear — an authorized resurrection is intentional
	await mgr2.stop();

	// Next restart keeps the resurrected id on the roster instead of silently dropping it.
	const mgr3 = new SquadManager({ stateDir, worktreeBase });
	(mgr3 as unknown as DriverFactoryHost).makeDriver = () => new NoopDriver();
	await mgr3.start();
	try {
		expect(mgr3.getAgent(id)).toBeDefined();
	} finally {
		await mgr3.stop();
	}
});

test("loadPersisted (--restore) skips tombstoned records — the last boot path that bypassed the tombstone (MEDIUM 3)", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "removed-agent-state6-"));
	tmps.push(stateDir);
	const wt1 = await fs.mkdtemp(path.join(os.tmpdir(), "removed-agent-restore-wt1-"));
	const wt2 = await fs.mkdtemp(path.join(os.tmpdir(), "removed-agent-restore-wt2-"));
	tmps.push(wt1, wt2);

	const removed: PersistedAgent = { id: "restore-removed-1", name: "removed-unit", repo: "(none)", worktree: wt1, approvalMode: "yolo" };
	const kept: PersistedAgent = { id: "restore-kept-1", name: "kept-unit", repo: "(none)", worktree: wt2, approvalMode: "yolo" };
	await new FileStore(stateDir).save({ agents: [removed, kept], transcripts: {}, features: [] });
	openRemovedLedger(stateDir).add(removed.id); // a prior explicit rm

	const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true });
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new NoopDriver();
	await mgr.loadPersisted(); // the --restore CLI flow
	try {
		const names = mgr.list().map((a) => a.name);
		expect(names).toContain("kept-unit");
		expect(names).not.toContain("removed-unit");
	} finally {
		await mgr.stop();
	}
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
