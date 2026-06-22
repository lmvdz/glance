/**
 * Regression suite for two workflow-engine routing/aggregation bugs:
 *   D2 — a failed goal-gate with only a bare fallback never reached its retry_target.
 *   D3 — a parallel fan-out dropped each branch's text, and nothing wrote parallel_results.json.
 * Deterministic: no model tokens, no network. Each test fails if the fix regresses.
 */

import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import type { RpcSessionState } from "../src/types.ts";
import { SingleAgentExecutor } from "../src/workflow/executor.ts";
import { parseWorkflow } from "../src/workflow/dot.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import type { NodeExecutor, NodeResult, Outcome, RunContext, WorkflowNode } from "../src/workflow/types.ts";

/** Records execution order; command outcome is scripted, agents always succeed. */
class RecordingExecutor implements NodeExecutor {
	readonly order: string[] = [];
	constructor(private readonly commandOutcome: Outcome) {}
	async runAgent(node: WorkflowNode, _ctx: RunContext): Promise<NodeResult> {
		this.order.push(node.id);
		return { outcome: "succeeded", text: `${node.id} ok` };
	}
	async runCommand(node: WorkflowNode, _ctx: RunContext): Promise<NodeResult> {
		this.order.push(node.id);
		return { outcome: this.commandOutcome };
	}
	async humanGate(_node: WorkflowNode, options: string[], _ctx: RunContext): Promise<string> {
		return options[0]!;
	}
}

// ── D2: goal-gate retry precedence ─────────────────────────────────────────────

test("D2a: a failed goal-gate with only a bare fallback routes to its retry_target", async () => {
	const wf = parseWorkflow(`digraph G {
		start [shape=Mdiamond]
		exit  [shape=Msquare]
		gate  [shape=parallelogram, label="Gate", script="false", goal_gate=true, retry_target="retry"]
		retry [label="Retry"]
		done  [label="Done"]
		start -> gate
		gate  -> done
		retry -> exit
		done  -> exit
	}`);
	const exec = new RecordingExecutor("failed");
	const res = await new WorkflowEngine(wf, exec).run("g");
	expect(exec.order).toContain("retry"); // failed goal-gate retried
	expect(exec.order).not.toContain("done"); // bare fallback no longer pre-empts retry
	expect(res.outcome).toBe("succeeded");
});

test("D2b: a conditional outcome=failed edge still wins over the retry_target", async () => {
	const wf = parseWorkflow(`digraph G {
		start  [shape=Mdiamond]
		exit   [shape=Msquare]
		gate   [shape=parallelogram, label="Gate", script="false", goal_gate=true, retry_target="retry"]
		handle [label="Handle"]
		retry  [label="Retry"]
		done   [label="Done"]
		start  -> gate
		gate   -> handle [condition="outcome=failed"]
		gate   -> done
		handle -> exit
		retry  -> exit
		done   -> exit
	}`);
	const exec = new RecordingExecutor("failed");
	const res = await new WorkflowEngine(wf, exec).run("g");
	expect(exec.order).toContain("handle"); // conditional edge wins
	expect(exec.order).not.toContain("retry"); // retry_target did not pre-empt the condition
	expect(exec.order).not.toContain("done"); // bare fallback did not pre-empt the condition
	expect(res.outcome).toBe("succeeded");
});

// ── D3: fan-out branch results persisted to parallel_results.json ───────────────

/** Minimal AgentDriver: a prompt streams one line and ends the turn synchronously. */
class FakeInnerDriver extends EventEmitter implements AgentDriver {
	private ready = false;
	get isReady(): boolean {
		return this.ready;
	}
	get isAlive(): boolean {
		return this.ready;
	}
	async start(): Promise<void> {
		this.ready = true;
		this.emit("ready");
	}
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
	respondUi(): void {}
	respondHostTool(): void {}
}

test("D3: a fan-out writes parallel_results.json in cwd with each branch's outcome and text", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wfx-"));
	try {
		const wf = parseWorkflow(`digraph F {
			start  [shape=Mdiamond]
			exit   [shape=Msquare]
			fork   [shape=component, join_policy="wait_all"]
			a      [label="A", prompt="approach a"]
			b      [label="B", prompt="approach b"]
			merge  [shape=tripleoctagon]
			review [label="Review", prompt="Read parallel_results.json"]
			start  -> fork
			fork   -> a
			fork   -> b
			a      -> merge
			b      -> merge
			merge  -> review -> exit
		}`);
		const exec = new SingleAgentExecutor({
			cwd: dir,
			acquireAgent: async () => {
				const d = new FakeInnerDriver();
				await d.start();
				return d;
			},
			emit: () => {},
			gate: async () => "",
			spawnBranch: async (node, task) => ({ outcome: "succeeded", text: `${node.id} explored: ${task.slice(0, 16)}` }),
			scheduleIdleCheck: () => ({ cancel: () => {} }),
		});
		const res = await new WorkflowEngine(wf, exec).run("explore the change");
		expect(res.outcome).toBe("succeeded");

		const parsed = JSON.parse(await fs.readFile(path.join(dir, "parallel_results.json"), "utf8")) as { branch: string; outcome: string; text?: string }[];
		expect(parsed.map((r) => r.branch).sort()).toEqual(["a", "b"]);
		expect(parsed.every((r) => r.outcome === "succeeded")).toBe(true);
		expect(parsed.every((r) => typeof r.text === "string" && r.text.includes("explored"))).toBe(true);
	} finally {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
});
