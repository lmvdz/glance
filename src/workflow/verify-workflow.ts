/**
 * buildVerifyWorkflow — synthesize the implement → verify → fixup graph that
 * `omp-squad add --verify "<cmd>"` wraps around an ordinary task. This is the
 * cheapest, highest-leverage borrow from fabro: turn "the agent says it's done"
 * into "the agent is done AND the gate is green", reusing the same pure engine
 * as authored workflows rather than hand-rolling a second fix-up loop.
 *
 * The graph is built directly (no DOT round-trip) so an arbitrary shell command —
 * quotes, newlines, `&&`, whatever — needs no escaping.
 *
 *   start → implement → verify ─(pass)→ exit
 *                          └────(fail)→ fixup → verify   (bounded by maxFixups)
 */

import type { VerifySpec } from "../types.ts";
import type { Workflow, WorkflowNode } from "./types.ts";

const IMPLEMENT_PROMPT = "Complete the goal above. Implement it fully, then stop.";
const FIXUP_PROMPT = "The verify command failed. Read the recent command output and fix every failure it reports. Change only what the failures require, then stop.";

export function buildVerifyWorkflow(spec: VerifySpec): Workflow {
	const nodes = new Map<string, WorkflowNode>([
		["start", { id: "start", kind: "start", label: "Start", attrs: {} }],
		["implement", { id: "implement", kind: "agent", label: "Implement", prompt: IMPLEMENT_PROMPT, attrs: {} }],
		["verify", { id: "verify", kind: "command", label: "Verify", script: spec.command, goalGate: true, retryTarget: "fixup", attrs: {} }],
		["fixup", { id: "fixup", kind: "agent", label: "Fixup", prompt: FIXUP_PROMPT, maxVisits: spec.maxFixups ?? 3, attrs: {} }],
		["exit", { id: "exit", kind: "exit", label: "Exit", attrs: {} }],
	]);
	return {
		name: "verify",
		nodes,
		edges: [
			{ from: "start", to: "implement" },
			{ from: "implement", to: "verify" },
			{ from: "verify", to: "exit", label: "Pass", condition: "outcome=succeeded" },
			{ from: "verify", to: "fixup", label: "Fix" },
			{ from: "fixup", to: "verify" },
		],
		start: "start",
		exit: "exit",
	};
}
