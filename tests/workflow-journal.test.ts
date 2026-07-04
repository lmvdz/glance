/**
 * Concern 03 (inspectable-topology): the static workflow graph is journaled exactly once per run — with
 * a real `runId`, before the first node executes — via a `workflow_journal`/`workflow.graph` event emitted
 * at the top of `execRun` (never in `start()`, which would stamp the bogus `:pending` fallback runId and
 * miss resumed/second runs on a reused driver). Also covers `BranchSpec.parentNodeId`/`branchIndex`
 * threading from a workflow fan-out through `spawnFleetBranch` into `create()`'s persisted lineage.
 */

import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { AgentDTO, PersistedAgent, RpcSessionState } from "../src/types.ts";
import { type BranchSpec, WorkflowDriver } from "../src/workflow-driver.ts";
import { parseWorkflow } from "../src/workflow/dot.ts";
import { buildVerifyWorkflow } from "../src/workflow/verify-workflow.ts";
import type { WorkflowRunState } from "../src/workflow/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

type Frame = { type?: string; event?: { type?: string; runId?: string; graph?: { nodes: { id: string; retryTarget?: string }[]; edges: unknown[] } }; [k: string]: unknown };

/** An inner agent that finishes a turn immediately (agent_start → message → agent_end), same shape as
 *  tests/workflow.test.ts's FakeInnerDriver — used everywhere a real omp process must not spawn. */
class FakeInnerDriver extends EventEmitter implements AgentDriver {
	ready = true;
	get isReady(): boolean {
		return this.ready;
	}
	get isAlive(): boolean {
		return true;
	}
	async start(): Promise<void> {}
	async stop(): Promise<void> {
		this.ready = false;
	}
	async prompt(message: string): Promise<void> {
		this.emit("event", { type: "agent_start" });
		this.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `did: ${message.slice(0, 24)}` } });
		this.emit("event", { type: "message_end" });
		this.emit("event", { type: "agent_end" });
	}
	abort(): Promise<unknown> {
		return Promise.resolve();
	}
	getState(): Promise<RpcSessionState> {
		return Promise.resolve({ thinkingLevel: undefined, isStreaming: false, isCompacting: false, steeringMode: "all", followUpMode: "all", interruptMode: "immediate", sessionId: "fake", autoCompactionEnabled: false, messageCount: 0, queuedMessageCount: 0, todoPhases: [] });
	}
	setSessionName(): Promise<unknown> {
		return Promise.resolve();
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

async function writeWorkflow(body: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wfj-"));
	tmps.push(dir);
	const file = path.join(dir, "workflow.fabro");
	await fs.writeFile(file, body);
	return file;
}

const WF = `digraph D {
	start [shape=Mdiamond]
	exit  [shape=Msquare]
	a [label="A"]
	b [label="B"]
	start -> a
	a -> b
	b -> exit
}`;

// ── WorkflowDriver: fresh run ────────────────────────────────────────────────

test("WorkflowDriver: a fresh run journals exactly one workflow.graph event, before any node event, with the real runId", async () => {
	const wf = buildVerifyWorkflow({ command: "check" });
	const driver = new WorkflowDriver({
		id: "j1",
		workflow: wf,
		cwd: os.tmpdir(),
		createInnerDriver: () => new FakeInnerDriver(),
		execCommand: async () => ({ code: 0, stdout: "ok", stderr: "" }),
	});
	const frames: Frame[] = [];
	driver.on("event", (f: Frame) => frames.push(f));
	const done = new Promise<void>((resolve) => driver.on("event", (f: Frame) => f.type === "agent_end" && resolve()));
	await driver.start();
	await driver.prompt("ship the feature");
	await done;

	const journalFrames = frames.filter((f) => f.type === "workflow_journal");
	const graphEvents = journalFrames.filter((f) => f.event?.type === "workflow.graph");
	expect(graphEvents.length).toBe(1);

	const graphIdx = frames.indexOf(graphEvents[0]!);
	const nodeStartIdx = frames.findIndex((f) => f.type === "workflow_journal" && f.event?.type === "workflow.node.start");
	expect(nodeStartIdx).toBeGreaterThan(-1);
	expect(graphIdx).toBeLessThan(nodeStartIdx); // journaled before the first node executes

	const graphEvent = graphEvents[0]!.event!;
	expect(graphEvent.runId).toMatch(/^j1:/); // real runId, not the "j1:pending" emitJournal fallback
	expect(graphEvent.runId).not.toBe("j1:pending");
	// Every other journal event in the same run shares the identical runId — proof the graph event used
	// the run's real assigned id, not a stale/placeholder one.
	const nodeStartRunId = journalFrames.find((f) => f.event?.type === "workflow.node.start")?.event?.runId;
	expect(nodeStartRunId).toBe(graphEvent.runId);

	const graph = graphEvent.graph!;
	expect(graph.nodes.length).toBe(wf.nodes.size);
	expect(graph.edges.length).toBe(wf.edges.length);
	const verifyNode = graph.nodes.find((n) => n.id === "verify");
	expect(verifyNode?.retryTarget).toBe("codefix"); // failure routing edge survives the snapshot

	await driver.stop();
});

test("WorkflowDriver: a resumed run journals the graph again (once), stamped with the resumed run's runId", async () => {
	const wf = parseWorkflow(WF);
	const resumeState: WorkflowRunState = { goal: "g", runId: "j2:priorrun", currentNode: "b", visits: { start: 1, a: 1, b: 1 }, vars: {}, index: 3, rollup: [] };
	const driver = new WorkflowDriver({
		id: "j2",
		workflow: wf,
		cwd: os.tmpdir(),
		createInnerDriver: () => new FakeInnerDriver(),
		resumeState,
	});
	const frames: Frame[] = [];
	driver.on("event", (f: Frame) => frames.push(f));
	const done = new Promise<void>((resolve) => driver.on("event", (f: Frame) => f.type === "agent_end" && resolve()));
	await driver.start(); // resumeState set → start() itself kicks off execRun
	await done;

	const graphEvents = frames.filter((f) => f.type === "workflow_journal" && f.event?.type === "workflow.graph");
	expect(graphEvents.length).toBe(1); // fires again on the resumed run, exactly once
	expect(graphEvents[0]!.event!.runId).toBe("j2:priorrun"); // the resumed run's real id, not a freshly minted one

	await driver.stop();
});

test("WorkflowDriver: an agent that's started but never prompted/resumed never enters execRun — zero workflow.graph events", async () => {
	const file = await writeWorkflow(WF);
	const driver = new WorkflowDriver({
		id: "j3",
		workflowPath: file,
		cwd: path.dirname(file),
		createInnerDriver: () => new FakeInnerDriver(),
	});
	const frames: Frame[] = [];
	driver.on("event", (f: Frame) => frames.push(f));
	await driver.start(); // no resumeState, prompt() never called
	await Promise.resolve();
	await Promise.resolve();

	expect(frames.filter((f) => f.type === "workflow_journal" && f.event?.type === "workflow.graph").length).toBe(0);
	await driver.stop();
});

// ── SquadManager: onAgentEvent consumption ──────────────────────────────────

interface AgentRecordLike {
	dto: AgentDTO;
	options: PersistedAgent;
	agent: EventEmitter;
	run?: unknown;
}

interface ManagerInternals {
	agents: Map<string, AgentRecordLike>;
	onAgentEvent: (rec: AgentRecordLike, frame: { type?: string; [k: string]: unknown }) => void;
	spawnFleetBranch: (repo: string, parentId: string, spec: BranchSpec) => Promise<{ outcome: string; text?: string; notAttempted?: boolean }>;
}

interface DriverFactoryHost {
	makeDriver: (p: PersistedAgent, cold?: boolean) => AgentDriver;
}

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

/** Auto-resolves prompt() into an immediate agent_end, so spawnFleetBranch's runAgentTask never hangs. */
class AutoEndDriver extends EventEmitter implements AgentDriver {
	readonly isReady = true;
	readonly isAlive = true;
	stopped = 0;
	async start(): Promise<void> {}
	async stop(): Promise<void> {
		this.stopped++;
	}
	async prompt(): Promise<void> {
		queueMicrotask(() => this.emit("event", { type: "agent_end" }));
	}
	async abort(): Promise<unknown> {
		return undefined;
	}
	async getState(): Promise<RpcSessionState> {
		return { todoPhases: [], isStreaming: false } as RpcSessionState;
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

async function makeRepo(prefix: string): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
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

async function makeMgr(prefix: string, driverFactory: () => AgentDriver = () => new ReadyDriver()): Promise<{ mgr: SquadManager; repo: string }> {
	const repo = await makeRepo(`${prefix}-repo-`);
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-state-`));
	tmps.push(stateDir);
	const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true });
	await mgr.start();
	(mgr as unknown as DriverFactoryHost).makeDriver = driverFactory;
	return { mgr, repo };
}

const GRAPH_SNAPSHOT = {
	version: 1 as const,
	name: "wf",
	nodes: [
		{ id: "start", kind: "start" as const },
		{ id: "a", kind: "agent" as const, label: "A" },
		{ id: "exit", kind: "exit" as const },
	],
	edges: [
		{ from: "start", to: "a" },
		{ from: "a", to: "exit" },
	],
	start: "start",
	exit: "exit",
};

test("SquadManager: onAgentEvent populates rec.dto.workflowGraph/rec.options.workflowGraph from a workflow.graph journal event", async () => {
	const { mgr, repo } = await makeMgr("wfj-manager");
	const dto = await mgr.create({ name: "wf-agent", repo, approvalMode: "yolo", autoRoute: false });
	const internals = mgr as unknown as ManagerInternals;
	const rec = internals.agents.get(dto.id)!;

	expect(rec.dto.workflowGraph).toBeUndefined();

	internals.onAgentEvent(rec, { type: "workflow_journal", event: { type: "workflow.graph", at: Date.now(), workflow: "wf", runId: "wf-agent:abc", graph: GRAPH_SNAPSHOT } });

	expect(rec.dto.workflowGraph).toEqual(GRAPH_SNAPSHOT);
	expect(rec.options.workflowGraph).toBe(rec.dto.workflowGraph); // one projection, not two

	// Other WorkflowJournalEvent types stay deliberately unconsumed by any journal-specific case — no scope
	// creep into general journal persistence. workflowGraph must not be clobbered/undefined'd, and no new
	// field should appear FROM the journal payload itself.
	const before = { ...rec.dto };
	rec.dto.lastActivity = before.lastActivity - 1000; // force a detectable bump below
	internals.onAgentEvent(rec, { type: "workflow_journal", event: { type: "workflow.node.start", at: Date.now(), workflow: "wf", runId: "wf-agent:abc", nodeId: "a", label: "A" } });
	// Topology review finding 4: a workflow_journal frame falls through to the SAME generic tail every
	// other frame type gets — node.start itself contributes no new field, but `lastActivity` still bumps
	// (proof the TUI's stall detector, tui.ts >120s, never goes stale on a run that only emits journal
	// frames) and emitAgent still fires. Everything the journal payload could have written stays untouched.
	expect(rec.dto.lastActivity).toBeGreaterThan(before.lastActivity - 1000);
	expect({ ...rec.dto, lastActivity: before.lastActivity }).toEqual(before);

	await mgr.stop();
});

test("SquadManager: a workflow.node.start journal frame bumps lastActivity instead of leaving it stale (finding 4)", async () => {
	const { mgr, repo } = await makeMgr("wfj-lastactivity");
	const dto = await mgr.create({ name: "wf-agent-la", repo, approvalMode: "yolo", autoRoute: false });
	const internals = mgr as unknown as ManagerInternals;
	const rec = internals.agents.get(dto.id)!;

	rec.dto.lastActivity = Date.now() - 60_000; // simulate a long-running command node gone "quiet"
	const stale = rec.dto.lastActivity;

	internals.onAgentEvent(rec, { type: "workflow_journal", event: { type: "workflow.node.start", at: Date.now(), workflow: "wf", runId: "wf-agent-la:abc", nodeId: "cmd", label: "cmd" } });

	expect(rec.dto.lastActivity).toBeGreaterThan(stale);
	await mgr.stop();
});

// ── BranchSpec lineage threading ─────────────────────────────────────────────

test("spawnFleetBranch: BranchSpec.parentNodeId/branchIndex thread into create()'s PersistedAgent/AgentDTO", async () => {
	const { mgr, repo } = await makeMgr("wfj-branch", () => new AutoEndDriver());
	const internals = mgr as unknown as ManagerInternals;

	const specA: BranchSpec = { name: "fanout-node", task: "approach a", parentNodeId: "fanout-node", branchIndex: 0 };
	const specB: BranchSpec = { name: "fanout-node", task: "approach b", parentNodeId: "fanout-node", branchIndex: 1 };

	const [rA, rB] = await Promise.all([internals.spawnFleetBranch(repo, "parent-1", specA), internals.spawnFleetBranch(repo, "parent-1", specB)]);
	expect(rA.outcome).toBe("succeeded");
	expect(rB.outcome).toBe("succeeded");

	const roster = mgr.list();
	const a = roster.find((d) => d.branchIndex === 0 && d.parentNodeId === "fanout-node");
	const b = roster.find((d) => d.branchIndex === 1 && d.parentNodeId === "fanout-node");
	expect(a).toBeDefined();
	expect(b).toBeDefined();
	expect(a!.id).not.toBe(b!.id); // distinct agents despite identical dto.name (siblings of one fan-out node)

	await mgr.stop();
});
