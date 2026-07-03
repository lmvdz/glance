/**
 * A workflow run survives a daemon restart: the engine resumes from a persisted checkpoint
 * (re-using resumeAgent for the in-flight node, never re-running completed ones), and resumeAgent
 * advances immediately when the inner turn already finished, or waits for it WITHOUT re-prompting
 * (re-prompting would duplicate work, e.g. re-file Plane issues).
 */

import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import type { AgentDriver } from "../src/agent-driver.ts";
import type { RpcSessionState } from "../src/types.ts";
import { parseWorkflow } from "../src/workflow/dot.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { SingleAgentExecutor } from "../src/workflow/executor.ts";
import type { EngineCheckpoint, NodeExecutor, NodeResult, RunContext, WorkflowNode, WorkflowRunState } from "../src/workflow/types.ts";

function sessionState(isStreaming: boolean): RpcSessionState {
	return { thinkingLevel: undefined, isStreaming, isCompacting: false, steeringMode: "all", followUpMode: "all", interruptMode: "immediate", sessionId: "fake", autoCompactionEnabled: false, messageCount: 0, queuedMessageCount: 0, todoPhases: [] };
}

/** Records which nodes ran fresh vs resumed. */
class RecordingExecutor implements NodeExecutor {
	readonly calls: string[] = [];
	runAgent(node: WorkflowNode): Promise<NodeResult> {
		this.calls.push(`run:${node.id}`);
		return Promise.resolve({ outcome: "succeeded", text: "" });
	}
	runCommand(node: WorkflowNode): Promise<NodeResult> {
		this.calls.push(`cmd:${node.id}`);
		return Promise.resolve({ outcome: "succeeded", text: "" });
	}
	humanGate(): Promise<string> {
		return Promise.resolve("");
	}
	resumeAgent(node: WorkflowNode): Promise<NodeResult> {
		this.calls.push(`resume:${node.id}`);
		return Promise.resolve({ outcome: "succeeded", text: "" });
	}
}

class ResumeFakeAgent extends EventEmitter implements AgentDriver {
	prompted = false;
	constructor(private readonly streaming: boolean) {
		super();
	}
	get isReady(): boolean {
		return true;
	}
	get isAlive(): boolean {
		return true;
	}
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async prompt(): Promise<void> {
		this.prompted = true;
	}
	abort(): Promise<unknown> {
		return Promise.resolve();
	}
	getState(): Promise<RpcSessionState> {
		return Promise.resolve(sessionState(this.streaming));
	}
	respondUi(): void {}
	respondHostTool(): void {}
	emitEnd(): void {
		this.emit("event", { type: "agent_end" });
	}
}

const flush = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

const WF = `digraph D {
	start [shape=Mdiamond]
	exit  [shape=Msquare]
	a [label="A"]
	b [label="B"]
	start -> a
	a -> b
	b -> exit
}`;

test("engine resume: continues from the checkpoint node, re-running neither earlier nodes nor a fresh prompt for the resumed one", async () => {
	const wf = parseWorkflow(WF);
	const exec = new RecordingExecutor();
	const engine = new WorkflowEngine(wf, exec);
	const checkpoints: EngineCheckpoint[] = [];
	// As if the daemon crashed while executing "b".
	const resume: WorkflowRunState = { goal: "g", currentNode: "b", visits: { start: 1, a: 1, b: 1 }, vars: {}, index: 3, rollup: [] };
	const result = await engine.run("g", { resume, checkpoint: (c) => checkpoints.push(c) });
	expect(result.outcome).toBe("succeeded");
	expect(exec.calls).toEqual(["resume:b"]); // a never re-runs; b resumes (not a fresh run)
	expect(checkpoints[0]?.currentNode).toBe("b"); // first checkpoint is the resumed node
});

test("engine fresh run still walks from start (no resume)", async () => {
	const exec = new RecordingExecutor();
	const result = await new WorkflowEngine(parseWorkflow(WF), exec).run("g");
	expect(result.outcome).toBe("succeeded");
	expect(exec.calls).toEqual(["run:a", "run:b"]);
});

test("resumeAgent: advances immediately when the inner turn already finished (idle), without re-prompting", async () => {
	const agent = new ResumeFakeAgent(false);
	const exec = new SingleAgentExecutor({ cwd: "/tmp", acquireAgent: () => Promise.resolve(agent), emit: () => {}, gate: () => Promise.resolve("") });
	const r = await exec.resumeAgent({ id: "implement", kind: "agent", attrs: {} }, { goal: "g", vars: {} });
	expect(r.outcome).toBe("succeeded");
	expect(agent.prompted).toBe(false);
});

test("resumeAgent: waits for an in-flight turn to end without re-prompting", async () => {
	const agent = new ResumeFakeAgent(true);
	const exec = new SingleAgentExecutor({
		cwd: "/tmp",
		acquireAgent: () => Promise.resolve(agent),
		emit: () => {},
		gate: () => Promise.resolve(""),
		scheduleIdleCheck: () => ({ cancel: () => {} }),
	});
	const pending = exec.resumeAgent({ id: "implement", kind: "agent", attrs: {} }, { goal: "g", vars: {} });
	await flush(); // let resumeAgent attach its listener
	agent.emitEnd(); // the in-flight turn ends
	const r = await pending;
	expect(r.outcome).toBe("succeeded");
	expect(agent.prompted).toBe(false);
});

// ── C01: sound cold resume (D2) ─────────────────────────────────────────────

test("resumeAgent COLD: a fresh thread RE-RUNS the in-flight node and re-primes the goal", async () => {
	const agent = new ResumeFakeAgent(false); // fresh thread: idle, never received the goal
	const exec = new SingleAgentExecutor({
		cwd: "/tmp",
		acquireAgent: () => Promise.resolve(agent),
		emit: () => {},
		gate: () => Promise.resolve(""),
		cold: true,
		scheduleIdleCheck: () => ({ cancel: () => {} }),
	});
	const pending = exec.resumeAgent({ id: "implement", kind: "agent", attrs: {} }, { goal: "g", vars: {} });
	await flush();
	agent.emitEnd(); // the re-sent turn completes
	const r = await pending;
	expect(r.outcome).toBe("succeeded");
	expect(agent.prompted).toBe(true); // cold re-executes (warm would leave this false)
});

test("two-phase checkpoint: a completed node advances currentNode and is never re-entered on resume", async () => {
	const wf = parseWorkflow(WF);
	const checkpoints: EngineCheckpoint[] = [];
	await new WorkflowEngine(wf, new RecordingExecutor()).run("g", { checkpoint: (c) => checkpoints.push(c) });
	// After node `a` finished, an exit checkpoint advanced currentNode to `b` (the second-phase checkpoint).
	const advanced = checkpoints.find((c) => c.currentNode === "b" && (c.resumeAttempts ?? 0) === 0);
	expect(advanced).toBeDefined();
	// Resuming from that post-`a` position must NOT re-enter `a`.
	const exec2 = new RecordingExecutor();
	const resume: WorkflowRunState = { ...advanced!, rollup: [] };
	await new WorkflowEngine(wf, exec2).run("g", { resume });
	expect(exec2.calls).not.toContain("run:a");
	expect(exec2.calls).not.toContain("resume:a");
});

test("poison cap: a cold resume AT the attempt cap escalates instead of re-running the node", async () => {
	const wf = parseWorkflow(WF);
	const exec = new RecordingExecutor();
	const escalated: string[] = [];
	const resume: WorkflowRunState = { goal: "g", currentNode: "b", visits: { start: 1, a: 1, b: 1 }, vars: {}, index: 3, rollup: [], cold: true, resumeAttempts: 3 };
	const result = await new WorkflowEngine(wf, exec).run("g", { resume, escalate: (r) => escalated.push(r) });
	expect(result.outcome).toBe("failed");
	expect(result.reason).toContain("poison cap");
	expect(escalated).toHaveLength(1);
	expect(exec.calls).toEqual([]); // the poison node was never executed again
});

test("poison cap: a cold resume BELOW the cap re-runs and records an incremented attempt, reset on progress", async () => {
	const wf = parseWorkflow(WF);
	const exec = new RecordingExecutor();
	const checkpoints: EngineCheckpoint[] = [];
	const resume: WorkflowRunState = { goal: "g", currentNode: "b", visits: { start: 1, a: 1, b: 1 }, vars: {}, index: 3, rollup: [], cold: true, resumeAttempts: 1 };
	await new WorkflowEngine(wf, exec).run("g", { resume, checkpoint: (c) => checkpoints.push(c) });
	expect(exec.calls).toEqual(["resume:b"]); // node still re-runs (below cap), `a` does not
	expect(checkpoints[0]?.currentNode).toBe("b");
	expect(checkpoints[0]?.resumeAttempts).toBe(2); // entry checkpoint = prior(1) + 1
	const exitCp = checkpoints.find((c) => c.currentNode === "exit");
	expect(exitCp?.resumeAttempts).toBe(0); // forward progress resets the poison counter
});
