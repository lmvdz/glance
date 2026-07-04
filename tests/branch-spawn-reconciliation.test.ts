/**
 * Concern 02 (never-lose-work): squad-manager's private createInternal spawn path with a deterministic,
 * attacker-unreachable id parameter; spawnFleetBranch rebuilt on top of it with ids derived from
 * (runId, nodeId, visitIndex, branchIndex); the stop-and-reprompt reconciliation protocol for a cold
 * resume of a parallel node; and the two adjacent guard holes (restart() cold:true for workflow agents,
 * applyCommand's unknown-command default case).
 */

import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { LOCAL_ACTOR } from "../src/federation.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SubagentTracker } from "../src/subagents.ts";
import type { AgentDTO, ClientCommand, CreateAgentOptions, PersistedAgent, RpcSessionState } from "../src/types.ts";
import { type BranchSpec, deriveBranchAgentId } from "../src/workflow-driver.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

class FakeDriver extends EventEmitter implements AgentDriver {
	readonly isReady = true;
	readonly isAlive = true;
	stopped = 0;
	prompted: string[] = [];
	async start(): Promise<void> {}
	async stop(): Promise<void> {
		this.stopped++;
	}
	async prompt(message: string): Promise<void> {
		this.prompted.push(message);
		// Listeners (runAgentTask's onEvent) are attached before prompt() is ever called, so resolving
		// "agent_end" from inside prompt() itself is safe and keeps every test's spawnFleetBranch call fast.
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

interface FakeAgentRecord {
	dto: AgentDTO;
	agent: AgentDriver;
	options: PersistedAgent;
	transcript: unknown[];
	assistantBuf: string;
	thinkingBuf: string;
	streaming: boolean;
	subs: SubagentTracker;
	toolEntries: Map<string, unknown>;
}

interface DriverFactoryHost {
	makeDriver: (p: PersistedAgent, cold?: boolean) => AgentDriver;
}

interface InternalHost {
	agents: Map<string, FakeAgentRecord>;
	createInternal(opts: CreateAgentOptions & { explicitId: string }, actor?: unknown): Promise<AgentDTO>;
	spawnFleetBranch(repo: string, parentId: string, spec: BranchSpec): Promise<{ outcome: string; text?: string }>;
	reconcileParallelResume(p: PersistedAgent): Promise<void>;
	restart(rec: FakeAgentRecord): Promise<void>;
	attachExisting(p: PersistedAgent, transcript?: unknown[]): Promise<void>;
}

function fakeRecord(dto: AgentDTO, agent: AgentDriver, options: PersistedAgent): FakeAgentRecord {
	return { dto, agent, options, transcript: [], assistantBuf: "", thinkingBuf: "", streaming: false, subs: new SubagentTracker(), toolEntries: new Map() };
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

async function makeMgr(prefix: string, opts: { replaySettleTimeoutMs?: number } = {}): Promise<{ mgr: SquadManager; repo: string; worktreeBase: string }> {
	const repo = await makeRepo(`${prefix}-repo-`);
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-state-`));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-wt-`));
	tmps.push(stateDir, worktreeBase);
	const mgr = new SquadManager({ stateDir, worktreeBase, ...opts });
	await mgr.start();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new FakeDriver();
	return { mgr, repo, worktreeBase };
}

// (a) createInternal with a duplicate id throws before any worktree/spawn side effect runs.
test("createInternal rejects a duplicate explicit id before any worktree/spawn side effect", async () => {
	const { mgr, repo, worktreeBase } = await makeMgr("dup-id");
	const host = mgr as unknown as InternalHost;
	const dto = await mgr.create({ name: "first", repo, approvalMode: "yolo" });
	const before = await fs.readdir(worktreeBase);

	await expect(host.createInternal({ repo, name: "second", approvalMode: "yolo", explicitId: dto.id }, LOCAL_ACTOR)).rejects.toThrow(/already in use/);

	// No new worktree cut, no new roster entry — the duplicate check ran ahead of createWithId's body.
	expect(await fs.readdir(worktreeBase)).toEqual(before);
	expect(mgr.list().length).toBe(1);
	await mgr.stop();
});

// (b) a wire-level {type:"create", options:{...}} command whose JSON body includes an injected
// explicitId-shaped key is silently ignored — the field never reaches createWithId's explicitId param.
test("wire-level create command with an injected explicitId-shaped field never influences the resulting agent id", async () => {
	const { mgr, repo } = await makeMgr("wire-id");
	const cmd = { type: "create", options: { repo, name: "victim", approvalMode: "yolo", explicitId: "attacker-chosen-id" } } as unknown as ClientCommand;

	await mgr.applyCommand(cmd, LOCAL_ACTOR);

	const roster = mgr.list();
	expect(roster.length).toBe(1);
	expect(roster[0]!.id).not.toBe("attacker-chosen-id");
	await mgr.stop();
});

// (c) spawnFleetBranch called twice with the same (runId, branchKey) produces the same agent id both
// times — and, per createInternal's documented ordering requirement, a same-id re-spawn without first
// clearing the stale roster entry is rejected as a collision (proving the guard is live, not incidental).
test("spawnFleetBranch derives the same deterministic agent id for the same (runId, branchKey)", async () => {
	const { mgr, repo } = await makeMgr("branch-id");
	const host = mgr as unknown as InternalHost;
	const spec: BranchSpec = { name: "branch-a", task: "do the thing", runId: "run-xyz", branchKey: "fork#0:0" };
	const expectedId = deriveBranchAgentId("run-xyz", "fork#0:0", "branch-a");

	const r1 = await host.spawnFleetBranch(repo, "parent-1", spec);
	expect(r1.outcome).toBe("succeeded");
	expect(host.agents.has(expectedId)).toBe(true); // the branch agent stays in the roster after its turn

	// Re-running the exact same fan-out slot WITHOUT tearing down the stale record first must collide —
	// this is exactly the ordering hazard reconcileParallelResume exists to prevent.
	await expect(host.spawnFleetBranch(repo, "parent-1", spec)).rejects.toThrow(/already in use/);

	// Once the stale record is stopped/removed (what reconciliation does), the same id is free again.
	const stale = host.agents.get(expectedId)!;
	await stale.agent.stop();
	host.agents.delete(expectedId);

	const r2 = await host.spawnFleetBranch(repo, "parent-1", spec);
	expect(r2.outcome).toBe("succeeded");
	expect(host.agents.has(expectedId)).toBe(true);
	await mgr.stop();
});

const PARALLEL_GRAPH = `
digraph g {
	start [shape=Mdiamond];
	fork [shape=component];
	branch_a [shape=box];
	branch_b [shape=box];
	merge [shape=tripleoctagon];
	ex [shape=Msquare];
	start -> fork;
	fork -> branch_a;
	fork -> branch_b;
	branch_a -> merge;
	branch_b -> merge;
	merge -> ex;
}
`;

// (d) reconcileParallelResume stops a live roster agent whose id matches a not_attempted expected key
// AND a live roster agent whose id matches a succeeded expected key, leaving no live agent under either
// id before the resumed runParallel runs.
test("reconcileParallelResume stops live roster agents under both a not_attempted and a succeeded expected branch key", async () => {
	const { mgr } = await makeMgr("reconcile");
	const host = mgr as unknown as InternalHost;

	const graphDir = await fs.mkdtemp(path.join(os.tmpdir(), "reconcile-graph-"));
	tmps.push(graphDir);
	const graphPath = path.join(graphDir, "wf.fabro");
	await fs.writeFile(graphPath, PARALLEL_GRAPH);

	const runId = "run-1";
	const idNotAttempted = deriveBranchAgentId(runId, "fork#0:0", "branch_a");
	const idSucceeded = deriveBranchAgentId(runId, "fork#0:1", "branch_b");

	const driverA = new FakeDriver();
	const driverB = new FakeDriver();
	const stubDto = (id: string, name: string): AgentDTO => ({
		id,
		name,
		status: "working",
		repo: "(none)",
		worktree: `/tmp/${name}`,
		approvalMode: "yolo",
		pending: [],
		lastActivity: Date.now(),
		messageCount: 0,
		kind: "omp-operator",
	});
	const stubOptions = (id: string, name: string): PersistedAgent => ({ id, name, repo: "(none)", worktree: `/tmp/${name}`, approvalMode: "yolo" });
	host.agents.set(idNotAttempted, fakeRecord(stubDto(idNotAttempted, "branch_a"), driverA, stubOptions(idNotAttempted, "branch_a")));
	host.agents.set(idSucceeded, fakeRecord(stubDto(idSucceeded, "branch_b"), driverB, stubOptions(idSucceeded, "branch_b")));

	const p: PersistedAgent = {
		id: "wf-1",
		name: "wf",
		repo: "(none)",
		worktree: "/tmp/wf",
		approvalMode: "yolo",
		kind: "workflow",
		workflow: { path: graphPath },
		workflowState: {
			goal: "g",
			currentNode: "fork",
			visits: { fork: 0 },
			vars: {},
			index: 0,
			rollup: [],
			runId,
			branchOutcomes: {
				"fork#0:0": { disposition: "not_attempted", at: Date.now() },
				"fork#0:1": { disposition: "succeeded", at: Date.now(), text: "done" },
			},
		},
	};

	await host.reconcileParallelResume(p);

	expect(driverA.stopped).toBe(1);
	expect(driverB.stopped).toBe(1);
	expect(host.agents.has(idNotAttempted)).toBe(false);
	expect(host.agents.has(idSucceeded)).toBe(false);
	await mgr.stop();
});

// (d2) reconcileParallelResume only remembers a stopped id in `reconciledStops` for a still-`not_attempted`
// key — a resolved (succeeded/failed) key is never re-spawned by spawnFleetBranch, so nothing should ever
// consume it, and the set must not grow for it.
test("reconcileParallelResume only tracks reconciledStops for not_attempted keys, not resolved ones", async () => {
	const { mgr } = await makeMgr("reconcile-stops-scope");
	const host = mgr as unknown as InternalHost & { reconciledStops: Set<string> };

	const graphDir = await fs.mkdtemp(path.join(os.tmpdir(), "reconcile-stops-graph-"));
	tmps.push(graphDir);
	const graphPath = path.join(graphDir, "wf.fabro");
	await fs.writeFile(graphPath, PARALLEL_GRAPH);

	const runId = "run-scope";
	const idNotAttempted = deriveBranchAgentId(runId, "fork#0:0", "branch_a");
	const idSucceeded = deriveBranchAgentId(runId, "fork#0:1", "branch_b");
	const stubDto = (id: string, name: string): AgentDTO => ({ id, name, status: "working", repo: "(none)", worktree: `/tmp/${name}`, approvalMode: "yolo", pending: [], lastActivity: Date.now(), messageCount: 0, kind: "omp-operator" });
	const stubOptions = (id: string, name: string): PersistedAgent => ({ id, name, repo: "(none)", worktree: `/tmp/${name}`, approvalMode: "yolo" });
	host.agents.set(idNotAttempted, fakeRecord(stubDto(idNotAttempted, "branch_a"), new FakeDriver(), stubOptions(idNotAttempted, "branch_a")));
	host.agents.set(idSucceeded, fakeRecord(stubDto(idSucceeded, "branch_b"), new FakeDriver(), stubOptions(idSucceeded, "branch_b")));

	const p: PersistedAgent = {
		id: "wf-scope",
		name: "wf",
		repo: "(none)",
		worktree: "/tmp/wf-scope",
		approvalMode: "yolo",
		kind: "workflow",
		workflow: { path: graphPath },
		workflowState: {
			goal: "g",
			currentNode: "fork",
			visits: { fork: 0 },
			vars: {},
			index: 0,
			rollup: [],
			runId,
			branchOutcomes: {
				"fork#0:0": { disposition: "not_attempted", at: Date.now() },
				"fork#0:1": { disposition: "succeeded", at: Date.now(), text: "done" },
			},
		},
	};

	await host.reconcileParallelResume(p);

	expect(host.reconciledStops.has(idNotAttempted)).toBe(true);
	expect(host.reconciledStops.has(idSucceeded)).toBe(false); // never re-spawned — must not linger in the set
	await mgr.stop();
});

// (f) The WARM reattach path (attachExisting, the sole caller of reconcileParallelResume that runs with
// cold unset) reconciles a stale live branch child left over from before a restart BEFORE the resumed
// workflow gets a chance to re-enter the same fan-out slot — this is the significant bug: previously only
// restart()'s cold path called reconcileParallelResume, so a warm reattach (the common graceful-restart
// case) re-ran the parallel node's fan-out straight into the still-live old branch id and createInternal's
// duplicate-id guard tore down the ENTIRE fan-out.
test("attachExisting reconciles a stale live branch agent before resuming a warm (non-cold) workflow reattach", async () => {
	const { mgr } = await makeMgr("warm-reconcile", { replaySettleTimeoutMs: 20 });
	const host = mgr as unknown as InternalHost;

	const graphDir = await fs.mkdtemp(path.join(os.tmpdir(), "warm-reconcile-graph-"));
	tmps.push(graphDir);
	const graphPath = path.join(graphDir, "wf.fabro");
	await fs.writeFile(graphPath, PARALLEL_GRAPH);

	const runId = "run-warm";
	const staleId = deriveBranchAgentId(runId, "fork#0:0", "branch_a");
	const staleDriver = new FakeDriver();
	const stubDto = (id: string, name: string): AgentDTO => ({ id, name, status: "working", repo: "(none)", worktree: `/tmp/${name}`, approvalMode: "yolo", pending: [], lastActivity: Date.now(), messageCount: 0, kind: "omp-operator" });
	const stubOptions = (id: string, name: string): PersistedAgent => ({ id, name, repo: "(none)", worktree: `/tmp/${name}`, approvalMode: "yolo" });
	host.agents.set(staleId, fakeRecord(stubDto(staleId, "branch_a"), staleDriver, stubOptions(staleId, "branch_a")));

	const persisted: PersistedAgent = {
		id: "wf-warm",
		name: "wf",
		repo: "(none)",
		worktree: "/tmp/wf-warm",
		approvalMode: "yolo",
		kind: "workflow",
		workflow: { path: graphPath },
		workflowState: {
			goal: "g",
			currentNode: "fork",
			visits: { fork: 0 },
			vars: {},
			index: 0,
			rollup: [],
			runId,
			branchOutcomes: {
				"fork#0:0": { disposition: "not_attempted", at: Date.now() },
				"fork#0:1": { disposition: "not_attempted", at: Date.now() },
			},
		},
	};

	// This is NOT the cold-adopt path — attachExisting is reconnectLive's warm reattach, and never passes
	// cold:true to makeDriver. Reconciliation must run here regardless.
	await host.attachExisting(persisted, []);

	expect(staleDriver.stopped).toBe(1);
	expect(host.agents.has(staleId)).toBe(false);
	await mgr.stop();
});

// (g) Companion to (f): the re-spawn that follows a reconciled stop appends the "resuming after a restart"
// addendum to the branch's task; a fresh, never-reconciled spawn under a different key does not.
test("spawnFleetBranch appends the restart addendum only for a reconciled (previously-stopped) branch id", async () => {
	const { mgr, repo } = await makeMgr("reprompt-addendum");
	const host = mgr as unknown as InternalHost;

	const graphDir = await fs.mkdtemp(path.join(os.tmpdir(), "reprompt-graph-"));
	tmps.push(graphDir);
	const graphPath = path.join(graphDir, "wf.fabro");
	await fs.writeFile(graphPath, PARALLEL_GRAPH);

	const runId = "run-reprompt";
	const staleId = deriveBranchAgentId(runId, "fork#0:0", "branch_a");
	const staleDriver = new FakeDriver();
	const stubDto = (id: string, name: string): AgentDTO => ({ id, name, status: "working", repo: "(none)", worktree: `/tmp/${name}`, approvalMode: "yolo", pending: [], lastActivity: Date.now(), messageCount: 0, kind: "omp-operator" });
	const stubOptions = (id: string, name: string): PersistedAgent => ({ id, name, repo: "(none)", worktree: `/tmp/${name}`, approvalMode: "yolo" });
	host.agents.set(staleId, fakeRecord(stubDto(staleId, "branch_a"), staleDriver, stubOptions(staleId, "branch_a")));

	const p: PersistedAgent = {
		id: "wf-reprompt",
		name: "wf",
		repo: "(none)",
		worktree: "/tmp/wf-reprompt",
		approvalMode: "yolo",
		kind: "workflow",
		workflow: { path: graphPath },
		workflowState: {
			goal: "g",
			currentNode: "fork",
			visits: { fork: 0 },
			vars: {},
			index: 0,
			rollup: [],
			runId,
			branchOutcomes: { "fork#0:0": { disposition: "not_attempted", at: Date.now() } },
		},
	};

	await host.reconcileParallelResume(p);
	expect(staleDriver.stopped).toBe(1);

	const reconciledSpec: BranchSpec = { name: "branch_a", task: "do the thing", runId, branchKey: "fork#0:0" };
	const r1 = await host.spawnFleetBranch(repo, "wf-reprompt", reconciledSpec);
	expect(r1.outcome).toBe("succeeded");
	const reconciledRec = host.agents.get(staleId)!;
	expect((reconciledRec.agent as FakeDriver).prompted[0]).toBe("do the thing\n\n(Resuming after a restart — prior partial work may already exist in this worktree; continue from where it left off.)");

	// A fresh spawn under a key that was never reconciled must NOT carry the addendum.
	const freshSpec: BranchSpec = { name: "branch_b", task: "do another thing", runId, branchKey: "fork#0:1" };
	const r2 = await host.spawnFleetBranch(repo, "wf-reprompt", freshSpec);
	expect(r2.outcome).toBe("succeeded");
	const freshId = deriveBranchAgentId(runId, "fork#0:1", "branch_b");
	const freshRec = host.agents.get(freshId)!;
	expect((freshRec.agent as FakeDriver).prompted[0]).toBe("do another thing");

	await mgr.stop();
});

// (e) restart() on a workflow-kind agent passes cold:true into makeDriver.
test("restart() passes cold:true into makeDriver for a workflow-kind agent (closes the poison-cap bypass)", async () => {
	const { mgr } = await makeMgr("restart-cold");
	const host = mgr as unknown as InternalHost;
	const calls: Array<boolean | undefined> = [];
	(mgr as unknown as DriverFactoryHost).makeDriver = (_p, cold) => {
		calls.push(cold);
		return new FakeDriver();
	};

	const options: PersistedAgent = { id: "wf-restart", name: "wf", repo: "(none)", worktree: "/tmp/wf-r", approvalMode: "yolo", kind: "workflow", workflow: { path: "/nonexistent.fabro" } };
	const dto: AgentDTO = { id: "wf-restart", name: "wf", status: "idle", repo: "(none)", worktree: "/tmp/wf-r", approvalMode: "yolo", pending: [], lastActivity: Date.now(), messageCount: 0, kind: "workflow" };
	const rec = fakeRecord(dto, new FakeDriver(), options);
	host.agents.set("wf-restart", rec);

	await host.restart(rec);

	expect(calls).toEqual([true]);
	await mgr.stop();
});

// Companion to (e): a non-workflow agent's restart must NOT flip to cold (no poison cap concept applies).
test("restart() does not pass cold for a non-workflow agent", async () => {
	const { mgr } = await makeMgr("restart-warm");
	const host = mgr as unknown as InternalHost;
	const calls: Array<boolean | undefined> = [];
	(mgr as unknown as DriverFactoryHost).makeDriver = (_p, cold) => {
		calls.push(cold);
		return new FakeDriver();
	};

	const options: PersistedAgent = { id: "op-restart", name: "op", repo: "(none)", worktree: "/tmp/op-r", approvalMode: "yolo", kind: "omp-operator" };
	const dto: AgentDTO = { id: "op-restart", name: "op", status: "idle", repo: "(none)", worktree: "/tmp/op-r", approvalMode: "yolo", pending: [], lastActivity: Date.now(), messageCount: 0, kind: "omp-operator" };
	const rec = fakeRecord(dto, new FakeDriver(), options);
	host.agents.set("op-restart", rec);

	await host.restart(rec);

	expect(calls).toEqual([false]);
	await mgr.stop();
});

// (f) applyCommand with an unrecognized cmd.type throws rather than returning silently.
test("applyCommand throws on an unrecognized command type instead of silently no-oping", async () => {
	const { mgr } = await makeMgr("unknown-cmd");
	const host = mgr as unknown as InternalHost;
	const dto: AgentDTO = { id: "any-1", name: "any", status: "idle", repo: "(none)", worktree: "/tmp/any", approvalMode: "yolo", pending: [], lastActivity: Date.now(), messageCount: 0, kind: "omp-operator" };
	host.agents.set("any-1", fakeRecord(dto, new FakeDriver(), { id: "any-1", name: "any", repo: "(none)", worktree: "/tmp/any", approvalMode: "yolo" }));

	await expect(mgr.applyCommand({ type: "bogus", id: "any-1" } as unknown as ClientCommand, LOCAL_ACTOR)).rejects.toThrow(/unknown command type/);
	await mgr.stop();
});
