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
 *                          └────(fail)→ codefix → fixup → escalate → verify
 * Cascade on failure: a deterministic codefix pre-pass (once), then bounded AI fixups, then a
 * grounded escalate tier — each tier overflowing to the next as its budget exhausts.
 */

import type { VerifySpec } from "../types.ts";
import type { Workflow, WorkflowNode } from "./types.ts";

const IMPLEMENT_PROMPT = "Complete the goal above. Implement it fully, then stop.";
const FIXUP_PROMPT = "The verify command failed. Read the recent command output and fix every failure it reports. Change only what the failures require, then stop.";
const WRITE_TEST_PROMPT =
	"Author the acceptance test(s) for the goal above FIRST. Cover the behaviour the goal specifies, then RUN them and confirm they FAIL (red) — proving they exercise code that does not exist yet. Do not implement the feature. Stop once the tests are written and confirmed failing.";
const ESCALATE_PROMPT =
	'The verify gate still fails after repeated fixups. Do NOT guess any library or framework API. For each error, READ the installed package under node_modules — its package.json "exports" map and its .d.ts type declarations — to find the correct import path and exact signature, then fix the usage to match the installed types. Confirm against the installed types before editing, then stop.';

export function buildVerifyWorkflow(spec: VerifySpec): Workflow {
	const nodes = new Map<string, WorkflowNode>([
		["start", { id: "start", kind: "start", label: "Start", attrs: {} }],
		["implement", { id: "implement", kind: "agent", label: "Implement", prompt: IMPLEMENT_PROMPT, attrs: {} }],
		["verify", { id: "verify", kind: "command", label: "Verify", script: spec.command, goalGate: true, retryTarget: "codefix", attrs: {} }],
		["codefix", { id: "codefix", kind: "command", label: "Codefix", script: "bun src/workflow/codefix.ts .", maxVisits: 1, overflow: "fixup", attrs: {} }],
		["fixup", { id: "fixup", kind: "agent", label: "Fixup", prompt: FIXUP_PROMPT, maxVisits: spec.maxFixups ?? 3, overflow: "escalate", attrs: {} }],
		["escalate", { id: "escalate", kind: "agent", label: "Escalate", prompt: ESCALATE_PROMPT, maxVisits: 2, attrs: {} }],
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
			{ from: "codefix", to: "verify" },
			{ from: "fixup", to: "verify" },
			{ from: "escalate", to: "verify" },
		],
		start: "start",
		exit: "exit",
	};
}

/**
 * buildTddVerifyWorkflow — the TDD-first variant: write the acceptance test(s)
 * (red) BEFORE implementing, then verify against the same gate. Identical to
 * buildVerifyWorkflow except for a `write-test` agent node prepended ahead of
 * `implement`, so a passing run proves the test was authored first.
 *
 *   start → write-test → implement → verify ─(pass)→ exit
 *                                       └────(fail)→ codefix → fixup → escalate → verify
 */
export function buildTddVerifyWorkflow(spec: VerifySpec): Workflow {
	const nodes = new Map<string, WorkflowNode>([
		["start", { id: "start", kind: "start", label: "Start", attrs: {} }],
		["write-test", { id: "write-test", kind: "agent", label: "Write test", prompt: WRITE_TEST_PROMPT, attrs: {} }],
		["implement", { id: "implement", kind: "agent", label: "Implement", prompt: IMPLEMENT_PROMPT, attrs: {} }],
		["verify", { id: "verify", kind: "command", label: "Verify", script: spec.command, goalGate: true, retryTarget: "codefix", attrs: {} }],
		["codefix", { id: "codefix", kind: "command", label: "Codefix", script: "bun src/workflow/codefix.ts .", maxVisits: 1, overflow: "fixup", attrs: {} }],
		["fixup", { id: "fixup", kind: "agent", label: "Fixup", prompt: FIXUP_PROMPT, maxVisits: spec.maxFixups ?? 3, overflow: "escalate", attrs: {} }],
		["escalate", { id: "escalate", kind: "agent", label: "Escalate", prompt: ESCALATE_PROMPT, maxVisits: 2, attrs: {} }],
		["exit", { id: "exit", kind: "exit", label: "Exit", attrs: {} }],
	]);
	return {
		name: "tdd-verify",
		nodes,
		edges: [
			{ from: "start", to: "write-test" },
			{ from: "write-test", to: "implement" },
			{ from: "implement", to: "verify" },
			{ from: "verify", to: "exit", label: "Pass", condition: "outcome=succeeded" },
			{ from: "verify", to: "fixup", label: "Fix" },
			{ from: "codefix", to: "verify" },
			{ from: "fixup", to: "verify" },
			{ from: "escalate", to: "verify" },
		],
		start: "start",
		exit: "exit",
	};
}
