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
