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

/** Agents always succeed; the codefix pre-pass is a no-op success; the verify command always fails with a scripted output per visit. */
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
		if (node.id === "codefix") return { outcome: "succeeded", text: "codefix noop" }; // deterministic pre-pass: nothing to fix here
		return { outcome: "failed", text: this.output(this.commandCalls++) };
	}
	async humanGate(_node: WorkflowNode, options: string[], _ctx: RunContext): Promise<string> {
		return options[0]!;
	}
}

// ── structure: both builders carry the codefix → fixup → escalate cascade ────────

for (const [name, build] of [
	["buildVerifyWorkflow", buildVerifyWorkflow],
	["buildTddVerifyWorkflow", buildTddVerifyWorkflow],
] as const) {
	test(`${name} wires verify → codefix → fixup → escalate → verify with a grounded escalate node`, () => {
		const wf = build({ command: "tsc --noEmit" });
		const escalate = wf.nodes.get("escalate");
		expect(escalate).toBeDefined();
		expect(escalate!.kind).toBe("agent");
		expect(escalate!.maxVisits).toBe(2);
		expect(escalate!.prompt).toContain("node_modules"); // forces reading installed types, no guessing
		expect(wf.nodes.get("fixup")!.overflow).toBe("escalate"); // exhausted fixup overflows to escalate
		expect(wf.nodes.get("verify")!.retryTarget).toBe("codefix"); // a failed gate hits the deterministic pre-pass first
		expect(wf.nodes.get("codefix")!.kind).toBe("command");
		expect(wf.nodes.get("codefix")!.maxVisits).toBe(1); // runs once, then overflows to fixup
		expect(wf.nodes.get("codefix")!.overflow).toBe("fixup"); // codefix → fixup is the first cascade hop
		expect(wf.edges).toContainEqual({ from: "codefix", to: "verify" }); // codefix loops back to the gate
		expect(wf.edges).toContainEqual({ from: "escalate", to: "verify" }); // escalate loops back to the gate
	});
}

// ── engine: no-progress short-circuits, real progress spends the budget ─────────

test("a goal-gate failing with identical output cascades codefix → fixup → escalate, skipping the wasted budget", async () => {
	const wf = buildVerifyWorkflow({ command: "x", maxFixups: 3 });
	const exec = new ScriptedExecutor(() => "SAME ERROR"); // every verify reproduces the identical error
	const res = await new WorkflowEngine(wf, exec).run("g");
	expect(res.outcome).toBe("failed");
	expect(exec.order).toContain("escalate");
	// No progress: the deterministic codefix pre-pass runs once, then each identical verify walks the
	// overflow chain one tier further (codefix → fixup → escalate) instead of burning the whole budget.
	expect(exec.order.filter((x) => x === "codefix").length).toBe(1);
	expect(exec.order.filter((x) => x === "fixup").length).toBe(1);
	expect(exec.order.filter((x) => x === "escalate").length).toBe(1);
	expect(exec.order.indexOf("codefix")).toBeLessThan(exec.order.indexOf("fixup")); // codefix is tried before fixup
	expect(exec.order.indexOf("fixup")).toBeLessThan(exec.order.indexOf("escalate")); // fixup before escalate
});

test("a goal-gate failing with different output each pass spends the full fixup budget before escalate", async () => {
	const wf = buildVerifyWorkflow({ command: "x", maxFixups: 3 });
	const exec = new ScriptedExecutor((call) => `ERROR ${call}`); // a new error every verify → progress signal, codefix is a no-op
	const res = await new WorkflowEngine(wf, exec).run("g");
	expect(res.outcome).toBe("failed");
	expect(exec.order.filter((x) => x === "fixup").length).toBe(3); // full fixup budget spent first
	expect(exec.order.filter((x) => x === "escalate").length).toBe(2); // then escalate's own budget
	expect(exec.order.lastIndexOf("fixup")).toBeLessThan(exec.order.indexOf("escalate")); // fixups exhaust before escalate
});

// ── identity safety (noisegate-compaction concern 03, red-team RT2-1) ──────────────────────────────
//
// A REAL oversized failing output reaches `ctx.vars.lastOutput` via runCommand's `reduceOutput`
// (output-reduce.ts, concern 01), which appends a `[N bytes omitted — full: <path>]` offload pointer
// carrying a FRESH ts+nonce on EVERY reduction — even when the underlying failure text is
// byte-identical across visits. `noProgressRoute`'s old trim-only comparator would see two DIFFERENT
// strings on every visit and this short-circuit would never fire, silently burning the whole fixup
// budget on a loop that was never making progress. `identityNormalize` (wired into the comparator in
// engine.ts) strips that pointer line (plus ANSI/timing jitter) so the comparison sees past it.

test("a goal-gate failing with the SAME oversized (reduced) output — offload pointer nonce differs every visit — still short-circuits via no-progress", async () => {
	const wf = buildVerifyWorkflow({ command: "x", maxFixups: 3 });
	// Same core failure text every visit; only the offload pointer's ts+nonce differs — exactly what two
	// real `reduceOutput` calls on identical input would produce (writeGateLog mints a unique path per write).
	const body = "SAME FAILURE TAIL: assertion failed at line 42\n".repeat(80);
	let call = 0;
	const exec = new ScriptedExecutor(() => {
		call++;
		return `${body}\n[9999 bytes omitted — full: /tmp/state/gate-logs/a1/170000000${call}-nonce${call}abcd-executor-steer.log]`;
	});
	const res = await new WorkflowEngine(wf, exec).run("g");
	expect(res.outcome).toBe("failed");
	expect(exec.order).toContain("escalate");
	// Exactly the no-progress shape from the plain-string test above: one codefix, one fixup, one
	// escalate — the nonce-only difference between visits must NOT read as "the failure changed".
	expect(exec.order.filter((x) => x === "codefix").length).toBe(1);
	expect(exec.order.filter((x) => x === "fixup").length).toBe(1);
	expect(exec.order.filter((x) => x === "escalate").length).toBe(1);
});

test("a goal-gate failing with GENUINELY different oversized (reduced) output each visit still spends the full fixup budget — identityNormalize never masks real progress", async () => {
	const wf = buildVerifyWorkflow({ command: "x", maxFixups: 3 });
	// Different core failure text every visit, each with its own (also pointer-shaped) offload line.
	const exec = new ScriptedExecutor((call) => `DISTINCT FAILURE ${call}: assertion failed at a different line\n[9999 bytes omitted — full: /tmp/state/gate-logs/a1/17000000000${call}-nonce${call}-executor-steer.log]`);
	const res = await new WorkflowEngine(wf, exec).run("g");
	expect(res.outcome).toBe("failed");
	expect(exec.order.filter((x) => x === "fixup").length).toBe(3); // full fixup budget still spent — real progress, not a nonce artifact
	expect(exec.order.filter((x) => x === "escalate").length).toBe(2);
});
