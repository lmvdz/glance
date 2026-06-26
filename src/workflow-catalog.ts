import type { AgentDTO } from "./types.ts";

export type WorkflowKind = "workflow" | "meta-workflow" | "automation";

export interface WorkflowStepDefinition {
	id: string;
	label: string;
	owner: string;
	allowed: string[];
	disallowed: string[];
	next: string[];
}

export interface WorkflowDefinition {
	id: string;
	kind: WorkflowKind;
	label: string;
	description: string;
	assigned: string[];
	allowed: string[];
	disallowed: string[];
	steps: WorkflowStepDefinition[];
}

export interface WorkflowRunView {
	agentId: string;
	name: string;
	status: AgentDTO["status"];
	workflow?: AgentDTO["workflow"];
	stage?: string;
	progress?: { done: number; total: number };
	rollup?: AgentDTO["workflowState"] extends infer S ? S extends { rollup?: infer R } ? R : never : never;
	issue?: AgentDTO["issue"];
	parentId?: string;
}

export interface WorkflowSnapshot {
	definitions: WorkflowDefinition[];
	runs: WorkflowRunView[];
}

export const WORKFLOW_DEFINITIONS: WorkflowDefinition[] = [
	{
		id: "autonomy-meta-loop",
		kind: "meta-workflow",
		label: "Autonomy order of operations",
		description: "Workflow-of-workflows: curator groups repeated issues, triage promotes one root fix, dispatcher starts eligible work, orchestrator verifies/lands, observer/scout feed new findings back.",
		assigned: ["plane-curator", "human triage", "Dispatcher", "Orchestrator", "Observer", "Scout"],
		allowed: ["read Plane", "file do-not-auto-land findings", "dispatch unblocked issues", "verify", "land", "close landed issues"],
		disallowed: ["auto-dispatch do-not-auto-land issues", "bypass blocked_by", "ignore WIP/rate-limit caps", "close issues before land"],
		steps: [
			{ id: "curate", label: "Group recurring Plane issues", owner: "plane-curator", allowed: ["read open issues", "file curator triage issues"], disallowed: ["dispatch work", "close source issues"], next: ["triage"] },
			{ id: "triage", label: "Promote one root-cause issue", owner: "human / promote-issue", allowed: ["set priority", "block/cancel duplicates", "remove do-not-auto-land when ready"], disallowed: ["send ambiguous duplicates to agents"], next: ["dispatch"] },
			{ id: "dispatch", label: "Dispatch eligible work by priority", owner: "Dispatcher", allowed: ["urgent→high→medium→low→none", "respect blocked_by", "respect WIP cap"], disallowed: ["spawn do-not-auto-land", "spawn while rate-limited"], next: ["execute"] },
			{ id: "execute", label: "Run workflow/agent", owner: "workflow driver / omp agent", allowed: ["use assigned tools", "emit checkpoints", "ask for input"], disallowed: ["mutate protected checkout", "skip verification"], next: ["land"] },
			{ id: "land", label: "Verify and land", owner: "Orchestrator", allowed: ["verify", "stage for confirm", "land", "close landed issue"], disallowed: ["land red gates", "silent catastrophe"], next: ["observe"] },
			{ id: "observe", label: "Audit and harvest learnings", owner: "Observer + Scout", allowed: ["file triage findings", "reap landed survivors"], disallowed: ["auto-dispatch unvetted findings"], next: ["curate"] },
		],
	},
	{
		id: "research-plan-implement",
		kind: "workflow",
		label: "Research → plan → implement",
		description: "Feature workflow used by New (auto): understand, plan, file/advance concerns, implement behind verification.",
		assigned: ["WorkflowDriver", "single omp inner agent", "optional branch agents"],
		allowed: ["read code", "spawn branches", "run verification", "checkpoint stages"],
		disallowed: ["skip human gates", "restart from scratch when checkpoint exists"],
		steps: [],
	},
	{
		id: "verify-loop",
		kind: "workflow",
		label: "Implement → verify → fixup",
		description: "Synthesized workflow from --verify: run the task, execute the command gate, loop fixups until green or capped.",
		assigned: ["WorkflowDriver", "SingleAgentExecutor"],
		allowed: ["run declared verify command", "bounded fixup turns"],
		disallowed: ["change the gate to pass", "unbounded retry"],
		steps: [],
	},
	{
		id: "observer-scout-curator",
		kind: "automation",
		label: "Observer / Scout / Curator feedback loop",
		description: "Reporting lane that turns regressions, latent reasoning, and repeated Plane issues into triage-safe backlog items.",
		assigned: ["Observer", "Scout", "plane-curator"],
		allowed: ["file do-not-auto-land findings", "deduplicate by stable fingerprints", "summarize clusters"],
		disallowed: ["auto-land its own findings", "file unlimited duplicates"],
		steps: [],
	},
];

export function workflowSnapshot(agents: AgentDTO[], extraDefinitions: WorkflowDefinition[] = []): WorkflowSnapshot {
	return {
		definitions: [...WORKFLOW_DEFINITIONS, ...extraDefinitions],
		runs: agents
			.filter((a) => a.kind === "workflow" || a.parentId || a.workflowState)
			.map((a) => {
				const total = a.workflowState?.rollup?.length ?? 0;
				const done = a.workflowState?.rollup?.filter((r) => r.status === "completed").length ?? 0;
				const current = a.workflowState?.rollup?.find((r) => r.status === "in_progress")?.label;
				return {
					agentId: a.id,
					name: a.name,
					status: a.status,
					workflow: a.workflow,
					stage: current ?? a.workflowState?.currentNode,
					progress: total ? { done, total } : undefined,
					rollup: a.workflowState?.rollup,
					issue: a.issue,
					parentId: a.parentId,
				};
			}),
	};
}
