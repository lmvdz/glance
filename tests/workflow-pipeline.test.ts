/**
 * The bundled research → plan → plan-to-plane → implement pipeline graph:
 * it resolves by name, parses into the expected phases, and the pure engine walks
 * it to completion (including the Revise loop and the verify → fixup loop) with a
 * recording mock executor — no omp process, no model tokens.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { parseWorkflow } from "../src/workflow/dot.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import type { NodeExecutor, NodeResult, RunContext, WorkflowNode } from "../src/workflow/types.ts";
import { resolveWorkflowPath } from "../src/squad-manager.ts";

const PIPELINE = "research-plan-implement";

function loadPipeline() {
	const p = resolveWorkflowPath(PIPELINE);
	return { p, wf: parseWorkflow(readFileSync(p, "utf8")) };
}

/** Records the order nodes execute; command outcomes + gate answers are scripted. */
class MockExecutor implements NodeExecutor {
	readonly order: string[] = [];
	constructor(
		private readonly gateAnswers: string[],
		private readonly commandOutcomes: ("succeeded" | "failed")[] = [],
	) {}
	async runAgent(node: WorkflowNode, _ctx: RunContext): Promise<NodeResult> {
		this.order.push(node.id);
		return { outcome: "succeeded", text: node.id };
	}
	async runCommand(node: WorkflowNode, _ctx: RunContext): Promise<NodeResult> {
		this.order.push(node.id);
		return { outcome: this.commandOutcomes.shift() ?? "succeeded", text: "out" };
	}
	async humanGate(node: WorkflowNode, options: string[], _ctx: RunContext): Promise<string> {
		this.order.push(node.id);
		return this.gateAnswers.shift() ?? options[0]!;
	}
}

// ── name resolution ──────────────────────────────────────────────────────────

test("resolveWorkflowPath maps the bare name to the bundled graph", () => {
	const p = resolveWorkflowPath(PIPELINE);
	expect(p.endsWith(`workflows/${PIPELINE}/workflow.fabro`)).toBe(true);
	expect(existsSync(p)).toBe(true);
});

test("resolveWorkflowPath leaves an explicit existing path untouched and passes unknowns through", () => {
	const real = resolveWorkflowPath(PIPELINE);
	expect(resolveWorkflowPath(real)).toBe(real); // existing path → as-is
	expect(resolveWorkflowPath("definitely-not-a-workflow-xyz")).toBe("definitely-not-a-workflow-xyz");
});

// ── graph shape ──────────────────────────────────────────────────────────────

test("pipeline graph parses into the expected phases, kinds, and gates", () => {
	const { wf } = loadPipeline();
	for (const id of ["start", "research", "plan", "approve", "to_plane", "implement", "verify", "fixup", "exit"]) {
		expect(wf.nodes.has(id)).toBe(true);
	}
	expect(wf.nodes.get("research")?.kind).toBe("agent");
	expect(wf.nodes.get("approve")?.kind).toBe("human");
	expect(wf.nodes.get("verify")?.kind).toBe("command");
	expect(wf.nodes.get("verify")?.goalGate).toBe(true);
	expect(wf.nodes.get("verify")?.retryTarget).toBe("fixup");
	expect(wf.nodes.get("fixup")?.maxVisits).toBe(3);
	// long phases carry an explicit per-node turn timeout the executor honors
	expect(wf.nodes.get("implement")?.attrs.timeout_ms).toBe("7200000");
	// the approve gate offers Approve / Revise
	const gateLabels = wf.edges.filter((e) => e.from === "approve").map((e) => e.label);
	expect(gateLabels).toContain("Approve");
	expect(gateLabels).toContain("Revise");
});

// ── engine walk ──────────────────────────────────────────────────────────────

test("happy path: approve once, verify passes → runs every phase in order to exit", async () => {
	const { wf } = loadPipeline();
	const mock = new MockExecutor(["Approve"], ["succeeded"]);
	const res = await new WorkflowEngine(wf, mock).run("ship feature X");
	expect(res.outcome).toBe("succeeded");
	// research → plan → approve → to_plane → implement → verify, in order
	const seq = mock.order.filter((id) => id !== "fixup");
	expect(seq).toEqual(["research", "plan", "approve", "to_plane", "implement", "verify"]);
});

test("Revise loop: a rejected plan loops back to plan, then proceeds on approval", async () => {
	const { wf } = loadPipeline();
	const mock = new MockExecutor(["Revise", "Approve"], ["succeeded"]);
	const res = await new WorkflowEngine(wf, mock).run("ship feature X");
	expect(res.outcome).toBe("succeeded");
	expect(mock.order.filter((id) => id === "plan").length).toBe(2); // planned twice
	expect(mock.order.filter((id) => id === "approve").length).toBe(2);
});

test("verify → fixup loop: a failing verify routes to fixup, then passes", async () => {
	const { wf } = loadPipeline();
	const mock = new MockExecutor(["Approve"], ["failed", "succeeded"]);
	const res = await new WorkflowEngine(wf, mock).run("ship feature X");
	expect(res.outcome).toBe("succeeded");
	expect(mock.order).toContain("fixup");
	expect(mock.order.filter((id) => id === "verify").length).toBe(2); // verified twice (fail then pass)
});
