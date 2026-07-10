/**
 * Steering a workflow-driven unit (G3c) — `WorkflowDriver.prompt`.
 *
 * The FIRST prompt is the run's goal and starts it. Every prompt after that steers the live inner
 * agent. The old guard was `if (!this.runActive)`, which is ALSO true once a run has finished — so an
 * operator steering a completed unit silently re-entered `execRun(message)`: a whole new graph
 * traversal with the steer text as its "goal".
 *
 * Observed live 2026-07-09 while telling a finished unit it had never committed: the workflow re-ran
 * `Implement`, the inner agent (which remembers the original task) replied "the goal is complete",
 * `Verify` re-ran, the run exited, and the instruction was never executed. Nothing reported that the
 * steer had been swallowed. This is the founding brief's R4 — "there is no channel for steering,
 * iteration, or taste — and that's most of the real work".
 *
 * Fakes for the inner agent + exec (the convention of workflow.test.ts / workflow-journal.test.ts); no
 * omp process, no shell.
 */

import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import type { AgentDriver } from "../src/agent-driver.ts";
import type { RpcSessionState } from "../src/types.ts";
import { WorkflowDriver } from "../src/workflow-driver.ts";
import { buildVerifyWorkflow } from "../src/workflow/verify-workflow.ts";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

/** Records every prompt it is handed, and finishes each turn immediately. */
class RecordingInner extends EventEmitter implements AgentDriver {
	prompts: string[] = [];
	alive = true;
	failNext = false;
	get isReady(): boolean {
		return true;
	}
	get isAlive(): boolean {
		return this.alive;
	}
	async start(): Promise<void> {}
	async stop(): Promise<void> {
		this.alive = false;
	}
	async prompt(message: string): Promise<void> {
		this.prompts.push(message);
		if (this.failNext) {
			this.failNext = false;
			throw new Error("agent host is gone");
		}
		this.emit("event", { type: "agent_start" });
		this.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } });
		this.emit("event", { type: "message_end" });
		this.emit("event", { type: "agent_end" });
	}
	abort(): Promise<unknown> {
		return Promise.resolve();
	}
	getState(): Promise<RpcSessionState> {
		return Promise.resolve({} as RpcSessionState);
	}
	respondUi(): void {}
}

/** Like RecordingInner, but holds the turn open until `finishTurn()` — so a test can observe the driver
 *  WHILE the inner agent is mid-turn (the window in which the unit must not look idle). */
class SlowInner extends EventEmitter implements AgentDriver {
	prompts: string[] = [];
	turnStarted = false;
	turnActive = false;
	alive = true;
	/** Emit agent_start, then reject the send — the "ack lost while the agent works" ordering. */
	startTurnThenThrow = false;
	private end?: () => void;
	get isReady(): boolean {
		return true;
	}
	get isAlive(): boolean {
		return this.alive;
	}
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async prompt(message: string): Promise<void> {
		this.prompts.push(message);
		this.turnStarted = true;
		this.turnActive = true;
		this.emit("event", { type: "agent_start" });
		// The driver's `prompt()` awaits this; the turn itself ends later, on `finishTurn()`.
		this.end = () => {
			this.emit("event", { type: "message_end" });
			this.emit("event", { type: "agent_end" });
			this.turnActive = false;
		};
		// Workflow nodes call prompt() and wait for agent_end via the executor, so auto-finish inside a run.
		if (this.prompts.length === 1) this.finishTurn();
		if (this.startTurnThenThrow) {
			this.startTurnThenThrow = false;
			throw new Error("send ack lost");
		}
	}
	finishTurn(): void {
		this.end?.();
		this.end = undefined;
	}
	abort(): Promise<unknown> {
		return Promise.resolve();
	}
	getState(): Promise<RpcSessionState> {
		return Promise.resolve({} as RpcSessionState);
	}
	respondUi(): void {}
}

interface Frame {
	type?: string;
	event?: { type?: string };
	assistantMessageEvent?: { delta?: string };
}

/** A driver whose verify command always passes, so the run reaches `exit` on its own. */
function makeDriver(id: string, inner: AgentDriver): { driver: WorkflowDriver; frames: Frame[] } {
	const driver = new WorkflowDriver({
		id,
		workflow: buildVerifyWorkflow({ command: "check" }),
		cwd: os.tmpdir(),
		createInnerDriver: () => inner,
		execCommand: async () => ({ code: 0, stdout: "ok", stderr: "" }),
	} as never);
	const frames: Frame[] = [];
	driver.on("event", (f: Frame) => frames.push(f));
	return { driver, frames };
}

/** Resolves when the workflow run finishes (`workflow_done` is emitted once per run). */
function runsCompleted(frames: Frame[]): number {
	return frames.filter((f) => f.type === "workflow_done").length;
}

async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
		await Bun.sleep(10);
	}
}

// ── the defect ──────────────────────────────────────────────────────────────────────────────────

test("a prompt AFTER the run has finished steers the inner agent — it does not start a second run", async () => {
	const inner = new RecordingInner();
	const { driver, frames } = makeDriver("s1", inner);
	await driver.start();

	await driver.prompt("ship the feature"); // the goal — starts the run
	await waitFor(() => runsCompleted(frames) === 1);
	const promptsAfterGoal = inner.prompts.length;

	await driver.prompt("you never committed — run git add -A && git commit"); // the steer
	await waitFor(() => inner.prompts.length > promptsAfterGoal);

	// The steer reached the agent verbatim…
	expect(inner.prompts.at(-1)).toBe("you never committed — run git add -A && git commit");
	// …and NO second workflow run was started. (Before the fix this was 2.)
	await Bun.sleep(150); // give a stray execRun time to emit workflow_done
	expect(runsCompleted(frames)).toBe(1);
});

test("the first prompt is still the goal: it starts exactly one run and is what the graph runs on", async () => {
	const inner = new RecordingInner();
	const { driver, frames } = makeDriver("s2", inner);
	await driver.start();

	await driver.prompt("ship the feature");
	await waitFor(() => runsCompleted(frames) === 1);

	expect(runsCompleted(frames)).toBe(1);
	expect(inner.prompts.length).toBeGreaterThan(0);
	expect(inner.prompts[0]).toContain("ship the feature"); // the Implement node ran on the goal
});

test("a prompt DURING a live run also steers the agent, never restarting the graph", async () => {
	const inner = new RecordingInner();
	const { driver, frames } = makeDriver("s3", inner);
	await driver.start();

	void driver.prompt("ship the feature");
	await waitFor(() => inner.prompts.length >= 1); // the Implement node is in flight
	await driver.prompt("actually, use the ember token");

	await waitFor(() => runsCompleted(frames) >= 1);
	expect(inner.prompts).toContain("actually, use the ember token");
	await Bun.sleep(150);
	expect(runsCompleted(frames)).toBe(1);
});

// ── never black-hole a steer ─────────────────────────────────────────────────────────────────────

/** The operator typed it and is watching for an effect. The old code was `.catch(() => {})`. */
test("a steer that the agent rejects is surfaced to the operator, not swallowed", async () => {
	const inner = new RecordingInner();
	const { driver, frames } = makeDriver("s4", inner);
	await driver.start();

	await driver.prompt("ship the feature");
	await waitFor(() => runsCompleted(frames) === 1);

	inner.failNext = true;
	await driver.prompt("steer into a dead host");

	const deltas = frames
		.filter((f) => f.type === "message_update")
		.map((f) => f.assistantMessageEvent?.delta ?? "")
		.join("");
	expect(deltas).toContain("steer not delivered");
	expect(deltas).toContain("agent host is gone");
});

// ── the unit must not look IDLE while it is being steered ───────────────────────────────────────

/**
 * The regression that making post-run steering REAL introduced, caught by cross-lineage review
 * (grok-4.5): `getState().isStreaming` was `runActive`, which is false once the graph exits. So a unit
 * mid-steer reported IDLE — and `commitAgentWip`/verify/land fire on idle agents, meaning the
 * orchestrator could sweep-commit and land a tree the agent was actively writing into.
 */
test("a unit being steered after its run reports STREAMING, not idle", async () => {
	const inner = new SlowInner();
	const { driver, frames } = makeDriver("s6", inner);
	await driver.start();

	await driver.prompt("ship the feature");
	await waitFor(() => runsCompleted(frames) === 1);
	expect((await driver.getState()).isStreaming).toBe(false); // run over, nothing in flight

	const steer = driver.prompt("now also write steered.txt");
	await waitFor(() => inner.turnStarted);
	expect((await driver.getState()).isStreaming).toBe(true); // ← was false before the fix

	inner.finishTurn();
	await steer;
	await waitFor(() => !inner.turnActive);
	expect((await driver.getState()).isStreaming).toBe(false); // back to idle once the turn ends
});

/** The roster must SEE the steer turn: outside a run the inner agent's lifecycle frames are the only
 *  thing that can move the unit out of idle. During a run they stay swallowed (the graph owns it). */
test("outside a run the inner agent's turn lifecycle is forwarded; during a run it is not", async () => {
	const inner = new SlowInner();
	const { driver, frames } = makeDriver("s7", inner);
	await driver.start();

	await driver.prompt("ship the feature");
	await waitFor(() => runsCompleted(frames) === 1);
	// Exactly one agent_start/agent_end pair for the whole RUN — per-node turns were swallowed.
	const runStarts = frames.filter((f) => f.type === "agent_start").length;
	expect(runStarts).toBe(1);

	const steer = driver.prompt("steer me");
	await waitFor(() => inner.turnStarted);
	expect(frames.filter((f) => f.type === "agent_start").length).toBe(2); // the steer turn is visible
	inner.finishTurn();
	await steer;
	await waitFor(() => frames.filter((f) => f.type === "agent_end").length === 2);
});

// ── busy-ness must be exactly right in BOTH directions ─────────────────────────────────────────

/**
 * A rejected `inner.prompt()` after the agent already began its turn must NOT report idle: the send
 * failed, the agent did not. Clearing busy here exposed a live tree to `commitAgentWip`.
 * (gpt-5.6-sol.)
 */
test("a steer whose send is rejected AFTER the turn began still reports streaming", async () => {
	const inner = new SlowInner();
	const { driver, frames } = makeDriver("s8", inner);
	await driver.start();
	await driver.prompt("ship the feature");
	await waitFor(() => runsCompleted(frames) === 1);

	inner.startTurnThenThrow = true;
	await driver.prompt("steer whose ack is lost"); // emits agent_start, then throws
	expect((await driver.getState()).isStreaming).toBe(true); // the turn is live

	inner.finishTurn();
	await waitFor(async () => !(await driver.getState()).isStreaming);
	expect((await driver.getState()).isStreaming).toBe(false);
});

/**
 * The mirror-image leak: a turn whose `agent_end` never arrives (host crash, lost frame) must not
 * strand the unit "working" forever — never idle means never swept, verified, or landed. A dead inner
 * ends the turn. (gpt-5.6-sol.)
 */
test("a steer turn whose agent_end never arrives does not strand the unit working — a dead inner ends it", async () => {
	const inner = new SlowInner();
	const { driver, frames } = makeDriver("s9", inner);
	await driver.start();
	await driver.prompt("ship the feature");
	await waitFor(() => runsCompleted(frames) === 1);

	const steer = driver.prompt("steer into a crash");
	await waitFor(() => inner.turnStarted);
	await steer;
	expect((await driver.getState()).isStreaming).toBe(true);

	inner.alive = false; // host died; no agent_end will ever come
	inner.emit("exit", { code: 1 });
	expect((await driver.getState()).isStreaming).toBe(false); // reclaimed, not stranded
});

/** With no inner agent to steer, starting a run is the only thing that can act on the message —
 *  the pre-fix behaviour, preserved deliberately for exactly this case. */
test("with no live inner agent, a later prompt falls back to starting a run", async () => {
	const inner = new RecordingInner();
	const { driver, frames } = makeDriver("s5", inner);
	await driver.start();

	await driver.prompt("ship the feature");
	await waitFor(() => runsCompleted(frames) === 1);

	inner.alive = false; // the agent host died
	await driver.prompt("try again");
	await waitFor(() => runsCompleted(frames) === 2);
	expect(runsCompleted(frames)).toBe(2);
});
