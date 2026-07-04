/**
 * Concern 01 (inspectable-topology): `parentNodeId`/`branchIndex`/`subagents`/`workflowGraph`/`traceId`
 * are lineage/topology fields on `CreateAgentOptions`/`PersistedAgent`/`AgentDTO` (`traceId` added by
 * topology review finding 7 — a restarted run previously lost its `GET /api/trace/:id` link even though
 * its receipts were still on disk, since `AgentDTO.traceId` had no `PersistedAgent` counterpart to survive
 * the restart). Every boot path that reconstructs an `AgentRecord` from persisted state builds `dto`/
 * `persisted` as EXPLICIT field-literal objects (nothing "rides along automatically") — so each of the
 * three restore call sites needs its own round-trip proof: persist an agent carrying all five fields, boot
 * via that path, assert the fields survive on both the resulting `AgentDTO` and the NEXT persisted
 * `state.json` snapshot.
 */

import { EventEmitter } from "node:events";
import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { FileStore } from "../src/dal/store.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { SubagentNode } from "../src/subagents.ts";
import type { AgentDTO, PersistedAgent, RpcSessionState } from "../src/types.ts";
import type { WorkflowGraphSnapshot } from "../src/workflow/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

/** A driver that comes up ready immediately and never replays any frames — used everywhere a real omp/
 *  workflow process must not be spawned, only the boot-path plumbing exercised. */
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

interface AttachHost {
	attachExisting: (p: PersistedAgent, transcript?: unknown[]) => Promise<void>;
}

const SUBAGENTS: SubagentNode[] = [{ id: "sub-1", agent: "worker", description: "do the thing", status: "running", task: "do the thing", lastUpdate: Date.now(), index: 0 }];

const WORKFLOW_GRAPH: WorkflowGraphSnapshot = {
	version: 1,
	name: "wf",
	nodes: [
		{ id: "start", kind: "start" },
		{ id: "a", kind: "agent", label: "A" },
		{ id: "exit", kind: "exit" },
	],
	edges: [
		{ from: "start", to: "a" },
		{ from: "a", to: "exit" },
	],
	start: "start",
	exit: "exit",
};

/** Every lineage/topology field this concern threads, for building fixtures + assertions.
 *  `expectedSubagentStatus` defaults to "running" (SUBAGENTS' own seeded status): attachExisting (a WARM
 *  reconnect to a still-live host) preserves it verbatim. The create()-based restore paths (adopt/
 *  loadPersisted) additionally close any "running" subagent at boot (review finding, concern 02
 *  follow-up) — those two call sites pass "aborted". `lastUpdate` is excluded from the equality check
 *  (closeNonTerminal stamps a fresh one), so this checks the stable fields via `toMatchObject` instead of
 *  an exact `toEqual(SUBAGENTS)`. */
const TRACE_ID = "feat:boot-lineage-trace-1";

function assertLineageFields(dto: AgentDTO | undefined, expectedParentId: string | undefined, expectedSubagentStatus: SubagentNode["status"] = "running"): void {
	expect(dto).toBeDefined();
	expect(dto?.parentId).toBe(expectedParentId);
	expect(dto?.parentNodeId).toBe("node-a");
	expect(dto?.branchIndex).toBe(2);
	expect(dto?.subagents).toHaveLength(1);
	expect(dto?.subagents?.[0]).toMatchObject({ id: "sub-1", agent: "worker", description: "do the thing", task: "do the thing", index: 0, status: expectedSubagentStatus });
	expect(dto?.workflowGraph).toEqual(WORKFLOW_GRAPH);
	expect(dto?.traceId).toBe(TRACE_ID);
}

function assertPersistedLineageFields(p: PersistedAgent | undefined, expectedParentId: string | undefined, expectedSubagentStatus: SubagentNode["status"] = "running"): void {
	expect(p).toBeDefined();
	expect(p?.parentId).toBe(expectedParentId);
	expect(p?.parentNodeId).toBe("node-a");
	expect(p?.branchIndex).toBe(2);
	expect(p?.subagents).toHaveLength(1);
	expect(p?.subagents?.[0]).toMatchObject({ id: "sub-1", agent: "worker", description: "do the thing", task: "do the thing", index: 0, status: expectedSubagentStatus });
	expect(p?.workflowGraph).toEqual(WORKFLOW_GRAPH);
	expect(p?.traceId).toBe(TRACE_ID);
}

// ── reconnect (attachExisting) ───────────────────────────────────────────────

test("reconnect: attachExisting carries all four lineage fields onto the DTO and the next persisted snapshot", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "boot-lineage-reconnect-"));
	tmps.push(stateDir);

	const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true, replaySettleTimeoutMs: 20 });
	await mgr.start();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new ReadyDriver();

	const persisted: PersistedAgent = {
		id: "reconnect-agent",
		name: "reconnect",
		repo: "(none)",
		worktree: "(none)",
		approvalMode: "yolo",
		parentId: "parent-1",
		parentNodeId: "node-a",
		branchIndex: 2,
		subagents: SUBAGENTS,
		workflowGraph: WORKFLOW_GRAPH,
		traceId: TRACE_ID,
	};

	await (mgr as unknown as AttachHost).attachExisting(persisted, []);

	assertLineageFields(mgr.getAgent(persisted.id), "parent-1");

	await mgr.stop(); // forces a persist() — the durability barrier

	const raw = JSON.parse(await fs.readFile(path.join(stateDir, "state.json"), "utf8")) as { agents: PersistedAgent[] };
	assertPersistedLineageFields(raw.agents.find((a) => a.id === persisted.id), "parent-1");
});

// ── adopt (adoptOrphanedAgents → create) ─────────────────────────────────────

test("adopt: adoptOrphanedAgents → create() carries all four lineage fields onto the DTO and the next persisted snapshot", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "boot-lineage-adopt-state-"));
	const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "boot-lineage-adopt-wt-"));
	tmps.push(stateDir, worktree);

	const persisted: PersistedAgent = {
		id: "orphan-lineage-1",
		name: "orphan",
		repo: "(none)",
		worktree,
		approvalMode: "yolo",
		// A resumable workflow checkpoint counts as "has work" (adoptOrphanedAgents' `resumable()`), so
		// the orphan is taken over regardless of worktree dirtiness. NOTE: no `parentId` here — a set
		// `parentId` marks a parallel-branch child, which `agentsToAdopt` deliberately excludes (it lands
		// with its parent instead); this test targets the plain-orphan adopt path, so `parentId` is
		// asserted absent rather than threaded here (parentNodeId/branchIndex/subagents/workflowGraph are
		// independent of that guard and are exercised in full).
		kind: "workflow",
		workflowState: { goal: "g", currentNode: "n1", visits: {}, vars: {}, index: 0, rollup: [] },
		parentNodeId: "node-a",
		branchIndex: 2,
		subagents: SUBAGENTS,
		workflowGraph: WORKFLOW_GRAPH,
		traceId: TRACE_ID,
	};
	await new FileStore(stateDir).save({ agents: [persisted], transcripts: {}, features: [] });

	const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true });
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new ReadyDriver();
	await mgr.start(); // hasState() true → reconnectLive (no live host) → adoptOrphanedAgents

	const roster = mgr.list();
	expect(roster.length).toBe(1);
	const dto = roster[0]!;
	expect(dto.id).not.toBe(persisted.id); // create() always mints a fresh id on adoption
	// SUBAGENTS seeds "running" — the create()-restore reseed site closes it at boot (this agent may
	// never run again as-is), so it surfaces here "aborted", not the seeded "running".
	assertLineageFields(dto, undefined, "aborted");

	await mgr.stop();

	const raw = JSON.parse(await fs.readFile(path.join(stateDir, "state.json"), "utf8")) as { agents: PersistedAgent[] };
	assertPersistedLineageFields(raw.agents.find((a) => a.id === dto.id), undefined, "aborted");
});

// ── loadPersisted (--restore) ─────────────────────────────────────────────────

test("loadPersisted: --restore carries all four lineage fields onto the DTO and the next persisted snapshot", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "boot-lineage-restore-state-"));
	const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "boot-lineage-restore-wt-"));
	tmps.push(stateDir, worktree);

	const persisted: PersistedAgent = {
		id: "restore-lineage-1",
		name: "restored",
		repo: "(none)",
		worktree,
		approvalMode: "yolo",
		parentId: "parent-3",
		parentNodeId: "node-a",
		branchIndex: 2,
		subagents: SUBAGENTS,
		workflowGraph: WORKFLOW_GRAPH,
		traceId: TRACE_ID,
	};
	await new FileStore(stateDir).save({ agents: [persisted], transcripts: {}, features: [] });

	const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true });
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new ReadyDriver();

	const n = await mgr.loadPersisted();
	expect(n).toBe(1);

	const roster = mgr.list();
	expect(roster.length).toBe(1);
	const dto = roster[0]!;
	expect(dto.id).not.toBe(persisted.id); // loadPersisted also mints a fresh id via create()
	// Same create()-restore closure as the adopt path above — SUBAGENTS' seeded "running" surfaces here
	// as "aborted".
	assertLineageFields(dto, "parent-3", "aborted");

	await mgr.stop();

	const raw = JSON.parse(await fs.readFile(path.join(stateDir, "state.json"), "utf8")) as { agents: PersistedAgent[] };
	assertPersistedLineageFields(raw.agents.find((a) => a.id === dto.id), "parent-3", "aborted");
});
