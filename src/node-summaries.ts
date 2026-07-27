import { redact } from "./redact.ts";
import type { Node } from "./nodes.ts";
import type { NodeRecord, NodeSummaryRecord } from "./node-records.ts";

export interface NodeSummaryReferences {
	plan?: string;
	pullRequest?: string;
	gateLog?: string;
}

export interface NodeSummaryInput {
	node: Node;
	records: readonly NodeRecord[];
	references?: NodeSummaryReferences;
	now: number;
}

function sourceRefs(records: readonly NodeRecord[], references: NodeSummaryReferences | undefined): string[] {
	const refs = records.filter((record) => record.kind !== "summary").map((record) => `record:${record.id}`);
	if (references?.plan) refs.push(`plan:${references.plan}`);
	if (references?.pullRequest) refs.push(`pr:${references.pullRequest}`);
	if (references?.gateLog) refs.push(`gate:${references.gateLog}`);
	return [...new Set(refs)].sort();
}

function referencesSection(refs: readonly string[]): string {
	return refs.length ? refs.map((ref) => `- ${ref}`).join("\n") : "- No source is recorded; do not infer that none exists.";
}

/**
 * Rebuild the two consumer-shaped statements from current node state and durable evidence. It never
 * reads prior summary records, so a bad or removed source cannot become inherited context.
 */
export function regenerateNodeSummaries(input: NodeSummaryInput): [NodeSummaryRecord, NodeSummaryRecord] {
	const { node, now } = input;
	const records = input.records.filter((record) => record.kind !== "summary");
	const refs = sourceRefs(records, input.references);
	const activeRules = records.filter((record) => record.kind === "rule" && record.status === "active");
	const decisions = records.filter((record) => record.kind === "decision");
	const needs = node.state === "input" || node.state === "error";
	const goal = node.goal?.trim() ? redact(node.goal) : "No goal is recorded; do not infer one.";
	const title = redact(node.title);
	const upward: NodeSummaryRecord = {
		id: `summary:${node.id}:upward`,
		nodeId: node.id,
		createdAt: now,
		kind: "summary",
		direction: "upward",
		markdown: [
			`# Escalation — ${title}`,
			"",
			`**What happened.** Current state: ${node.state}.`,
			`**What is needed.** ${needs ? "A human decision or recovery is required; inspect the referenced evidence before acting." : "No escalation is currently required."}`,
			`**What it cost.** ${decisions.length ? "Decision and evidence cost are recorded by reference below; do not infer a cost from their absence." : "No cost evidence is recorded; do not infer zero cost."}`,
			"",
			"**Sources.**",
			referencesSection(refs),
		].join("\n"),
		sources: refs,
	};
	const downward: NodeSummaryRecord = {
		id: `summary:${node.id}:downward`,
		nodeId: node.id,
		createdAt: now,
		kind: "summary",
		direction: "downward",
		markdown: [
			`# Inherited context — ${title}`,
			"",
			`**Goal.** ${goal}`,
			`**Constraints.** ${activeRules.length ? `Follow ${activeRules.length} active rule record(s) referenced below; read their exact sentences before acting.` : "No active rule record is attached; absence grants no permission."}`,
			`**Decisions taken.** ${decisions.length ? `${decisions.length} decision record(s) are referenced below; do not restate or reinterpret them.` : "No decision record is attached; do not invent one."}`,
			"",
			"**Sources.**",
			referencesSection(refs),
		].join("\n"),
		sources: refs,
	};
	return [upward, downward];
}
