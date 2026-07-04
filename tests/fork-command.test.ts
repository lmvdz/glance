/**
 * Concern 04 (never-lose-work): fork(id, {seq?}) on SquadManager — git branch-from-checkpoint,
 * fix-up-tier visit reset, currentNode/worktree validation, one-live-fork-per-source-runId, the
 * spawn-identity invariant (id/branch/worktree all derived from the SAME new id), the ClientCommand
 * "fork" wiring through applyCommand, and the read-only checkpoints projection (never `vars`).
 */

import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { LOCAL_ACTOR } from "../src/federation.ts";
import { appendCheckpoint } from "../src/workflow/checkpoint-log.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SubagentTracker } from "../src/subagents.ts";
import type { AgentDTO, ClientCommand, PersistedAgent, RpcSessionState } from "../src/types.ts";
import type { EngineCheckpoint, WorkflowRunState } from "../src/workflow/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

class FakeDriver extends EventEmitter implements AgentDriver {
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
	agent: AgentDriver;
	options: PersistedAgent;
	transcript: unknown[];
	assistantBuf: string;
	thinkingBuf: string;
	streaming: boolean;
	subs: SubagentTracker;
	toolEntries: Map<string, unknown>;
	checkpointAppending?: Promise<void>;
}

interface InternalHost {
	agents: Map<string, AgentRecordLike>;
}

function fakeRecord(dto: AgentDTO, agent: AgentDriver, options: PersistedAgent): AgentRecordLike {
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

async function makeMgr(prefix: string): Promise<{ mgr: SquadManager; repo: string; stateDir: string; worktreeBase: string }> {
	const repo = await makeRepo(`${prefix}-repo-`);
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-state-`));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-wt-`));
	tmps.push(stateDir, worktreeBase);
	const mgr = new SquadManager({ stateDir, worktreeBase });
	await mgr.start();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new FakeDriver();
	return { mgr, repo, stateDir, worktreeBase };
}

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error("waitFor: condition not met before timeout");
		await new Promise((r) => setTimeout(r, 10));
	}
}

const checkpoint = (over: Partial<EngineCheckpoint> = {}): EngineCheckpoint => ({ goal: "g", currentNode: "n1", visits: { n1: 1 }, vars: {}, index: 0, ...over });
const runState = (over: Partial<WorkflowRunState> = {}): WorkflowRunState => ({ goal: "g", currentNode: "n1", visits: { n1: 1 }, vars: {}, index: 0, rollup: [], ...over });

/** Spin up a real verify-loop workflow agent (buildVerifyWorkflow: start→implement→verify→[codefix→
 *  fixup→escalate]→exit), drive it terminal via the concern-03 path, and return the live record. */
async function terminalVerifyAgent(
	prefix: string,
	visits: Record<string, number>,
): Promise<{ mgr: SquadManager; repo: string; worktreeBase: string; dto: AgentDTO; rec: AgentRecordLike; runId: string }> {
	const { mgr, repo, worktreeBase } = await makeMgr(prefix);
	const dto = await mgr.create({ name: prefix, repo, approvalMode: "yolo", verify: "true" });
	const host = mgr as unknown as InternalHost;
	const rec = host.agents.get(dto.id)!;
	const runId = `run-${prefix}`;
	rec.agent.emit("checkpoint", runState({ runId, currentNode: "verify", visits }));
	await rec.checkpointAppending;
	rec.agent.emit("event", { type: "workflow_terminal", reason: "resume poison cap: escalated to a human", checkpoint: checkpoint({ currentNode: "verify", resumeAttempts: 3 }) });
	await waitFor(() => rec.dto.status === "error");
	return { mgr, repo, worktreeBase, dto, rec, runId };
}

// (a) forking a terminal (escalate-exhausted) run resets every fix-up-tier visit count to 0 while
// carrying forward all non-tier visit counts, and the fork's resumeAttempts is 0.
test("fork resets every fix-up-tier visit count while carrying non-tier counts forward, and zeroes resumeAttempts", async () => {
	const { mgr, dto, runId } = await terminalVerifyAgent("fork-a", { verify: 5, codefix: 1, fixup: 3, escalate: 2 });

	const forked = await mgr.fork(dto.id, {}, LOCAL_ACTOR);

	expect(forked.workflowState?.visits.codefix).toBe(0);
	expect(forked.workflowState?.visits.fixup).toBe(0);
	expect(forked.workflowState?.visits.escalate).toBe(0);
	expect(forked.workflowState?.visits.verify).toBe(5); // not a fix-up tier — carried forward
	expect(forked.workflowState?.resumeAttempts).toBe(0);
	expect(forked.workflowState?.forkedFrom).toEqual({ runId, seq: 0 });
	expect(forked.workflowState?.currentNode).toBe("verify");
	expect(forked.workflowState?.terminal).toBeUndefined(); // a fresh run, not terminal

	await mgr.stop();
});

// (g) the forked agent's id, branch name, and worktree path are all derived from the SAME newId.
test("fork derives agent id, branch, and worktree from the same new id (spawn-identity invariant)", async () => {
	const { mgr, dto } = await terminalVerifyAgent("fork-g", { verify: 1, codefix: 1 });

	const forked = await mgr.fork(dto.id, {}, LOCAL_ACTOR);

	expect(forked.id).not.toBe(dto.id);
	expect(forked.branch).toBe(`squad/${forked.id}`);
	const safeBranch = forked.branch!.replace(/[^a-zA-Z0-9._-]/g, "-");
	expect(forked.worktree.includes(safeBranch)).toBe(true);
	expect(forked.name.endsWith("-fork")).toBe(true);

	await mgr.stop();
});

// Review finding 1 (TOCTOU double-fork race): the fork slot is claimed synchronously, before the first
// `await` in fork() — two concurrent fork() calls for the SAME source runId must resolve to exactly one
// winner, never two live forks of the same source.
test("fork claims the slot synchronously — two concurrent fork() calls for the same source resolve to exactly one winner", async () => {
	const { mgr, dto } = await terminalVerifyAgent("fork-race", { verify: 1, codefix: 1 });

	const results = await Promise.allSettled([mgr.fork(dto.id, {}, LOCAL_ACTOR), mgr.fork(dto.id, {}, LOCAL_ACTOR)]);
	const fulfilled = results.filter((r): r is PromiseFulfilledResult<AgentDTO> => r.status === "fulfilled");
	const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
	expect(fulfilled).toHaveLength(1);
	expect(rejected).toHaveLength(1);
	expect((rejected[0]!.reason as Error).message).toMatch(/a fork of this run already exists/);

	// A THIRD attempt after the race settles still correctly refuses — the winner's roster entry now
	// durably occupies the slot, so the source's own `forkAvailable` guard catches it even earlier than
	// the (now-released) in-flight set would.
	await expect(mgr.fork(dto.id, {}, LOCAL_ACTOR)).rejects.toThrow(/this agent has no fork point available/);

	await mgr.stop();
});

// Review finding 2 (orphaned branch on partial failure): `git branch squad/<newId>` runs before
// createInternal; if createInternal throws afterwards (e.g. `git worktree add` failing), the branch must
// be deleted rather than leaked permanently.
test("fork deletes its just-created branch when createInternal fails after branch creation", async () => {
	const { mgr, repo, worktreeBase, dto } = await terminalVerifyAgent("fork-h", { verify: 1, codefix: 1 });

	const branchesOf = async (): Promise<string> => {
		const proc = Bun.spawn(["git", "branch", "--list"], { cwd: repo, stdout: "pipe", stderr: "ignore" });
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		return out;
	};
	const before = await branchesOf(); // the original agent's own `squad/<id>` branch is already present here

	// Force `git worktree add` to fail deterministically for the new fork (without touching the original
	// agent's already-created worktree): strip write permission from worktreeBase so no new entry can be
	// created under it, regardless of the fork's randomly-suffixed id.
	await fs.chmod(worktreeBase, 0o555);
	try {
		await expect(mgr.fork(dto.id, {}, LOCAL_ACTOR)).rejects.toThrow(/git worktree add failed/);
	} finally {
		await fs.chmod(worktreeBase, 0o755);
	}

	const after = await branchesOf();
	expect(after).toBe(before); // fork()'s own `squad/<newId>` branch was cleaned up, not leaked

	await mgr.stop();
});

// Review finding 3: a crash between createInternal's persist of a new fork (forkedFrom recorded) and
// fork()'s own later persist of the source's terminal.supersededBy marker must not leave the source stuck
// forever advertising `forkAvailable: true` for an offer that can never be accepted (every subsequent
// fork attempt would hit the liveFork guard and error "a fork of this run already exists" forever). On
// restart, reconcileForkLineage self-heals the marker from the fork's own persisted `forkedFrom` lineage.
test("restart self-heals a source's supersededBy marker from a fork's persisted forkedFrom lineage", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fork-heal-state-"));
	const sourceWt = await fs.mkdtemp(path.join(os.tmpdir(), "fork-heal-source-wt-"));
	const forkWt = await fs.mkdtemp(path.join(os.tmpdir(), "fork-heal-fork-wt-"));
	tmps.push(stateDir, sourceWt, forkWt);

	const runId = "run-heal-source";
	const sourceAgent: PersistedAgent = {
		id: "wf-heal-source",
		name: "wf",
		repo: "(none)",
		worktree: sourceWt,
		approvalMode: "yolo",
		kind: "workflow",
		workflow: { verify: { command: "true" } },
		// Terminal-marked, NOT yet superseded — the exact state a crash right after createInternal's own
		// persist (but before fork()'s persist) would leave behind.
		workflowState: { goal: "g", currentNode: "verify", visits: {}, vars: {}, index: 0, rollup: [], runId, terminal: { reason: "x", at: Date.now(), forkPoint: { runId, seq: 0 } } },
	};
	const forkAgent: PersistedAgent = {
		id: "wf-heal-fork",
		name: "wf-fork",
		repo: "(none)",
		worktree: forkWt,
		approvalMode: "yolo",
		kind: "workflow",
		workflow: { verify: { command: "true" } },
		workflowState: { goal: "g", currentNode: "verify", visits: {}, vars: {}, index: 0, rollup: [], runId: "run-heal-fork", forkedFrom: { runId, seq: 0 } },
	};
	const { FileStore } = await import("../src/dal/store.ts");
	await new FileStore(stateDir).save({ agents: [sourceAgent, forkAgent], transcripts: {}, features: [] });

	const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true });
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new FakeDriver();
	await mgr.start(); // reconnectLive (reattachTerminal + orphan-adopt the fork) -> reconcileForkLineage

	const roster = mgr.list();
	const source = roster.find((a) => a.id === "wf-heal-source")!;
	expect(source).toBeDefined();
	expect(source.forkAvailable).toBe(false); // no longer advertises an unclaimable offer
	expect(source.workflowState?.terminal?.supersededBy).toBeDefined(); // self-healed from the fork's lineage
	// The healed marker actually names a live fork descended from this source's runId.
	const supersededById = source.workflowState!.terminal!.supersededBy!;
	expect(roster.some((a) => a.id === supersededById)).toBe(true);

	await mgr.stop();
});

// (b) fork refuses when rec.dto.status === "working".
test("fork refuses a currently-working agent", async () => {
	const { mgr } = await makeMgr("fork-b");
	const host = mgr as unknown as InternalHost;
	const dto: AgentDTO = { id: "wf-working", name: "wf", status: "working", repo: "(none)", worktree: "/tmp/wf-working", approvalMode: "yolo", pending: [], lastActivity: Date.now(), messageCount: 0, kind: "workflow", forkAvailable: true };
	const options: PersistedAgent = {
		id: "wf-working",
		name: "wf",
		repo: "(none)",
		worktree: "/tmp/wf-working",
		approvalMode: "yolo",
		kind: "workflow",
		workflow: { verify: { command: "true" } },
		workflowState: { goal: "g", currentNode: "verify", visits: {}, vars: {}, index: 0, rollup: [], runId: "run-working", terminal: { reason: "x", at: Date.now(), forkPoint: { runId: "run-working", seq: 0 } } },
	};
	host.agents.set("wf-working", fakeRecord(dto, new FakeDriver(), options));

	await expect(mgr.fork("wf-working", {}, LOCAL_ACTOR)).rejects.toThrow(/cannot fork a running agent/);
	await mgr.stop();
});

// (c) fork refuses a second time for the same source runId while a live fork exists.
test("fork refuses a second fork of the same source runId while a live fork exists", async () => {
	const { mgr } = await makeMgr("fork-c");
	const host = mgr as unknown as InternalHost;
	const runId = "run-c";
	const originalDto: AgentDTO = { id: "wf-c-original", name: "wf", status: "idle", repo: "(none)", worktree: "/tmp/wf-c-original", approvalMode: "yolo", pending: [], lastActivity: Date.now(), messageCount: 0, kind: "workflow", forkAvailable: true };
	const originalOptions: PersistedAgent = {
		id: "wf-c-original",
		name: "wf",
		repo: "(none)",
		worktree: "/tmp/wf-c-original",
		approvalMode: "yolo",
		kind: "workflow",
		workflow: { verify: { command: "true" } },
		workflowState: { goal: "g", currentNode: "verify", visits: {}, vars: {}, index: 0, rollup: [], runId, terminal: { reason: "x", at: Date.now(), forkPoint: { runId, seq: 0 } } },
	};
	host.agents.set("wf-c-original", fakeRecord(originalDto, new FakeDriver(), originalOptions));

	const forkDto: AgentDTO = { id: "wf-c-fork1", name: "wf-fork", status: "idle", repo: "(none)", worktree: "/tmp/wf-c-fork1", approvalMode: "yolo", pending: [], lastActivity: Date.now(), messageCount: 0, kind: "workflow" };
	const forkOptions: PersistedAgent = {
		id: "wf-c-fork1",
		name: "wf-fork",
		repo: "(none)",
		worktree: "/tmp/wf-c-fork1",
		approvalMode: "yolo",
		kind: "workflow",
		workflow: { verify: { command: "true" } },
		workflowState: { goal: "g", currentNode: "verify", visits: {}, vars: {}, index: 0, rollup: [], runId: "run-c-fork1", forkedFrom: { runId, seq: 0 } },
	};
	host.agents.set("wf-c-fork1", fakeRecord(forkDto, new FakeDriver(), forkOptions));

	await expect(mgr.fork("wf-c-original", {}, LOCAL_ACTOR)).rejects.toThrow(/a fork of this run already exists/);
	await mgr.stop();
});

// (c2) ...but once that live fork is itself stopped, or itself terminal-and-superseded-by-a-further-fork,
// it no longer occupies the slot — the ORIGINAL can be forked again.
test("fork allows a second fork once the prior live fork is stopped", async () => {
	const { mgr, stateDir } = await makeMgr("fork-c2");
	const host = mgr as unknown as InternalHost;
	const runId = "run-c2";
	const repo = await makeRepo("fork-c2-orig-repo-");
	const originalDto: AgentDTO = { id: "wf-c2-original", name: "wf", status: "idle", repo, worktree: repo, approvalMode: "yolo", pending: [], lastActivity: Date.now(), messageCount: 0, kind: "workflow", forkAvailable: true };
	const originalOptions: PersistedAgent = {
		id: "wf-c2-original",
		name: "wf",
		repo,
		worktree: repo,
		approvalMode: "yolo",
		kind: "workflow",
		workflow: { verify: { command: "true" } },
		workflowState: { goal: "g", currentNode: "verify", visits: {}, vars: {}, index: 0, rollup: [], runId, terminal: { reason: "x", at: Date.now(), forkPoint: { runId, seq: 0 } } },
	};
	host.agents.set("wf-c2-original", fakeRecord(originalDto, new FakeDriver(), originalOptions));
	await appendCheckpoint(stateDir, runId, { goal: "g", currentNode: "verify", visits: {}, vars: {}, index: 0, rollup: [], runId });

	const forkDto: AgentDTO = { id: "wf-c2-fork1", name: "wf-fork", status: "stopped", repo: "(none)", worktree: "/tmp/wf-c2-fork1", approvalMode: "yolo", pending: [], lastActivity: Date.now(), messageCount: 0, kind: "workflow" };
	const forkOptions: PersistedAgent = { id: "wf-c2-fork1", name: "wf-fork", repo: "(none)", worktree: "/tmp/wf-c2-fork1", approvalMode: "yolo", kind: "workflow", workflowState: { goal: "g", currentNode: "verify", visits: {}, vars: {}, index: 0, rollup: [], runId: "run-c2-fork1", forkedFrom: { runId, seq: 0 } } };
	host.agents.set("wf-c2-fork1", fakeRecord(forkDto, new FakeDriver(), forkOptions));

	const forked = await mgr.fork("wf-c2-original", {}, LOCAL_ACTOR);
	expect(forked.id).not.toBe("wf-c2-original");
	await mgr.stop();
});

// (d) fork against a worktree that no longer exists on disk throws a clear error instead of defaulting
// to repo HEAD.
test("fork refuses when the original worktree is gone from disk", async () => {
	const { mgr, stateDir } = await makeMgr("fork-d");
	const host = mgr as unknown as InternalHost;
	const runId = "run-d";
	await appendCheckpoint(stateDir, runId, { goal: "g", currentNode: "verify", visits: {}, vars: {}, index: 0, rollup: [], runId });

	const dto: AgentDTO = { id: "wf-d", name: "wf", status: "idle", repo: "/tmp/does-not-exist-fork-d-repo", worktree: "/tmp/does-not-exist-fork-d-worktree", approvalMode: "yolo", pending: [], lastActivity: Date.now(), messageCount: 0, kind: "workflow", forkAvailable: true };
	const options: PersistedAgent = {
		id: "wf-d",
		name: "wf",
		repo: "/tmp/does-not-exist-fork-d-repo",
		worktree: "/tmp/does-not-exist-fork-d-worktree",
		approvalMode: "yolo",
		kind: "workflow",
		workflow: { verify: { command: "true" } },
		workflowState: { goal: "g", currentNode: "verify", visits: {}, vars: {}, index: 0, rollup: [], runId, terminal: { reason: "x", at: Date.now(), forkPoint: { runId, seq: 0 } } },
	};
	host.agents.set("wf-d", fakeRecord(dto, new FakeDriver(), options));

	await expect(mgr.fork("wf-d", {}, LOCAL_ACTOR)).rejects.toThrow(/worktree is gone/);
	await mgr.stop();
});

// (e) fork with a seq pointing at a currentNode absent from a re-parsed (edited) graph throws a clear
// validation error.
test("fork refuses a checkpoint whose currentNode no longer exists in a re-parsed (edited) graph", async () => {
	const { mgr, stateDir } = await makeMgr("fork-e");
	const host = mgr as unknown as InternalHost;
	const runId = "run-e";

	const graphDir = await fs.mkdtemp(path.join(os.tmpdir(), "fork-e-graph-"));
	tmps.push(graphDir);
	const graphPath = path.join(graphDir, "wf.fabro");
	await fs.writeFile(graphPath, `digraph g { start [shape=Mdiamond]; removed_node [shape=box]; ex [shape=Msquare]; start -> removed_node; removed_node -> ex; }`);
	await appendCheckpoint(stateDir, runId, { goal: "g", currentNode: "removed_node", visits: {}, vars: {}, index: 0, rollup: [], runId });
	// The graph is edited between the checkpoint being taken and the fork attempt — the node is gone.
	await fs.writeFile(graphPath, `digraph g { start [shape=Mdiamond]; ex [shape=Msquare]; start -> ex; }`);

	const dto: AgentDTO = { id: "wf-e", name: "wf", status: "idle", repo: "(none)", worktree: "/tmp/wf-e", approvalMode: "yolo", pending: [], lastActivity: Date.now(), messageCount: 0, kind: "workflow", forkAvailable: true };
	const options: PersistedAgent = {
		id: "wf-e",
		name: "wf",
		repo: "(none)",
		worktree: "/tmp/wf-e",
		approvalMode: "yolo",
		kind: "workflow",
		workflow: { path: graphPath },
		workflowState: { goal: "g", currentNode: "removed_node", visits: {}, vars: {}, index: 0, rollup: [], runId, terminal: { reason: "x", at: Date.now(), forkPoint: { runId, seq: 0 } } },
	};
	host.agents.set("wf-e", fakeRecord(dto, new FakeDriver(), options));

	await expect(mgr.fork("wf-e", {}, LOCAL_ACTOR)).rejects.toThrow(/no longer exists in the workflow graph/);
	await mgr.stop();
});

// (f) checkpoints() (server.ts's GET /api/agents/:id/checkpoints is a direct passthrough) never includes
// a `vars` key in any returned entry, even though the underlying log line carries one.
test("checkpoints() never returns a `vars` key even though the logged entry carries one", async () => {
	const { mgr } = await makeMgr("fork-f");
	const host = mgr as unknown as InternalHost;
	const dto = await mgr.create({ name: "wf", repo: (await makeRepo("fork-f-repo-")), approvalMode: "yolo", verify: "true" });
	const rec = host.agents.get(dto.id)!;
	const runId = "run-f";
	rec.agent.emit("checkpoint", runState({ runId, currentNode: "verify", vars: { lastOutput: "some tool output" }, outcome: "failed" }));
	await rec.checkpointAppending;

	const entries = await mgr.checkpoints(dto.id);
	expect(entries).toHaveLength(1);
	expect(entries[0]).toEqual({ seq: 0, at: entries[0]!.at, currentNode: "verify", outcome: "failed" });
	expect("vars" in entries[0]!).toBe(false);

	await mgr.stop();
});

// checkpoints() returns [] for an agent with no workflow runId (never throws).
test("checkpoints() returns an empty array for a non-workflow agent", async () => {
	const { mgr, repo } = await makeMgr("fork-f2");
	const dto = await mgr.create({ name: "op", repo, approvalMode: "yolo", autoRoute: false });
	expect(await mgr.checkpoints(dto.id)).toEqual([]);
	await mgr.stop();
});

// applyCommand routes {type:"fork"} through to SquadManager.fork.
test("applyCommand({type:'fork'}) routes to SquadManager.fork", async () => {
	const { mgr } = await makeMgr("fork-cmd");
	const host = mgr as unknown as InternalHost;
	const dto: AgentDTO = { id: "wf-cmd", name: "wf", status: "idle", repo: "(none)", worktree: "/tmp/wf-cmd", approvalMode: "yolo", pending: [], lastActivity: Date.now(), messageCount: 0, kind: "workflow", forkAvailable: false };
	const options: PersistedAgent = { id: "wf-cmd", name: "wf", repo: "(none)", worktree: "/tmp/wf-cmd", approvalMode: "yolo", kind: "workflow", workflowState: { goal: "g", currentNode: "n1", visits: {}, vars: {}, index: 0, rollup: [], runId: "run-cmd" } };
	host.agents.set("wf-cmd", fakeRecord(dto, new FakeDriver(), options));

	// forkAvailable is false, so this reaches SquadManager.fork's own refusal — proving the command
	// actually dispatched into fork() (a wiring mistake would instead hit applyCommand's own
	// "unknown command type" default case or silently no-op).
	await expect(mgr.applyCommand({ type: "fork", id: "wf-cmd" } as ClientCommand, LOCAL_ACTOR)).rejects.toThrow(/no fork point available/);
	await mgr.stop();
});
