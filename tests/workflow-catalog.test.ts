import { expect, test } from "bun:test";
import { WORKFLOW_DEFINITIONS, workflowSnapshot } from "../src/workflow-catalog.ts";
import type { AgentDTO } from "../src/types.ts";

const agent = (over: Partial<AgentDTO>): AgentDTO => ({
	id: "a1",
	name: "wf",
	status: "working",
	kind: "workflow",
	repo: "/r",
	worktree: "/w",
	approvalMode: "write",
	pending: [],
	lastActivity: 1,
	messageCount: 0,
	...over,
});

test("workflow catalog includes the autonomy meta-workflow and guardrails", () => {
	const meta = WORKFLOW_DEFINITIONS.find((w) => w.id === "autonomy-meta-loop");
	expect(meta?.kind).toBe("meta-workflow");
	expect(meta?.steps.map((s) => s.id)).toEqual(["curate", "triage", "dispatch", "execute", "land", "observe"]);
	expect(meta?.disallowed).toContain("bypass blocked_by");
});

test("workflowSnapshot returns live workflow runs with progress", () => {
	const snap = workflowSnapshot([
		agent({ workflow: { path: "research-plan-implement" }, workflowState: { goal: "ship", currentNode: "implement", context: { goal: "ship", artifacts: {}, attempts: {} }, rollup: [{ label: "Research", status: "completed" }, { label: "Implement", status: "in_progress" }] } }),
		agent({ id: "plain", kind: "omp-operator" }),
	]);

	expect(snap.definitions.length).toBeGreaterThan(0);
	expect(snap.runs).toHaveLength(1);
	expect(snap.runs[0].stage).toBe("Implement");
	expect(snap.runs[0].progress).toEqual({ done: 1, total: 2 });
});
