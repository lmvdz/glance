/**
 * Concern 02 (inspectable-topology): SubagentTracker dirty-tracking + merge-by-id flush wired into
 * SquadManager. Drives synthetic `subagent_*` frames through the manager's real `onAgentEvent` (the same
 * seam `wire()` subscribes a live driver's "event" emissions to) and asserts:
 *   - a dirty transition flushes the merged projection onto `rec.dto.subagents`/`rec.options.subagents`,
 *     and `manager.subagents(id)` (the single read contract) reflects it immediately;
 *   - run-end closure (`finalizeRun`) stamps any subagent left non-terminal "aborted" so nothing can
 *     persist as "running" forever under a finished run;
 *   - reattaching a persisted agent that carries `subagents` seeds the read contract with that history
 *     before any new frame ever arrives (the applySnapshot reseed);
 *   - the create()-restore reseed path (adoptOrphanedAgents/loadPersisted, NOT attachExisting) additionally
 *     closes any subagent still "running" in that persisted snapshot at boot — such an agent may never run
 *     again as-is (e.g. `adopted: true`), so nothing should be able to claim "running" forever. attachExisting
 *     (above) deliberately does NOT do this: its children may genuinely still be in flight on a live host.
 */

import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { SubagentNode } from "../src/subagents.ts";
import type { AgentDTO, PersistedAgent, RpcSessionState } from "../src/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

/** A driver that comes up ready immediately and never replays any frames — only the manager's own
 *  onAgentEvent wiring is exercised (frames are injected directly, not emitted by this driver). */
class ReadyDriver extends EventEmitter implements AgentDriver {
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
	makeDriver: (p: PersistedAgent, cold?: boolean) => AgentDriver;
}

interface AgentRecordLike {
	dto: AgentDTO;
	options: PersistedAgent;
	run?: unknown;
}

interface ManagerInternals {
	agents: Map<string, AgentRecordLike>;
	onAgentEvent: (rec: AgentRecordLike, frame: { type?: string; [k: string]: unknown }) => void;
	finalizeRun: (rec: AgentRecordLike) => Promise<void>;
}

interface AttachHost {
	attachExisting: (p: PersistedAgent, transcript?: unknown[]) => Promise<void>;
}

async function makeMgr(): Promise<{ mgr: SquadManager; stateDir: string; repo: string }> {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-lineage-state-"));
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-lineage-repo-"));
	tmps.push(stateDir, repo);
	const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true });
	await mgr.start();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new ReadyDriver();
	return { mgr, stateDir, repo };
}

const lifecycleFrame = (id: string, status: "started" | "completed" | "failed" | "aborted", index: number) => ({
	type: "subagent_lifecycle",
	payload: { id, agent: "worker", agentSource: "bundled" as const, description: `task ${id}`, status, index },
});

test("a dirty subagent transition flushes the merge onto dto.subagents/options.subagents; manager.subagents() matches", async () => {
	const { mgr, repo } = await makeMgr();
	const dto = await mgr.create({ name: "lineage-a", repo, approvalMode: "yolo", autoRoute: false });
	const internals = mgr as unknown as ManagerInternals;
	const rec = internals.agents.get(dto.id)!;

	// No flush yet — nothing has happened.
	expect(rec.options.subagents).toBeUndefined();

	internals.onAgentEvent(rec, lifecycleFrame("s1", "started", 0));

	// The flush is synchronous in-memory (only the disk write is async, covered by concern 01's dedup
	// tests) — dto/options carry the merged projection immediately.
	expect(rec.dto.subagents?.map((n) => n.id)).toEqual(["s1"]);
	expect(rec.options.subagents).toBe(rec.dto.subagents); // same array reference — one projection, not two
	expect(mgr.subagents(dto.id).map((n) => ({ id: n.id, status: n.status }))).toEqual([{ id: "s1", status: "running" }]);

	// A second, distinct child — union grows, not replaces.
	internals.onAgentEvent(rec, lifecycleFrame("s2", "started", 1));
	expect(mgr.subagents(dto.id).map((n) => n.id)).toEqual(["s1", "s2"]);

	await mgr.stop();
});

// Topology review finding 8: the dirty-flush persisted but never broadcast, so the webapp's SSE copy of
// dto.subagents staleness-lagged until some UNRELATED emit happened to fire afterward.
test("a dirty subagent transition also emits the 'agent' event, not just the dirty-gated persist()", async () => {
	const { mgr, repo } = await makeMgr();
	const dto = await mgr.create({ name: "lineage-emit", repo, approvalMode: "yolo", autoRoute: false });
	const internals = mgr as unknown as ManagerInternals;
	const rec = internals.agents.get(dto.id)!;

	const emitted: string[] = [];
	mgr.on("event", (e: { type: string; agent?: { id: string; subagents?: unknown[] } }) => {
		if (e.type === "agent" && e.agent?.id === dto.id) emitted.push(JSON.stringify(e.agent.subagents ?? []));
	});

	internals.onAgentEvent(rec, lifecycleFrame("s1", "started", 0));
	expect(emitted).toHaveLength(1); // one emit for the one dirty transition
	expect(emitted[0]).toContain("s1");

	// A no-op re-ingest (covered below too) must not ALSO emit — gated identically to persist().
	internals.onAgentEvent(rec, lifecycleFrame("s1", "started", 0));
	expect(emitted).toHaveLength(1);

	await mgr.stop();
});

test("a no-op re-ingest and a pure heartbeat do not trigger a flush (options.subagents unchanged)", async () => {
	const { mgr, repo } = await makeMgr();
	const dto = await mgr.create({ name: "lineage-quiet", repo, approvalMode: "yolo", autoRoute: false });
	const internals = mgr as unknown as ManagerInternals;
	const rec = internals.agents.get(dto.id)!;

	internals.onAgentEvent(rec, lifecycleFrame("s1", "started", 0));
	const afterFirstFlush = rec.options.subagents;
	expect(afterFirstFlush).toBeDefined();

	// Re-feeding the identical lifecycle frame is a no-op under upsert's diff logic — no new flush.
	internals.onAgentEvent(rec, lifecycleFrame("s1", "started", 0));
	expect(rec.options.subagents).toBe(afterFirstFlush); // same reference — no re-flush happened

	// A pure heartbeat for the known id advances lastUpdate in the live tracker but must not itself flush.
	internals.onAgentEvent(rec, { type: "subagent_event", payload: { id: "s1", event: { type: "agent_end" } } });
	expect(rec.options.subagents).toBe(afterFirstFlush);

	await mgr.stop();
});

test("run-end closure: finalizeRun stamps any non-terminal subagent aborted so nothing persists as running forever", async () => {
	const { mgr, repo } = await makeMgr();
	const dto = await mgr.create({ name: "lineage-run-end", repo, approvalMode: "yolo", autoRoute: false });
	const internals = mgr as unknown as ManagerInternals;
	const rec = internals.agents.get(dto.id)!;

	// A live run must exist for finalizeRun to act (it early-returns on `!rec.run`) — agent_start seeds it,
	// exactly as a real driver's "event" emission would.
	internals.onAgentEvent(rec, { type: "agent_start" });

	// One subagent finishes cleanly; one never gets a terminal frame before the run ends (e.g. the daemon
	// died mid-subagent-run, or the parent simply exited without waiting).
	internals.onAgentEvent(rec, lifecycleFrame("finished", "started", 0));
	internals.onAgentEvent(rec, lifecycleFrame("finished", "completed", 0));
	internals.onAgentEvent(rec, lifecycleFrame("orphaned", "started", 1));
	expect(mgr.subagents(dto.id).find((n) => n.id === "orphaned")?.status).toBe("running");

	await internals.finalizeRun(rec);

	const after = mgr.subagents(dto.id);
	expect(after.find((n) => n.id === "finished")?.status).toBe("completed"); // untouched — already terminal
	expect(after.find((n) => n.id === "orphaned")?.status).toBe("aborted"); // closed by run-end, never left "running"

	await mgr.stop();
});

test("create()-restore reseed (e.g. adopted:true) closes a persisted 'running' subagent at boot, with no run ever starting", async () => {
	const { mgr, repo } = await makeMgr();
	const seeded: SubagentNode[] = [
		{ id: "prior-done", agent: "explore", description: "finished before the restart", status: "completed", lastUpdate: Date.now() - 1000, index: 0 },
		{ id: "prior-running", agent: "worker", description: "never got a terminal frame before the daemon died", status: "running", lastUpdate: Date.now() - 500, index: 1 },
	];

	// adopted:true: re-created from a surviving worktree, landed directly without a re-run — exactly the
	// shape that would otherwise keep "prior-running" claiming "running" forever. No `task` is passed, so
	// ReadyDriver.prompt() is never called and no run ever starts.
	const dto = await mgr.create({ name: "restore-reseed", repo, approvalMode: "yolo", autoRoute: false, subagents: seeded, adopted: true });

	const after = mgr.subagents(dto.id);
	expect(after.find((n) => n.id === "prior-done")?.status).toBe("completed"); // untouched — already terminal
	expect(after.find((n) => n.id === "prior-running")?.status).toBe("aborted"); // closed at boot, never left "running"

	const internals = mgr as unknown as ManagerInternals;
	const rec = internals.agents.get(dto.id)!;
	expect(rec.run).toBeUndefined(); // proof no run ever started — the closure happened purely at boot

	await mgr.stop();
});

test("reattach seeds manager.subagents() with the persisted history before any new frame arrives", async () => {
	const { mgr } = await makeMgr();
	const seeded: SubagentNode[] = [
		{ id: "prior-1", agent: "explore", description: "scouted before the restart", status: "completed", lastUpdate: Date.now() - 1000, index: 0 },
		{ id: "prior-2", agent: "worker", description: "still running at crash time", status: "running", lastUpdate: Date.now() - 500, index: 1 },
	];
	const persisted: PersistedAgent = {
		id: "reattach-lineage-1",
		name: "reattached",
		repo: "(none)",
		worktree: "(none)",
		approvalMode: "yolo",
		subagents: seeded,
	};

	await (mgr as unknown as AttachHost).attachExisting(persisted, []);

	// Before any new frame arrives, the read contract already reflects the seeded persisted history —
	// this is the applySnapshot reseed, not a lazily-empty live tracker with an unmerged options fallback.
	expect(mgr.subagents(persisted.id).map((n) => ({ id: n.id, status: n.status }))).toEqual([
		{ id: "prior-1", status: "completed" },
		{ id: "prior-2", status: "running" },
	]);

	// A new frame for an already-known id merges onto the seeded baseline instead of replacing it with a
	// defaulted-fields fresh node — proof the tracker was actually reseeded (not just options.subagents
	// falling back for an untouched id).
	const internals = mgr as unknown as ManagerInternals;
	const rec = internals.agents.get(persisted.id)!;
	// No `description` on this frame (unlike the `lifecycleFrame` helper) — proves the merge/upsert
	// preserves the seeded field rather than defaulting it away when a live frame doesn't carry it.
	internals.onAgentEvent(rec, { type: "subagent_lifecycle", payload: { id: "prior-2", agent: "worker", agentSource: "bundled", status: "completed", index: 1 } });
	const after = mgr.subagents(persisted.id);
	expect(after.find((n) => n.id === "prior-2")?.status).toBe("completed");
	expect(after.find((n) => n.id === "prior-2")?.description).toBe("still running at crash time"); // preserved from the seed, not defaulted away

	await mgr.stop();
});
