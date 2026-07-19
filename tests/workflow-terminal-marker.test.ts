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
	// Prior history threads through UNCHANGED, and the after-action post-mortem rides the thread too —
	// appended asynchronously at the terminal transition (or self-healed at reattach), marker-guarded
	// to exactly one copy regardless of which side of the restart it landed on.
	await waitFor(() => mgr2.getTranscript(dto.id).length === 3);
	const texts = mgr2.getTranscript(dto.id).map((t) => t.text);
	expect(texts.slice(0, 2)).toEqual(["do the thing", "working on it"]);
	expect(texts[2]?.startsWith("📋 After-action report")).toBe(true);
	expect(mgr2.list().find((a) => a.name === "wf-transcript")?.messageCount).toBe(3);
	await mgr2.stop();
});

// Topology review finding 3: reattachTerminal restores a terminal-marked PersistedAgent as an INERT
// record with no live driver connection ever again — the fourth boot path that reseeds persisted
// subagents (alongside create()'s restore reseed and restart()). A subagent still "running" in the
// persisted snapshot when the crash/terminal happened would otherwise claim that forever, since no run
// is ever left alive under this record to close it.
test("a persisted 'running' subagent is closed when its terminal-marked workflow is reattached after a restart", async () => {
	const { mgr: mgr1, repo, stateDir, worktreeBase } = await makeMgr("terminal-subagent-close");
	const host1 = mgr1 as unknown as InternalHost;

	const dto = await mgr1.create({ name: "wf-subagent-terminal", repo, approvalMode: "yolo", verify: "true" });
	const rec1 = host1.agents.get(dto.id)!;
	rec1.agent.emit("checkpoint", runState({ runId: "run-subagent-terminal", currentNode: "n1" }));
	await rec1.checkpointAppending;
	// A subagent still "running" at the moment of the crash — no lifecycle/terminal frame ever closed it.
	rec1.options.subagents = [
		{ id: "prior-done", agent: "explore", status: "completed", index: 0, lastUpdate: Date.now() - 1000 },
		{ id: "orphaned-sub", agent: "worker", status: "running", index: 1, lastUpdate: Date.now() - 500 },
	];
	rec1.agent.emit("event", { type: "workflow_terminal", reason: "poison cap", checkpoint: checkpoint() });
	await waitFor(() => rec1.dto.status === "error");
	await mgr1.stop();

	const mgr2 = new SquadManager({ stateDir, worktreeBase });
	(mgr2 as unknown as DriverFactoryHost).makeDriver = () => new FakeDriver();
	await mgr2.start();

	expect(mgr2.getAgent(dto.id)?.status).toBe("error"); // sanity: still the terminal-reattach path
	const after = mgr2.subagents(dto.id);
	expect(after.find((n) => n.id === "prior-done")?.status).toBe("completed"); // untouched — already terminal
	expect(after.find((n) => n.id === "orphaned-sub")?.status).toBe("aborted"); // closed at reattach, never left "running"
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

// ── OMPSQ-448: continue a RECOVERABLE terminal run in place ─────────────────────────────────────────
// A visit-cap-exhaustion terminal (the fix-up ladder ran out of budget) is recoverable in place; a
// structural dead-end (poison cap, ran-off-the-end) is not. `continueAvailable` gates the webui button.
test("continueAvailable is set for a visit-cap terminal but NOT for a poison-cap/structural terminal", async () => {
	const { mgr, repo } = await makeMgr("continue-derive");
	const host = mgr as unknown as InternalHost;

	const capDto = await mgr.create({ name: "wf-cap", repo, approvalMode: "yolo", verify: "true" });
	const capRec = host.agents.get(capDto.id)!;
	capRec.agent.emit("checkpoint", runState({ runId: "run-cap", currentNode: "escalate" }));
	await capRec.checkpointAppending;
	capRec.agent.emit("event", { type: "workflow_terminal", reason: 'node "escalate" exceeded its visit cap (2)', checkpoint: checkpoint() });
	await waitFor(() => capRec.dto.status === "error");
	expect(capRec.dto.forkAvailable).toBe(true);
	expect(capRec.dto.continueAvailable).toBe(true); // recoverable

	const poisonDto = await mgr.create({ name: "wf-poison", repo, approvalMode: "yolo", verify: "true" });
	const poisonRec = host.agents.get(poisonDto.id)!;
	poisonRec.agent.emit("checkpoint", runState({ runId: "run-poison", currentNode: "n1" }));
	await poisonRec.checkpointAppending;
	poisonRec.agent.emit("event", { type: "workflow_terminal", reason: "resume poison cap: escalated to a human", checkpoint: checkpoint({ resumeAttempts: 3 }) });
	await waitFor(() => poisonRec.dto.status === "error");
	expect(poisonRec.dto.forkAvailable).toBe(true);
	expect(poisonRec.dto.continueAvailable).toBe(false); // structural — fork is the only path

	// A visit-cap on a NON-verify-loop node (an authored, possibly side-effecting node) is NOT
	// continue-able: re-running it in place could re-fire a side effect. Only the fix-up ladder
	// (verify/codefix/fixup/escalate) is recoverable (codex review).
	const deployDto = await mgr.create({ name: "wf-deploy", repo, approvalMode: "yolo", verify: "true" });
	const deployRec = host.agents.get(deployDto.id)!;
	deployRec.agent.emit("checkpoint", runState({ runId: "run-deploy", currentNode: "deploy" }));
	await deployRec.checkpointAppending;
	deployRec.agent.emit("event", { type: "workflow_terminal", reason: 'node "deploy" exceeded its visit cap (1)', checkpoint: checkpoint() });
	await waitFor(() => deployRec.dto.status === "error");
	expect(deployRec.dto.forkAvailable).toBe(true);
	expect(deployRec.dto.continueAvailable).toBe(false); // authored side-effect node — fork only
	await mgr.stop();
});

test("continueRun clears the terminal marker, resets fix-up-tier visits to 0, and re-drives on the SAME worktree", async () => {
	const { mgr, repo } = await makeMgr("continue-run");
	const host = mgr as unknown as InternalHost;
	const dto = await mgr.create({ name: "wf-cont", repo, approvalMode: "yolo", verify: "true" });
	const rec = host.agents.get(dto.id)!;
	const worktreeBefore = rec.dto.worktree;

	// An exhausted fix-up ladder: verify ran 4×, the retry tiers are at their caps.
	rec.agent.emit("checkpoint", runState({ runId: "run-cont", currentNode: "escalate", visits: { verify: 4, codefix: 1, fixup: 3, escalate: 2 } }));
	await rec.checkpointAppending;
	rec.agent.emit("event", { type: "workflow_terminal", reason: 'node "escalate" exceeded its visit cap (2)', checkpoint: checkpoint() });
	await waitFor(() => rec.dto.status === "error");
	expect(rec.options.workflowState?.terminal).toBeDefined();

	await mgr.continueRun(dto.id);

	const state = rec.options.workflowState!;
	expect(state.terminal).toBeUndefined(); // marker cleared → prompt/restart no longer refused
	expect(rec.dto.continueAvailable).toBe(false);
	expect(rec.dto.forkAvailable).toBe(false);
	// Fix-up tiers reset; the goalGate's own count (verify) is carried forward, like fork().
	expect(state.visits.codefix).toBe(0);
	expect(state.visits.fixup).toBe(0);
	expect(state.visits.escalate).toBe(0);
	expect(state.visits.verify).toBe(4);
	expect(rec.dto.worktree).toBe(worktreeBefore); // in place — NOT a fresh fork branch
	await mgr.stop();
});

test("continueRun refuses a non-recoverable (structural) terminal — fork stays the path, marker intact", async () => {
	const { mgr, repo } = await makeMgr("continue-refuse");
	const host = mgr as unknown as InternalHost;
	const dto = await mgr.create({ name: "wf-refuse", repo, approvalMode: "yolo", verify: "true" });
	const rec = host.agents.get(dto.id)!;
	rec.agent.emit("checkpoint", runState({ runId: "run-refuse", currentNode: "n1" }));
	await rec.checkpointAppending;
	rec.agent.emit("event", { type: "workflow_terminal", reason: "ran off the end of the graph", checkpoint: checkpoint() });
	await waitFor(() => rec.dto.status === "error");

	await expect(mgr.continueRun(dto.id)).rejects.toThrow(/not recoverable in place/);
	expect(rec.options.workflowState?.terminal).toBeDefined(); // untouched
	await mgr.stop();
});
