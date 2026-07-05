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

import * as path from "node:path";
import type { VerifySpec } from "../types.ts";
import type { Workflow, WorkflowNode } from "./types.ts";

/**
 * Absolute path to codefix.ts — resolved against THIS file's own directory so
 * the script is found in omp-squad's install dir, NOT in the target repo's cwd
 * (where `src/workflow/codefix.ts` does not exist). Shell-quoted to handle
 * spaces in the install path.
 */
const CODEFIX_SCRIPT = `"${path.join(import.meta.dir, "codefix.ts").replace(/"/g, '\\"')}"`;
const CODEFIX_CMD = `bun ${CODEFIX_SCRIPT} .`;

const IMPLEMENT_PROMPT = "Complete the goal above. Implement it fully, then stop.";
const FIXUP_PROMPT = "The verify command failed. Read the recent command output and fix every failure it reports. Change only what the failures require, then stop.";
const WRITE_TEST_PROMPT =
	"Author the acceptance test(s) for the goal above FIRST. Cover the behaviour the goal specifies, then RUN them and confirm they FAIL (red) — proving they exercise code that does not exist yet. Do not implement the feature. Stop once the tests are written and confirmed failing.";
const OBSERVE_REPORT_PROMPT =
	"The reproduce command FAILED — the regression is real. Do NOT fix it. Narrow it to the smallest failing case, identify the likely cause (recent commit / file / symbol), and write a concise findings report. Stop when the report is written.";
const ESCALATE_PROMPT =
	'The verify gate still fails after repeated fixups. Do NOT guess any library or framework API. For each error, READ the installed package under node_modules — its package.json "exports" map and its .d.ts type declarations — to find the correct import path and exact signature, then fix the usage to match the installed types. Confirm against the installed types before editing, then stop.';

export function buildVerifyWorkflow(spec: VerifySpec): Workflow {
	const nodes = new Map<string, WorkflowNode>([
		["start", { id: "start", kind: "start", label: "Start", attrs: {} }],
		["implement", { id: "implement", kind: "agent", label: "Implement", prompt: IMPLEMENT_PROMPT, attrs: {} }],
		["verify", { id: "verify", kind: "command", label: "Verify", script: spec.command, goalGate: true, retryTarget: "codefix", attrs: {} }],
		["codefix", { id: "codefix", kind: "command", label: "Codefix", script: CODEFIX_CMD, maxVisits: 1, overflow: "fixup", attrs: {} }],
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
 * The `write-test` node carries `isolatedLineage` — it runs on a SEPARATE
 * agent/context from `implement`, so the test author and the implementer are
 * distinct lineages that cannot co-reason. The implementer inherits only the
 * committed red test on disk, never the author's conversation — that separation
 * is what stops the coder from grading its own homework.
 *
 *   start → write-test → implement → verify ─(pass)→ exit
 *                                       └────(fail)→ codefix → fixup → escalate → verify
 */
export function buildTddVerifyWorkflow(spec: VerifySpec): Workflow {
	const nodes = new Map<string, WorkflowNode>([
		["start", { id: "start", kind: "start", label: "Start", attrs: {} }],
		// isolatedLineage: the test author runs on a SEPARATE agent/context from `implement`, so the coder
		// cannot grade its own homework — it inherits only the committed red test, not the author's thread.
		["write-test", { id: "write-test", kind: "agent", label: "Write test", prompt: WRITE_TEST_PROMPT, isolatedLineage: true, attrs: {} }],
		["implement", { id: "implement", kind: "agent", label: "Implement", prompt: IMPLEMENT_PROMPT, attrs: {} }],
		["verify", { id: "verify", kind: "command", label: "Verify", script: spec.command, goalGate: true, retryTarget: "codefix", attrs: {} }],
		["codefix", { id: "codefix", kind: "command", label: "Codefix", script: CODEFIX_CMD, maxVisits: 1, overflow: "fixup", attrs: {} }],
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

/**
 * buildObserveWorkflow — the observing agent's graph: reproduce a suspected
 * regression against the gate command, and if it reproduces, narrow it down
 * and write a findings report. Never fixes anything.
 *
 * Note the inverted semantics vs buildVerifyWorkflow: here the command
 * "failing" is the interesting outcome (the regression reproduced), so
 * `goalGate` is deliberately left unset — a green (non-reproducing) gate is a
 * valid, non-failing run, not something to retry into a fixup cascade.
 *
 *   start → reproduce ─(fails ⇒ reproduced)→ report → exit
 *                     └───(passes ⇒ not reproduced)──────→ exit
 */
export function buildObserveWorkflow(spec: VerifySpec): Workflow {
	const nodes = new Map<string, WorkflowNode>([
		["start", { id: "start", kind: "start", label: "Start", attrs: {} }],
		["reproduce", { id: "reproduce", kind: "command", label: "Reproduce", script: spec.command, attrs: {} }],
		["report", { id: "report", kind: "agent", label: "Report", prompt: OBSERVE_REPORT_PROMPT, maxVisits: 1, attrs: {} }],
		["exit", { id: "exit", kind: "exit", label: "Exit", attrs: {} }],
	]);
	return {
		name: "observe",
		nodes,
		edges: [
			{ from: "start", to: "reproduce" },
			{ from: "reproduce", to: "report", label: "Reproduced", condition: "outcome=failed" },
			{ from: "reproduce", to: "exit", label: "Not reproduced" },
			{ from: "report", to: "exit" },
		],
		start: "start",
		exit: "exit",
	};
}
