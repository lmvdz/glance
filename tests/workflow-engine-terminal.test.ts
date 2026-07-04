/**
 * never-lose-work concern 01: engine terminal-escalation channel + branch identity/resume.
 *
 * Covers:
 *  - escalate(reason, checkpoint) firing exactly once at each of the engine's four terminal-failure
 *    returns (visit-cap-no-overflow, poison-cap, failed-no-recovery-route, ran-off-the-end);
 *  - runParallel's deterministic per-branch keys and three-state disposition model;
 *  - the entry-snapshot-clone invariant for per-branch (transient) checkpoint emissions;
 *  - resume-aware skip logic for wait_all and first_success fan-outs.
 *
 * Deterministic: no model tokens, no network, no real fleet.
 */

import { expect, test } from "bun:test";
import { parseWorkflow } from "../src/workflow/dot.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import type { EngineCheckpoint, NodeExecutor, NodeResult, Outcome, RunContext, Workflow, WorkflowNode, WorkflowRunState } from "../src/workflow/types.ts";

/** Scripted executor: runAgent/runBranch outcomes keyed by node id (default "succeeded"); records every call. */
class ScriptedExecutor implements NodeExecutor {
	readonly agentCalls: string[] = [];
	readonly branchCalls: { nodeId: string; branchKey?: string }[] = [];
	constructor(
		private readonly agentOutcomes: Record<string, Outcome> = {},
		private readonly branchOutcomes: Record<string, Outcome> = {},
	) {}
	async runAgent(node: WorkflowNode, _ctx: RunContext): Promise<NodeResult> {
		this.agentCalls.push(node.id);
		return { outcome: this.agentOutcomes[node.id] ?? "succeeded", text: `${node.id}-out` };
	}
	async runCommand(_node: WorkflowNode, _ctx: RunContext): Promise<NodeResult> {
		return { outcome: "succeeded" };
	}
	async humanGate(_node: WorkflowNode, options: string[], _ctx: RunContext): Promise<string> {
		return options[0] ?? "";
	}
	async runBranch(node: WorkflowNode, _ctx: RunContext, _signal?: AbortSignal, branchKey?: string): Promise<NodeResult> {
		this.branchCalls.push({ nodeId: node.id, branchKey });
		return { outcome: this.branchOutcomes[node.id] ?? "succeeded", text: `${node.id}-branch` };
	}
}

function baseResume(overrides: Partial<WorkflowRunState>): WorkflowRunState {
	return { goal: "g", currentNode: "start", visits: {}, vars: {}, index: 0, rollup: [], ...overrides };
}

const PARALLEL_WF = `digraph G {
	start [shape=Mdiamond]
	exit  [shape=Msquare]
	p [shape=component]
	b1 [label="B1"]
	b2 [label="B2"]
	m [shape=tripleoctagon]
	start -> p
	p -> b1
	p -> b2
	m -> exit
}`;

const FIRST_SUCCESS_WF = `digraph G {
	start [shape=Mdiamond]
	exit  [shape=Msquare]
	p [shape=component, join_policy="first_success"]
	b1 [label="B1"]
	b2 [label="B2"]
	m [shape=tripleoctagon]
	start -> p
	p -> b1
	p -> b2
	m -> exit
}`;

// ── (a) terminal-escalation sites ───────────────────────────────────────────────

test("terminal escalation: visit-cap-no-overflow fires escalate once with a matching checkpoint", async () => {
	const wf = parseWorkflow(`digraph G {
		start [shape=Mdiamond]
		exit  [shape=Msquare]
		a [label="A", max_visits=1]
		a -> a [condition="outcome=failed"]
		a -> exit [condition="outcome=succeeded"]
		start -> a
	}`);
	const executor = new ScriptedExecutor({ a: "failed" });
	const engine = new WorkflowEngine(wf, executor);
	const escalations: { reason: string; checkpoint: EngineCheckpoint }[] = [];
	const result = await engine.run("goal", { escalate: (reason, checkpoint) => void escalations.push({ reason, checkpoint }) });
	expect(result.outcome).toBe("failed");
	expect(escalations).toHaveLength(1);
	expect(escalations[0]!.checkpoint.currentNode).toBe("a");
	expect(escalations[0]!.reason).toContain("visit cap");
});

test("terminal escalation: poison-cap fires escalate once with resumeAttempts at the cap", async () => {
	const wf = parseWorkflow(`digraph G {
		start [shape=Mdiamond]
		exit  [shape=Msquare]
		a [label="A"]
		start -> a
		a -> exit
	}`);
	const executor = new ScriptedExecutor();
	const engine = new WorkflowEngine(wf, executor);
	const escalations: { reason: string; checkpoint: EngineCheckpoint }[] = [];
	const resume = baseResume({ currentNode: "a", cold: true, resumeAttempts: 3 });
	const result = await engine.run("goal", { resume, escalate: (reason, checkpoint) => void escalations.push({ reason, checkpoint }) });
	expect(result.outcome).toBe("failed");
	expect(result.reason).toContain("poison cap");
	expect(escalations).toHaveLength(1);
	expect(escalations[0]!.checkpoint.currentNode).toBe("a");
	expect(escalations[0]!.checkpoint.resumeAttempts).toBe(3);
	// The cap trips before the node is ever re-entered.
	expect(executor.agentCalls).toEqual([]);
});

test("terminal escalation: failed-no-recovery-route fires escalate once", async () => {
	const wf = parseWorkflow(`digraph G {
		start [shape=Mdiamond]
		exit  [shape=Msquare]
		b [label="B"]
		start -> b
	}`);
	const executor = new ScriptedExecutor({ b: "failed" });
	const engine = new WorkflowEngine(wf, executor);
	const escalations: { reason: string; checkpoint: EngineCheckpoint }[] = [];
	const result = await engine.run("goal", { escalate: (reason, checkpoint) => void escalations.push({ reason, checkpoint }) });
	expect(result.outcome).toBe("failed");
	expect(result.reason).toContain("no recovery route");
	expect(escalations).toHaveLength(1);
	expect(escalations[0]!.checkpoint.currentNode).toBe("b");
});

test("terminal escalation: ran-off-the-end fires escalate once (defensive fallback path)", async () => {
	const wf: Workflow = { name: "empty", nodes: new Map(), edges: [], start: "", exit: "" };
	const executor = new ScriptedExecutor();
	const engine = new WorkflowEngine(wf, executor);
	const escalations: { reason: string; checkpoint: EngineCheckpoint }[] = [];
	const result = await engine.run("goal", { escalate: (reason, checkpoint) => void escalations.push({ reason, checkpoint }) });
	expect(result.outcome).toBe("failed");
	expect(result.reason).toBe("ran off the end of the graph");
	expect(escalations).toHaveLength(1);
});

test("terminal escalation: the no-outgoing-edge SUCCESS case never escalates", async () => {
	const wf = parseWorkflow(`digraph G {
		start [shape=Mdiamond]
		exit  [shape=Msquare]
		c [label="C"]
		start -> c
	}`);
	const executor = new ScriptedExecutor({ c: "succeeded" });
	const engine = new WorkflowEngine(wf, executor);
	const escalations: unknown[] = [];
	const result = await engine.run("goal", { escalate: (reason, checkpoint) => void escalations.push({ reason, checkpoint }) });
	expect(result.outcome).toBe("succeeded");
	expect(escalations).toHaveLength(0);
});

// ── (b) resume-aware wait_all skip ───────────────────────────────────────────────

test("runParallel resume: a maxVisits:1 branch with a recorded disposition is never re-run", async () => {
	const wf = parseWorkflow(PARALLEL_WF);
	const executor = new ScriptedExecutor();
	const engine = new WorkflowEngine(wf, executor);
	const checkpoints: EngineCheckpoint[] = [];
	const resume = baseResume({
		currentNode: "p",
		visits: { p: 1, b1: 1 },
		branchOutcomes: { "p#1:0": { disposition: "succeeded", text: "b1-prior", at: 1 } },
	});
	const result = await engine.run("goal", { resume, checkpoint: (c) => checkpoints.push(c) });
	expect(result.outcome).toBe("succeeded");
	// b1 (index 0, the recorded branch) is never invoked; only b2 (not_attempted) runs.
	expect(executor.branchCalls.map((c) => c.nodeId)).toEqual(["b2"]);
	const mergeCheckpoint = checkpoints.find((c) => c.currentNode === "m");
	expect(mergeCheckpoint).toBeDefined();
	const parallelResults = JSON.parse(mergeCheckpoint!.vars.parallelResults!) as { branch: string; outcome: string }[];
	expect(parallelResults.find((r) => r.branch === "b1")?.outcome).toBe("succeeded");
	expect(parallelResults.find((r) => r.branch === "b2")?.outcome).toBe("succeeded");
});

// ── (c) resume-aware first_success short-circuit ─────────────────────────────────

test("runParallel resume: first_success with a recorded winner short-circuits with zero branch invocations", async () => {
	const wf = parseWorkflow(FIRST_SUCCESS_WF);
	const executor = new ScriptedExecutor();
	const engine = new WorkflowEngine(wf, executor);
	const resume = baseResume({
		currentNode: "p",
		visits: { p: 1 },
		branchOutcomes: { "p#1:0": { disposition: "succeeded", at: 1 } },
	});
	const result = await engine.run("goal", { resume });
	expect(result.outcome).toBe("succeeded");
	expect(executor.branchCalls).toEqual([]);
});

// ── (d) entry-snapshot-clone invariant ───────────────────────────────────────────

test("runParallel emits per-branch checkpoints as verbatim entry-snapshot clones, flagged transient", async () => {
	const wf = parseWorkflow(PARALLEL_WF);
	const executor = new ScriptedExecutor();
	const engine = new WorkflowEngine(wf, executor);
	const checkpoints: EngineCheckpoint[] = [];
	const result = await engine.run("goal", { checkpoint: (c) => checkpoints.push(c) });
	expect(result.outcome).toBe("succeeded");
	const branchDone = checkpoints.filter((c) => c.branchOutcomes !== undefined);
	expect(branchDone).toHaveLength(2);
	expect(branchDone.every((c) => c.transient === true)).toBe(true);
	const [first, second] = branchDone;
	expect(second!.resumeAttempts).toBe(first!.resumeAttempts);
	expect(second!.visits).toEqual(first!.visits);
	expect(second!.currentNode).toBe(first!.currentNode);
	expect(second!.vars).toEqual(first!.vars);
	// The map accumulates: the second (final) emission carries both branches' dispositions.
	expect(Object.keys(second!.branchOutcomes!)).toHaveLength(2);
});

// ── (e) poison-cap counter unaffected by interleaved transient emissions ────────────

test("poison cap: resumeAttempts progression is unaffected by interleaved branch-done checkpoints, trips at exactly 3", async () => {
	const wf = parseWorkflow(PARALLEL_WF);

	// Three cold-resume cycles under the cap: each must proceed (no escalation), and every checkpoint
	// belonging to the fan-out node "p" this cycle — its entry checkpoint AND both transient
	// branch-done emissions — must carry exactly this cycle's resumeAttempts, never a stray value.
	for (let prior = 0; prior < 3; prior++) {
		const executor = new ScriptedExecutor();
		const engine = new WorkflowEngine(wf, executor);
		const checkpoints: EngineCheckpoint[] = [];
		const escalations: unknown[] = [];
		const resume = baseResume({ currentNode: "p", cold: true, resumeAttempts: prior });
		const result = await engine.run("goal", {
			resume,
			checkpoint: (c) => checkpoints.push(c),
			escalate: (reason, checkpoint) => void escalations.push({ reason, checkpoint }),
		});
		expect(escalations).toHaveLength(0);
		expect(result.outcome).toBe("succeeded");
		const pCheckpoints = checkpoints.filter((c) => c.currentNode === "p");
		expect(pCheckpoints.length).toBeGreaterThan(0);
		for (const c of pCheckpoints) expect(c.resumeAttempts).toBe(prior + 1);
	}

	// The 4th cold resume (prior === cap) trips the poison cap exactly once, before ever dispatching
	// to runParallel.
	const executor = new ScriptedExecutor();
	const engine = new WorkflowEngine(wf, executor);
	const escalations: { reason: string; checkpoint: EngineCheckpoint }[] = [];
	const resume = baseResume({ currentNode: "p", cold: true, resumeAttempts: 3 });
	const result = await engine.run("goal", { resume, escalate: (reason, checkpoint) => void escalations.push({ reason, checkpoint }) });
	expect(result.outcome).toBe("failed");
	expect(escalations).toHaveLength(1);
	expect(escalations[0]!.checkpoint.resumeAttempts).toBe(3);
	expect(executor.branchCalls).toEqual([]);
});
