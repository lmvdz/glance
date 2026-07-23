import * as path from "node:path";
import { listPlanDirs, parsePlanConcerns, parsePlanDocuments } from "./features.ts";
import { buildPlanGraph } from "../webapp/src/lib/planGraph.ts";

export interface PlanBriefConcernDTO {
	file: string;
	path: string;
	title: string;
	status: string;
	open: boolean;
	priority?: string;
	complexity?: string;
	phase: number;
	blockedBy: string[];
	acceptanceCount: number;
	touches: string[];
}

export interface PlanBriefDecisionDTO {
	text: string;
	source: "design" | "concern" | "overview";
}

export interface PlanBriefDTO {
	planDir: string;
	name: string;
	title: string;
	outcome: string;
	status: { total: number; open: number; done: number; blocked: number; byStatus: Record<string, number> };
	concerns: PlanBriefConcernDTO[];
	timeline: Array<{ phase: number; title: string; gate: string; concernFiles: string[] }>;
	outOfScope: string[];
	decisions: PlanBriefDecisionDTO[];
	touches: string[];
	dependencyIssues: string[];
	updatedAt: number;
}

function planDirFromName(name: string): string | undefined {
	const clean = name.trim().replace(/^\/+|\/+$/g, "");
	if (!clean || clean.includes("..") || path.isAbsolute(clean)) return undefined;
	if (clean === "plans") return undefined;
	return clean.startsWith("plans/") ? clean : `plans/${clean}`;
}

function sectionText(markdown: string, names: string[]): string {
	const wanted = new Set(names.map((name) => name.toLowerCase()));
	const lines = markdown.split(/\r?\n/);
	const out: string[] = [];
	let inSection = false;
	let level = 0;
	for (const line of lines) {
		const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
		if (heading) {
			const headingLevel = heading[1].length;
			const title = heading[2].replace(/[:#]+$/g, "").trim().toLowerCase();
			if (wanted.has(title)) {
				inSection = true;
				level = headingLevel;
				continue;
			}
			if (inSection && headingLevel <= level) break;
		}
		if (inSection) out.push(line);
	}
	return out.join("\n").trim();
}

function sectionItems(markdown: string, names: string[]): string[] {
	const text = sectionText(markdown, names);
	const items = text.split(/\r?\n/).map((line) => line.trim()).flatMap((line) => {
		const bullet = /^(?:[-*]|\d+\.)\s+(.+?)\s*$/.exec(line);
		return bullet?.[1] ? [bullet[1].trim()] : [];
	});
	return [...new Set(items)].slice(0, 8);
}

function firstParagraph(markdown: string): string {
	const lines = markdown.split(/\r?\n/);
	const out: string[] = [];
	for (const raw of lines) {
		const line = raw.trim();
		if (!line || line.startsWith("#") || line.startsWith("|") || /^[-:|\s]+$/.test(line)) {
			if (out.length) break;
			continue;
		}
		out.push(line.replace(/^[-*]\s+/, ""));
		if (out.join(" ").length > 240) break;
	}
	return out.join(" ").replace(/\s+/g, " ").trim();
}

function statusClosed(status: string): boolean {
	return /^(done|closed|complete|completed|cancelled|canceled)$/i.test(status.replace(/_/g, "-"));
}

export async function assemblePlanBrief(repo: string, nameOrDir: string): Promise<PlanBriefDTO | undefined> {
	const planDir = planDirFromName(nameOrDir);
	if (!planDir) return undefined;
	const plans = await listPlanDirs(repo);
	const plan = plans.find((item) => item.dir === planDir);
	if (!plan) return undefined;
	const [concerns, documents] = await Promise.all([parsePlanConcerns(repo, planDir), parsePlanDocuments(repo, planDir)]);
	const overview = documents.find((doc) => /^(00-overview|overview|readme)$/i.test(doc.file.replace(/\.md$/i, "")))?.content ?? "";
	const design = documents.find((doc) => /^design$/i.test(doc.file.replace(/\.md$/i, "")))?.content ?? "";
	const graph = buildPlanGraph(concerns.map((c) => ({ file: c.file, title: c.title, status: c.status, open: c.open, complexity: c.complexity, prerequisites: c.prerequisites, touches: c.touches })), overview);
	const nodeByFile = new Map(graph.nodes.map((node) => [node.id, node]));
	const incoming = new Map<string, string[]>();
	for (const edge of graph.edges) {
		const list = incoming.get(edge.to) ?? [];
		list.push(edge.from);
		incoming.set(edge.to, list);
	}
	const outOfScope = sectionItems(overview, ["Out of Scope", "Non-goals", "Non-goals / Out of Scope"]);
	const overviewDecisions = sectionItems(overview, ["Decisions", "Decision Log"]);
	const designDecisions = sectionItems(design, ["Decisions", "Decision Log", "Rationale"]);
	const concernDecisions = concerns.flatMap((concern) => concern.decisions.map((text) => ({ text, source: "concern" as const })));
	const decisions = [
		...designDecisions.map((text) => ({ text, source: "design" as const })),
		...overviewDecisions.map((text) => ({ text, source: "overview" as const })),
		...concernDecisions,
	].filter((item, index, all) => all.findIndex((other) => other.text === item.text) === index).slice(0, 10);
	const briefConcerns = concerns.map((concern) => ({
		file: concern.file,
		path: concern.path,
		title: concern.title,
		status: concern.status,
		open: concern.open,
		priority: concern.priority,
		complexity: concern.complexity,
		phase: (nodeByFile.get(concern.file)?.col ?? 0) + 1,
		blockedBy: incoming.get(concern.file) ?? [],
		acceptanceCount: concern.acceptanceCriteria.length,
		touches: concern.touches,
	}));
	const byStatus: Record<string, number> = {};
	for (const concern of briefConcerns) byStatus[concern.status] = (byStatus[concern.status] ?? 0) + 1;
	const phases = new Map<number, PlanBriefConcernDTO[]>();
	for (const concern of briefConcerns) phases.set(concern.phase, [...(phases.get(concern.phase) ?? []), concern]);
	const timeline = [...phases.entries()].sort(([a], [b]) => a - b).map(([phase, items]) => ({
		phase,
		title: phase === 1 ? "Foundation" : items.every((item) => statusClosed(item.status)) ? "Closed batch" : `Batch ${phase}`,
		gate: items.every((item) => !item.open) ? "All concerns closed" : `${items.filter((item) => item.open).length} concern${items.filter((item) => item.open).length === 1 ? "" : "s"} still open`,
		concernFiles: items.map((item) => item.file),
	}));
	const touches = [...new Set(briefConcerns.flatMap((concern) => concern.touches))].sort();
	const fallbackOutcome = firstParagraph(sectionText(overview, ["Outcome", "Desired End State", "Goal", "Goals"])) || firstParagraph(overview) || `Plan ${plan.title} is ready for review.`;
	return {
		planDir,
		name: path.basename(planDir),
		title: plan.title,
		outcome: fallbackOutcome,
		status: { total: briefConcerns.length, open: briefConcerns.filter((c) => c.open).length, done: briefConcerns.filter((c) => !c.open).length, blocked: briefConcerns.filter((c) => c.blockedBy.length > 0).length, byStatus },
		concerns: briefConcerns,
		timeline,
		outOfScope,
		decisions,
		touches,
		dependencyIssues: graph.issues.map((issue) => issue.message),
		updatedAt: Math.max(plan.updatedAt, ...documents.map((doc) => doc.updatedAt), 0),
	};
}
