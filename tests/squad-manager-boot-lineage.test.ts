/**
 * Concern 01 (inspectable-topology): `parentNodeId`/`branchIndex`/`subagents`/`workflowGraph` are new
 * lineage/topology fields on `CreateAgentOptions`/`PersistedAgent`/`AgentDTO`. Every boot path that
 * reconstructs an `AgentRecord` from persisted state builds `dto`/`persisted` as EXPLICIT field-literal
 * objects (nothing "rides along automatically") — so each of the three restore call sites needs its own
 * round-trip proof: persist an agent carrying all four fields, boot via that path, assert the fields
 * survive on both the resulting `AgentDTO` and the NEXT persisted `state.json` snapshot.
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

/** Every lineage/topology field this concern threads, for building fixtures + assertions. */
function assertLineageFields(dto: AgentDTO | undefined, expectedParentId: string | undefined): void {
	expect(dto).toBeDefined();
	expect(dto?.parentId).toBe(expectedParentId);
	expect(dto?.parentNodeId).toBe("node-a");
	expect(dto?.branchIndex).toBe(2);
	expect(dto?.subagents).toEqual(SUBAGENTS);
	expect(dto?.workflowGraph).toEqual(WORKFLOW_GRAPH);
}

function assertPersistedLineageFields(p: PersistedAgent | undefined, expectedParentId: string | undefined): void {
	expect(p).toBeDefined();
	expect(p?.parentId).toBe(expectedParentId);
	expect(p?.parentNodeId).toBe("node-a");
	expect(p?.branchIndex).toBe(2);
	expect(p?.subagents).toEqual(SUBAGENTS);
	expect(p?.workflowGraph).toEqual(WORKFLOW_GRAPH);
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
	};
	await new FileStore(stateDir).save({ agents: [persisted], transcripts: {}, features: [] });

	const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true });
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new ReadyDriver();
	await mgr.start(); // hasState() true → reconnectLive (no live host) → adoptOrphanedAgents

	const roster = mgr.list();
	expect(roster.length).toBe(1);
	const dto = roster[0]!;
	expect(dto.id).not.toBe(persisted.id); // create() always mints a fresh id on adoption
	assertLineageFields(dto, undefined);

	await mgr.stop();

	const raw = JSON.parse(await fs.readFile(path.join(stateDir, "state.json"), "utf8")) as { agents: PersistedAgent[] };
	assertPersistedLineageFields(raw.agents.find((a) => a.id === dto.id), undefined);
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
	assertLineageFields(dto, "parent-3");

	await mgr.stop();

	const raw = JSON.parse(await fs.readFile(path.join(stateDir, "state.json"), "utf8")) as { agents: PersistedAgent[] };
	assertPersistedLineageFields(raw.agents.find((a) => a.id === dto.id), "parent-3");
});
