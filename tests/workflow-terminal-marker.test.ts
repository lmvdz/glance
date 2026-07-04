/**
 * Concern 03 (never-lose-work): the manager-side wiring for the append-only checkpoint log + persisted
 * terminal marker — the checkpoint listener's append (excluding transient emissions), the
 * `workflow_terminal` frame handler (persist `workflowState.terminal`, escalate via markCatastrophe,
 * derive `forkAvailable`), the `resumable`/`reconnectLive` exclusions on a simulated restart, and
 * `remove(id, true)` deleting the run's checkpoint-log JSONL.
 */

import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { checkpointLogPath, readCheckpoints } from "../src/workflow/checkpoint-log.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { AgentDTO, PersistedAgent, RpcSessionState } from "../src/types.ts";
import type { EngineCheckpoint, WorkflowRunState } from "../src/workflow/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

class FakeDriver extends EventEmitter implements AgentDriver {
	readonly isReady = true;
	readonly isAlive = true;
	stopped = 0;
	async start(): Promise<void> {}
	async stop(): Promise<void> {
		this.stopped++;
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

interface DriverFactoryHost {
	makeDriver: (p: PersistedAgent, cold?: boolean) => AgentDriver;
}

interface AgentRecordLike {
	dto: AgentDTO;
	agent: AgentDriver;
	options: PersistedAgent;
	checkpointAppending?: Promise<void>;
}

interface InternalHost {
	agents: Map<string, AgentRecordLike>;
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

// (c) a workflow_terminal frame persists workflowState.terminal (with a forkPoint), escalates through
// markCatastrophe (sticky "error"), and derives forkAvailable.
test("workflow_terminal frame marks the run terminal, escalates via markCatastrophe, and sets forkAvailable", async () => {
	const { mgr, repo, stateDir } = await makeMgr("terminal-frame");
	const host = mgr as unknown as InternalHost;

	const dto = await mgr.create({ name: "wf", repo, approvalMode: "yolo", verify: "true" });
	expect(dto.kind).toBe("workflow");
	const rec = host.agents.get(dto.id)!;
	const runId = "run-terminal-c";

	rec.agent.emit("checkpoint", runState({ runId, currentNode: "n1" }));
	await rec.checkpointAppending;
	expect((await readCheckpoints(stateDir, runId)).map((e) => e.seq)).toEqual([0]);

	rec.agent.emit("event", { type: "workflow_terminal", reason: "resume poison cap: escalated to a human", checkpoint: checkpoint({ resumeAttempts: 3 }) });
	await waitFor(() => rec.dto.status === "error");

	expect(rec.dto.error).toContain("CATASTROPHE");
	expect(rec.dto.error).toContain("resume poison cap");
	expect(rec.dto.forkAvailable).toBe(true);
	expect(rec.options.workflowState?.terminal?.reason).toBe("resume poison cap: escalated to a human");
	expect(rec.options.workflowState?.terminal?.forkPoint.runId).toBe(runId);
	expect(rec.options.workflowState?.terminal?.forkPoint.seq).toBe(0); // the one checkpoint entry appended above
	expect(rec.dto.workflowState?.terminal).toEqual(rec.options.workflowState!.terminal);

	await mgr.stop();
});

// The engine's transient per-branch fan-out emissions must never reach the checkpoint log.
test("a transient checkpoint emission is never appended to the checkpoint log", async () => {
	const { mgr, repo, stateDir } = await makeMgr("transient-excluded");
	const host = mgr as unknown as InternalHost;
	const dto = await mgr.create({ name: "wf", repo, approvalMode: "yolo", verify: "true" });
	const rec = host.agents.get(dto.id)!;
	const runId = "run-transient";

	rec.agent.emit("checkpoint", runState({ runId, transient: true, branchOutcomes: { "fork#0:0": { disposition: "succeeded", at: Date.now() } } }));
	// Transient emissions never call appendCheckpoint, so checkpointAppending is never armed — give the
	// (synchronous, listener-only) handler a tick to prove that rather than asserting on an undefined promise.
	await new Promise((r) => setTimeout(r, 20));

	expect(rec.dto.workflowState?.branchOutcomes).toBeDefined(); // live-progress view still updates
	expect(await readCheckpoints(stateDir, runId)).toEqual([]); // but nothing durable was appended
	await mgr.stop();
});

// (d) a terminal-marked persisted agent SURVIVES a restart as a visible, forkable roster entry (D1: never
// overwrite a checkpointed workflow into oblivion) but is NEVER auto-resumed/re-adopted, while a plain
// (non-terminal) resumable checkpoint on a sibling workflow IS re-adopted — proving the exclusion from
// resumption is specific to `terminal`, not a general workflow-adoption regression.
test("a terminal-marked workflow survives a restart as an inert forkable roster entry, unlike a plain resumable one which is re-adopted", async () => {
	const { mgr: mgr1, repo, stateDir, worktreeBase } = await makeMgr("restart-exclude");
	const host1 = mgr1 as unknown as InternalHost;

	const terminalDto = await mgr1.create({ name: "wf-terminal", repo, approvalMode: "yolo", verify: "true" });
	const terminalRec = host1.agents.get(terminalDto.id)!;
	terminalRec.agent.emit("checkpoint", runState({ runId: "run-restart-terminal", currentNode: "n1" }));
	await terminalRec.checkpointAppending;
	terminalRec.agent.emit("event", { type: "workflow_terminal", reason: "ran off the end of the graph", checkpoint: checkpoint() });
	await waitFor(() => terminalRec.dto.status === "error");

	const resumableDto = await mgr1.create({ name: "wf-resumable", repo, approvalMode: "yolo", verify: "true" });
	const resumableRec = host1.agents.get(resumableDto.id)!;
	resumableRec.agent.emit("checkpoint", runState({ runId: "run-restart-resumable", currentNode: "n1" }));
	await resumableRec.checkpointAppending;

	await mgr1.stop();

	const mgr2 = new SquadManager({ stateDir, worktreeBase });
	(mgr2 as unknown as DriverFactoryHost).makeDriver = () => new FakeDriver();
	await mgr2.start();

	const roster2 = mgr2.list();
	const terminalAfterRestart = roster2.find((a) => a.name === "wf-terminal");
	expect(terminalAfterRestart).toBeDefined(); // still visible — the marker survived the restart
	expect(terminalAfterRestart?.id).toBe(terminalDto.id); // reattached under the SAME id (not a fresh re-adopt id)
	expect(terminalAfterRestart?.status).toBe("error"); // sticky catastrophe error, re-derived from the marker
	expect(terminalAfterRestart?.error).toContain("ran off the end of the graph");
	expect(terminalAfterRestart?.forkAvailable).toBe(true);

	const resumableAfterRestart = roster2.find((a) => a.name === "wf-resumable");
	expect(resumableAfterRestart).toBeDefined(); // ordinary resumable adoption unaffected
	expect(resumableAfterRestart?.status).not.toBe("error");

	// mgr2.stop() persists (a full-snapshot replace) before shutting down — the reattached terminal
	// record must survive THAT persist untouched too, proving it no longer depends on ever having been
	// "adopted"/"deferred" to avoid being erased (D1's own "never overwrite into oblivion" intent).
	await mgr2.stop();

	const mgr3 = new SquadManager({ stateDir, worktreeBase });
	(mgr3 as unknown as DriverFactoryHost).makeDriver = () => new FakeDriver();
	await mgr3.start();
	const roster3 = mgr3.list();
	const terminalAfterSecondRestart = roster3.find((a) => a.name === "wf-terminal");
	expect(terminalAfterSecondRestart?.status).toBe("error");
	expect(terminalAfterSecondRestart?.forkAvailable).toBe(true);
	await mgr3.stop();
});

// A "prompt" command against a terminal-marked workflow that survived a restart (reattachTerminal) must
// be refused, not silently re-drive the graph from scratch: `ensureConnected` would otherwise start the
// never-run driver and this prompt would land as ITS "first prompt" (WorkflowDriver.prompt's execRun
// branch), re-entering the exact escalate condition the marker exists to stop.
test("prompt is refused (not re-driven) against a terminal-marked workflow reattached after a restart", async () => {
	const { mgr: mgr1, repo, stateDir, worktreeBase } = await makeMgr("prompt-refused");

	const dto = await mgr1.create({ name: "wf-terminal-prompt", repo, approvalMode: "yolo", verify: "true" });
	const host1 = mgr1 as unknown as InternalHost;
	const rec1 = host1.agents.get(dto.id)!;
	rec1.agent.emit("checkpoint", runState({ runId: "run-prompt-refused", currentNode: "n1" }));
	await rec1.checkpointAppending;
	rec1.agent.emit("event", { type: "workflow_terminal", reason: "poison cap", checkpoint: checkpoint() });
	await waitFor(() => rec1.dto.status === "error");
	await mgr1.stop();

	const mgr2 = new SquadManager({ stateDir, worktreeBase });
	(mgr2 as unknown as DriverFactoryHost).makeDriver = () => new FakeDriver();
	await mgr2.start();
	const host2 = mgr2 as unknown as InternalHost;
	const rec2 = host2.agents.get(dto.id)!;
	expect(rec2.dto.status).toBe("error");

	await mgr2.applyCommand({ type: "prompt", id: dto.id, message: "try again" });

	expect(mgr2.getAgent(dto.id)?.status).toBe("error"); // still sticky — never flipped to working/idle
	await mgr2.stop();
});

// Review finding 9: reattachTerminal used to hardcode `transcript: []` even though the snapshot's
// transcript for this exact id is in scope at the call site (reconnectLive) — a terminal run lost its
// visible history on every restart, right when the operator needs it most to decide whether to fork.
test("a terminal-marked workflow's transcript survives a restart (reattachTerminal threads it through)", async () => {
	const { mgr: mgr1, repo, stateDir, worktreeBase } = await makeMgr("terminal-transcript");
	const host1 = mgr1 as unknown as InternalHost & { agents: Map<string, AgentRecordLike & { transcript: { kind: string; text: string; ts: number }[] }> };

	const dto = await mgr1.create({ name: "wf-transcript", repo, approvalMode: "yolo", verify: "true" });
	const rec1 = host1.agents.get(dto.id)!;
	rec1.agent.emit("checkpoint", runState({ runId: "run-transcript", currentNode: "n1" }));
	await rec1.checkpointAppending;
	// Seed some visible history — exactly what the operator needs to decide whether to fork.
	rec1.transcript.push({ kind: "user", text: "do the thing", ts: Date.now() }, { kind: "assistant", text: "working on it", ts: Date.now() });
	rec1.agent.emit("event", { type: "workflow_terminal", reason: "poison cap", checkpoint: checkpoint() });
	await waitFor(() => rec1.dto.status === "error");
	await mgr1.stop();

	const mgr2 = new SquadManager({ stateDir, worktreeBase });
	(mgr2 as unknown as DriverFactoryHost).makeDriver = () => new FakeDriver();
	await mgr2.start();

	const after = mgr2.list().find((a) => a.name === "wf-transcript");
	expect(after?.status).toBe("error"); // sanity: still the terminal-reattach path
	const transcript = mgr2.getTranscript(dto.id);
	expect(transcript.map((t) => t.text)).toEqual(["do the thing", "working on it"]);
	expect(after?.messageCount).toBe(2);
	await mgr2.stop();
});

// (e) remove(id, deleteWorktree: true) on a workflow agent with a terminal runId deletes its
// checkpoint-log JSONL file.
test("remove(id, true) deletes the checkpoint-log JSONL for a terminal workflow's runId", async () => {
	const { mgr, repo, stateDir } = await makeMgr("remove-deletes-log");
	const host = mgr as unknown as InternalHost;
	const dto = await mgr.create({ name: "wf", repo, approvalMode: "yolo", verify: "true" });
	const rec = host.agents.get(dto.id)!;
	const runId = "run-remove";

	rec.agent.emit("checkpoint", runState({ runId, currentNode: "n1" }));
	await rec.checkpointAppending;
	rec.agent.emit("event", { type: "workflow_terminal", reason: "poison cap", checkpoint: checkpoint() });
	await waitFor(() => rec.dto.status === "error");

	await fs.access(checkpointLogPath(stateDir, runId)); // throws (failing the test) if the file is missing

	await mgr.applyCommand({ type: "remove", id: dto.id, deleteWorktree: true });

	await expect(fs.access(checkpointLogPath(stateDir, runId))).rejects.toThrow();
	await mgr.stop();
});
