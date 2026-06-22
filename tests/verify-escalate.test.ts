/**
 * Self-healing escalation tier for the verify → fixup loop:
 *   - structure: buildVerifyWorkflow / buildTddVerifyWorkflow gain a grounded `escalate`
 *     agent node, fixup overflows to it, and escalate loops back to the gate.
 *   - engine: a goal-gate that fails with IDENTICAL output on consecutive visits short-circuits
 *     the fixup budget straight into escalate (no-progress); failing with DIFFERENT output each
 *     pass spends the full fixup budget before escalate.
 * Deterministic: no model tokens, no shell — agents are stubbed to succeed, the gate is scripted.
 */

import { expect, test } from "bun:test";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import type { NodeExecutor, NodeResult, RunContext, WorkflowNode } from "../src/workflow/types.ts";
import { buildTddVerifyWorkflow, buildVerifyWorkflow } from "../src/workflow/verify-workflow.ts";

/** Agents always succeed; the verify command always fails, returning a scripted output per visit. */
class ScriptedExecutor implements NodeExecutor {
	readonly order: string[] = [];
	private commandCalls = 0;
	constructor(private readonly output: (call: number) => string) {}
	async runAgent(node: WorkflowNode, _ctx: RunContext): Promise<NodeResult> {
		this.order.push(node.id);
		return { outcome: "succeeded", text: `${node.id} ok` };
	}
	async runCommand(node: WorkflowNode, _ctx: RunContext): Promise<NodeResult> {
		this.order.push(node.id);
		return { outcome: "failed", text: this.output(this.commandCalls++) };
	}
	async humanGate(_node: WorkflowNode, options: string[], _ctx: RunContext): Promise<string> {
		return options[0]!;
	}
}

// ── structure: both builders carry the grounded escalate tier ───────────────────

for (const [name, build] of [
	["buildVerifyWorkflow", buildVerifyWorkflow],
	["buildTddVerifyWorkflow", buildTddVerifyWorkflow],
] as const) {
	test(`${name} wires fixup → escalate → verify with a grounded escalate node`, () => {
		const wf = build({ command: "tsc --noEmit" });
		const escalate = wf.nodes.get("escalate");
		expect(escalate).toBeDefined();
		expect(escalate!.kind).toBe("agent");
		expect(escalate!.maxVisits).toBe(2);
		expect(escalate!.prompt).toContain("node_modules"); // forces reading installed types, no guessing
		expect(wf.nodes.get("fixup")!.overflow).toBe("escalate"); // exhausted fixup overflows to escalate
		expect(wf.edges).toContainEqual({ from: "escalate", to: "verify" }); // escalate loops back to the gate
	});
}

// ── engine: no-progress short-circuits, real progress spends the budget ─────────

test("a goal-gate failing with identical output short-circuits the fixup budget into escalate", async () => {
	const wf = buildVerifyWorkflow({ command: "x", maxFixups: 3 });
	const exec = new ScriptedExecutor(() => "SAME ERROR"); // every verify reproduces the identical error
	const res = await new WorkflowEngine(wf, exec).run("g");
	expect(res.outcome).toBe("failed");
	expect(exec.order).toContain("escalate");
	// No progress: the 2nd identical verify jumps to escalate instead of burning all 3 fixups.
	expect(exec.order.filter((x) => x === "fixup").length).toBe(1);
	expect(exec.order.filter((x) => x === "escalate").length).toBe(1);
});

test("a goal-gate failing with different output each pass spends the full fixup budget before escalate", async () => {
	const wf = buildVerifyWorkflow({ command: "x", maxFixups: 3 });
	const exec = new ScriptedExecutor((call) => `ERROR ${call}`); // a new error every verify → progress signal
	const res = await new WorkflowEngine(wf, exec).run("g");
	expect(res.outcome).toBe("failed");
	expect(exec.order.filter((x) => x === "fixup").length).toBe(3); // full fixup budget spent first
	expect(exec.order.filter((x) => x === "escalate").length).toBe(2); // then escalate's own budget
	expect(exec.order.lastIndexOf("fixup")).toBeLessThan(exec.order.indexOf("escalate")); // fixups exhaust before escalate
});
