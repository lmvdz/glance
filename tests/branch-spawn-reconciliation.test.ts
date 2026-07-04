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

/** Unlike FakeDriver, prompt() never auto-resolves the turn — the test drives "exit" manually (either via
 *  stop(), simulating an operator kill, or via a direct emit(), simulating an unexpected crash) so both
 *  onExit code paths in runAgentTask can be exercised deterministically. */
class HangingDriver extends EventEmitter implements AgentDriver {
	readonly isReady = true;
	readonly isAlive = true;
	stopped = 0;
	async start(): Promise<void> {}
	async stop(): Promise<void> {
		this.stopped++;
		this.emit("exit", { code: 0 }); // stopping the backing process always raises "exit", same as a real driver
	}
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
	spawnFleetBranch(repo: string, parentId: string, spec: BranchSpec): Promise<{ outcome: string; text?: string; notAttempted?: boolean }>;
	reconcileParallelResume(p: PersistedAgent): Promise<void>;
	restart(rec: FakeAgentRecord): Promise<void>;
	attachExisting(p: PersistedAgent, transcript?: unknown[]): Promise<void>;
}

function fakeRecord(dto: AgentDTO, agent: AgentDriver, options: PersistedAgent): FakeAgentRecord {
	return { dto, agent, options, transcript: [], assistantBuf: "", thinkingBuf: "", streaming: false, subs: new SubagentTracker(), toolEntries: new Map() };
}

/** Poll until `predicate` is true — createInternal's real git/worktree side effects can take longer than
 *  a fixed short sleep, so tests that need the branch agent to have registered in the roster before
 *  driving its driver directly poll instead of guessing a delay. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
		await new Promise((r) => setTimeout(r, 5));
	}
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
// times. Review finding 3: spawnFleetBranch is now self-healing — a stale roster record already sitting
// under this exact deterministic id (reconcileParallelResume no-op'd on an unreadable graph, or raced an
// in-flight spawn) is torn down and reused automatically, rather than making createInternal throw and
// aborting every sibling branch in the fan-out over one stale slot.
test("spawnFleetBranch derives the same deterministic agent id for the same (runId, branchKey), self-healing a stale record", async () => {
	const { mgr, repo } = await makeMgr("branch-id");
	const host = mgr as unknown as InternalHost;
	const spec: BranchSpec = { name: "branch-a", task: "do the thing", runId: "run-xyz", branchKey: "fork#0:0" };
	const expectedId = deriveBranchAgentId("run-xyz", "fork#0:0", "branch-a");

	const r1 = await host.spawnFleetBranch(repo, "parent-1", spec);
	expect(r1.outcome).toBe("succeeded");
	expect(host.agents.has(expectedId)).toBe(true); // the branch agent stays in the roster after its turn
	const firstDriver = host.agents.get(expectedId)!.agent as FakeDriver;

	// Re-running the exact same fan-out slot WITHOUT tearing down the stale record first must NOT throw —
	// spawnFleetBranch tears down the stale record itself and proceeds.
	const r2 = await host.spawnFleetBranch(repo, "parent-1", spec);
	expect(r2.outcome).toBe("succeeded");
	expect(host.agents.has(expectedId)).toBe(true);
	expect(firstDriver.stopped).toBe(1); // the stale record was stopped, not left running detached
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
// Review finding 1: reconcileParallelResume used to stop+delete a live roster agent for BOTH partitions
// (not_attempted AND already-resolved), destroying a succeeded/failed branch's transcript/receipts/
// worktree visibility on every resume — contradicting spawnFleetBranch's own contract that a completed
// branch agent stays in the roster. Only the not_attempted (re-spawned) key should ever be touched.
test("reconcileParallelResume stops the not_attempted branch agent but leaves an already-succeeded one untouched", async () => {
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
	expect(driverB.stopped).toBe(0); // resolved (succeeded) — never stopped, never removed
	expect(host.agents.has(idNotAttempted)).toBe(false);
	expect(host.agents.has(idSucceeded)).toBe(true); // stays in the roster for display/audit
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

// (f2) A daemon death between a fork's ENTRY checkpoint (no branchOutcomes yet — the engine only starts
// recording per-branch outcomes once the first branch completes) and the first branch completion must
// still reconcile: an absent branchOutcomes map is treated as "every key not yet attempted," not as
// "nothing to reconcile." Before this fix the three call sites gated on `workflowState?.branchOutcomes`
// being present, so this exact checkpoint shape skipped reconciliation entirely, and the resumed
// runParallel's re-spawn collided with the still-live orphaned branch child under createInternal's
// duplicate-id guard.
test("attachExisting reconciles a stale live branch agent when the fork checkpoint has no branchOutcomes at all", async () => {
	const { mgr } = await makeMgr("warm-reconcile-no-outcomes", { replaySettleTimeoutMs: 20 });
	const host = mgr as unknown as InternalHost;

	const graphDir = await fs.mkdtemp(path.join(os.tmpdir(), "warm-reconcile-no-outcomes-graph-"));
	tmps.push(graphDir);
	const graphPath = path.join(graphDir, "wf.fabro");
	await fs.writeFile(graphPath, PARALLEL_GRAPH);

	const runId = "run-warm-no-outcomes";
	const staleId = deriveBranchAgentId(runId, "fork#0:0", "branch_a");
	const staleDriver = new FakeDriver();
	const stubDto = (id: string, name: string): AgentDTO => ({ id, name, status: "working", repo: "(none)", worktree: `/tmp/${name}`, approvalMode: "yolo", pending: [], lastActivity: Date.now(), messageCount: 0, kind: "omp-operator" });
	const stubOptions = (id: string, name: string): PersistedAgent => ({ id, name, repo: "(none)", worktree: `/tmp/${name}`, approvalMode: "yolo" });
	host.agents.set(staleId, fakeRecord(stubDto(staleId, "branch_a"), staleDriver, stubOptions(staleId, "branch_a")));

	const persisted: PersistedAgent = {
		id: "wf-warm-no-outcomes",
		name: "wf",
		repo: "(none)",
		worktree: "/tmp/wf-warm-no-outcomes",
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
			// No branchOutcomes — the engine emits this shape for the fork's entry checkpoint, before any
			// branch has completed.
		},
	};

	await host.attachExisting(persisted, []);

	expect(staleDriver.stopped).toBe(1);
	expect(host.agents.has(staleId)).toBe(false);
	await mgr.stop();
});

// (f3) Companion to (f2): a key with no recorded disposition (because branchOutcomes is entirely absent)
// is treated the same as not_attempted for reconciledStops bookkeeping — it will be re-run by the resumed
// runParallel, so the restart addendum applies to its re-spawn too.
test("reconcileParallelResume tracks reconciledStops for a key with no recorded outcome when branchOutcomes is absent", async () => {
	const { mgr } = await makeMgr("reconcile-no-outcomes-stops");
	const host = mgr as unknown as InternalHost & { reconciledStops: Set<string> };

	const graphDir = await fs.mkdtemp(path.join(os.tmpdir(), "reconcile-no-outcomes-graph-"));
	tmps.push(graphDir);
	const graphPath = path.join(graphDir, "wf.fabro");
	await fs.writeFile(graphPath, PARALLEL_GRAPH);

	const runId = "run-no-outcomes";
	const idA = deriveBranchAgentId(runId, "fork#0:0", "branch_a");
	const stubDto = (id: string, name: string): AgentDTO => ({ id, name, status: "working", repo: "(none)", worktree: `/tmp/${name}`, approvalMode: "yolo", pending: [], lastActivity: Date.now(), messageCount: 0, kind: "omp-operator" });
	const stubOptions = (id: string, name: string): PersistedAgent => ({ id, name, repo: "(none)", worktree: `/tmp/${name}`, approvalMode: "yolo" });
	host.agents.set(idA, fakeRecord(stubDto(idA, "branch_a"), new FakeDriver(), stubOptions(idA, "branch_a")));

	const p: PersistedAgent = {
		id: "wf-no-outcomes",
		name: "wf",
		repo: "(none)",
		worktree: "/tmp/wf-no-outcomes",
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
			// branchOutcomes absent entirely.
		},
	};

	await host.reconcileParallelResume(p);

	expect(host.reconciledStops.has(idA)).toBe(true);
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

// Review finding 2: restart() resets a workflow's persisted resumeAttempts to 0 before building the
// driver — an operator restart is a deliberate fresh attempt, not a symptom of the crash-loop the poison
// cap exists to catch. Without this, three manual restarts of an otherwise-healthy in-flight node
// cumulatively trip RESUME_ATTEMPT_CAP(3) and permanently terminal-mark it.
test("restart() resets a workflow's persisted resumeAttempts to 0 (operator restart is a fresh attempt)", async () => {
	const { mgr } = await makeMgr("restart-resets-cap");
	const host = mgr as unknown as InternalHost;
	const seenResumeAttempts: Array<number | undefined> = [];
	(mgr as unknown as DriverFactoryHost).makeDriver = (p) => {
		seenResumeAttempts.push(p.workflowState?.resumeAttempts);
		return new FakeDriver();
	};

	const workflowState = { goal: "g", currentNode: "n", visits: {}, vars: {}, index: 0, rollup: [], resumeAttempts: 2 };
	const options: PersistedAgent = { id: "wf-cap", name: "wf", repo: "(none)", worktree: "/tmp/wf-cap", approvalMode: "yolo", kind: "workflow", workflow: { path: "/nonexistent.fabro" }, workflowState };
	const dto: AgentDTO = { id: "wf-cap", name: "wf", status: "idle", repo: "(none)", worktree: "/tmp/wf-cap", approvalMode: "yolo", pending: [], lastActivity: Date.now(), messageCount: 0, kind: "workflow", workflowState };
	const rec = fakeRecord(dto, new FakeDriver(), options);
	host.agents.set("wf-cap", rec);

	await host.restart(rec);

	expect(seenResumeAttempts).toEqual([0]);
	expect(rec.options.workflowState?.resumeAttempts).toBe(0);
	await mgr.stop();
});

// Review finding 4: --restore (loadPersisted) must not restore a branch child still in-flight for its
// workflow parent's current parallel node under a fresh id. `create()` would mint a brand-new agent id
// but reuse the OLD deterministic branch's existingPath/branch (the exact git worktree the crashed
// attempt used) — and the parent's own resumed fan-out re-spawns the SAME deterministic branch id/
// worktree moments later via spawnFleetBranch, racing two roster agents on one git worktree.
test("loadPersisted skips restoring an in-flight branch child of a resumed parallel fan-out", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "restore-fanout-state-"));
	tmps.push(stateDir);
	const graphPath = path.join(stateDir, "wf.fabro");
	await fs.writeFile(graphPath, PARALLEL_GRAPH);

	const runId = "run-restore";
	const idNotAttempted = deriveBranchAgentId(runId, "fork#0:0", "branch_a");
	const idSucceeded = deriveBranchAgentId(runId, "fork#0:1", "branch_b");

	const parent: PersistedAgent = {
		id: "wf-restore",
		name: "wf",
		repo: "(none)",
		worktree: "/tmp/wf-restore",
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
	const inFlightChild: PersistedAgent = { id: idNotAttempted, name: "branch_a", repo: "(none)", worktree: "/tmp/branch-a", approvalMode: "yolo", kind: "omp-operator", parentId: "wf-restore" };
	const resolvedChild: PersistedAgent = { id: idSucceeded, name: "branch_b", repo: "(none)", worktree: "/tmp/branch-b", approvalMode: "yolo", kind: "omp-operator", parentId: "wf-restore" };
	const unrelated: PersistedAgent = { id: "plain-1", name: "plain", repo: "(none)", worktree: "/tmp/plain", approvalMode: "yolo", kind: "omp-operator" };

	await fs.writeFile(path.join(stateDir, "state.json"), JSON.stringify({ version: 1, agents: [parent, inFlightChild, resolvedChild, unrelated], transcripts: {}, features: [] }));

	const mgr = new SquadManager({ stateDir });
	const created: string[] = [];
	(mgr as unknown as { create: (opts: CreateAgentOptions) => Promise<AgentDTO> }).create = async (opts) => {
		created.push(opts.name ?? "");
		return { id: `stub-${opts.name}`, name: opts.name ?? "", status: "idle", repo: "(none)", worktree: "/tmp/stub", approvalMode: "yolo", pending: [], lastActivity: Date.now(), messageCount: 0, kind: "omp-operator" } as AgentDTO;
	};

	await mgr.loadPersisted();

	expect(created).toContain("wf"); // the parent always restores
	expect(created).toContain("branch_b"); // resolved branch restores normally (display/audit, finding 1)
	expect(created).toContain("plain"); // unrelated agent unaffected
	expect(created).not.toContain("branch_a"); // in-flight branch child skipped — parent's fan-out re-spawns it
	await mgr.stop();
});

// Review finding 8: a deliberate operator "kill" of a branch agent must record a PERMANENT "failed"
// disposition, not "not_attempted" — otherwise a resume silently re-spawns a branch the operator just
// killed. applyCommand's "kill" case sets `rec.killedByOperator` before calling `stop()`, which raises
// the same "exit" runAgentTask's onExit listens for.
test("applyCommand kill on a live branch agent records a permanent failed disposition (not re-spawnable)", async () => {
	const { mgr, repo } = await makeMgr("kill-branch");
	const host = mgr as unknown as InternalHost;
	const spec: BranchSpec = { name: "branch-kill", task: "do it", runId: "run-kill", branchKey: "fork#0:0" };
	const expectedId = deriveBranchAgentId("run-kill", "fork#0:0", "branch-kill");

	(mgr as unknown as DriverFactoryHost).makeDriver = () => new HangingDriver();
	const resultPromise = host.spawnFleetBranch(repo, "parent-1", spec);
	// Wait for the branch's OWN turn to actually start (runAgentTask's "branch-start" transition) — the
	// roster record exists earlier (createInternal registers it before start()/persist() even settle), but
	// the exit listener this test depends on isn't registered until runAgentTask runs.
	await waitFor(() => host.agents.get(expectedId)?.dto.status === "working");

	await mgr.applyCommand({ type: "kill", id: expectedId } as unknown as ClientCommand, LOCAL_ACTOR);

	const result = await resultPromise;
	expect(result.outcome).toBe("failed");
	expect(result.notAttempted).toBeFalsy(); // permanent — a resume must never re-spawn a deliberately killed branch
	await mgr.stop();
});

// Companion to the above: an unexpected exit (crash, no kill command involved) must still record
// not_attempted so a resumed fan-out re-spawns it — the fix must not touch the default (non-killed) path.
test("an unexpected branch exit without an operator kill still records not_attempted", async () => {
	const { mgr, repo } = await makeMgr("crash-branch");
	const host = mgr as unknown as InternalHost;
	const spec: BranchSpec = { name: "branch-crash", task: "do it", runId: "run-crash", branchKey: "fork#0:0" };
	const expectedId = deriveBranchAgentId("run-crash", "fork#0:0", "branch-crash");

	let driver!: HangingDriver;
	(mgr as unknown as DriverFactoryHost).makeDriver = () => (driver = new HangingDriver());
	const resultPromise = host.spawnFleetBranch(repo, "parent-1", spec);
	await waitFor(() => host.agents.get(expectedId)?.dto.status === "working");

	driver.emit("exit", { code: 1 }); // simulate a crash — no "kill" command, no killedByOperator flag

	const result = await resultPromise;
	expect(result.outcome).toBe("failed");
	expect(result.notAttempted).toBe(true);
	await mgr.stop();
});
