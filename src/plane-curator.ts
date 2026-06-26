import { createPlaneIssue, fetchIssueDetail, listPlaneIssues } from "./plane.ts";
import type { IssueRef, TaskDetail } from "./types.ts";

export interface CuratorIssue {
	id: string;
	identifier?: string;
	name: string;
	url?: string;
	text: string;
}

export interface IssueCluster {
	id: string;
	title: string;
	reason: string;
	members: CuratorIssue[];
}

export interface CuratorReport {
	repo: string;
	issueCount: number;
	clusters: IssueCluster[];
	filed: IssueRef[];
}

interface Rule {
	id: string;
	title: string;
	reason: string;
	terms: RegExp[];
	min: number;
}

const CURATOR_TAG = "[curator]";
const TRIAGE_MARKER = "do-not-auto-land";

const RULES: Rule[] = [
	{
		id: "auto-land-transactional-checkout",
		title: "Unified fix: make auto-land use a transactional main checkout",
		reason: "Several issues point at the same land target isolation bug: dirty main, Done-but-unlanded drift, stale staged lands, gate races, and generated-file rewrites all break one shared checkout.",
		terms: [/auto-?land|done-but-unlanded|reconcile done|dirty main|dirty-tree|tsbuildinfo|staged land|main advances|runmaingate|land merges|codefix/i],
		min: 2,
	},
	{
		id: "plane-client-boundary",
		title: "Unified fix: harden Plane throttle/client/test boundary",
		reason: "The Plane integration failures share one boundary: throttledFetch retry policy, response-shape assumptions, cache/background errors, timeouts, and live credentials in tests.",
		terms: [/throttledfetch|429|res\.json|\.json method|getjson|plane-throttle|api\.plane\.so|plane credentials|per-request timeout|live api/i],
		min: 2,
	},
	{
		id: "test-env-process-isolation",
		title: "Unified fix: centralize test and child-process environment isolation",
		reason: "Multiple flaky gates come from ad hoc process environments: leaked OMP_SQUAD/GIT_CONFIG vars, timing-sensitive child processes, and cross-test pollution.",
		terms: [/test env|cross-test|flaky|spawn-timing|session-reattach|draining stderr|visit cap|GIT_CONFIG|process environment|child-process|preload/i],
		min: 2,
	},
	{
		id: "vision-ssrf-ip-pinning",
		title: "Unified fix: close vision SSRF pinning without breaking HTTPS identity",
		reason: "The SSRF fix and the SNI/cert warning are two halves of one network invariant: pin the vetted IP while preserving the original HTTPS hostname identity.",
		terms: [/vision|SSRF|DNS-rebinding|TOCTOU|SNI|cert validity|pinning|resolved IP|https/i],
		min: 2,
	},
	{
		id: "resource-lifecycle-reapers",
		title: "Unified fix: make resource cleanup observable and platform-aware",
		reason: "The resource lifecycle issues all concern hidden cleanup failures or stale process/resource identity: reapers, removeWorktree errors, and PID reuse.",
		terms: [/orphan reaper|sandbox containers|ACP children|removeWorktree|PID-reuse|state-lock|cleanup|leak/i],
		min: 2,
	},
];

export function clusterPlaneIssues(issues: CuratorIssue[]): IssueCluster[] {
	const clusters = new Map<string, IssueCluster>();
	const claimed = new Set<string>();
	const candidates = issues.filter((i) => !i.name.startsWith(CURATOR_TAG));

	for (const rule of RULES) {
		const members = candidates.filter((i) => !claimed.has(i.id) && rule.terms.some((re) => re.test(searchable(i))));
		if (members.length >= rule.min) {
			clusters.set(rule.id, { id: rule.id, title: rule.title, reason: rule.reason, members: sortMembers(members) });
			for (const m of members) claimed.add(m.id);
		}
	}

	// ponytail: cheap duplicate net for titles the hand-written rules do not know yet.
	const rest = candidates.filter((i) => !claimed.has(i.id));
	for (let i = 0; i < rest.length; i++) {
		const base = rest[i];
		const members = [base];
		const bt = titleTokens(base.name);
		for (let j = i + 1; j < rest.length; j++) {
			if (jaccard(bt, titleTokens(rest[j].name)) >= 0.58) members.push(rest[j]);
		}
		if (members.length >= 2) {
			const id = `duplicate-${fingerprint(base.name)}`;
			clusters.set(id, {
				id,
				title: `Unified fix: dedupe ${shortTitle(base.name)}`,
				reason: "These open issues have highly similar titles and should be triaged as one root-cause fix before dispatching separately.",
				members: sortMembers(members),
			});
			for (const m of members) claimed.add(m.id);
		}
	}

	return [...clusters.values()].sort((a, b) => b.members.length - a.members.length || a.title.localeCompare(b.title));
}

export async function curatePlaneIssues(repo: string, opts: { file?: boolean } = {}): Promise<CuratorReport | null> {
	const refs = await listPlaneIssues(repo);
	if (!refs) return null;
	const issues: CuratorIssue[] = [];
	for (const ref of refs) {
		const detail = await fetchIssueDetail(repo, ref.id).catch(() => null);
		issues.push(toCuratorIssue(ref, detail));
	}
	const clusters = clusterPlaneIssues(issues);
	const filed: IssueRef[] = [];
	if (opts.file) {
		const existing = new Set(refs.filter((r) => r.name.startsWith(CURATOR_TAG)).map((r) => r.name));
		for (const cluster of clusters) {
			const name = `${CURATOR_TAG} ${TRIAGE_MARKER}: ${cluster.title}`;
			if (existing.has(name)) continue;
			const created = await createPlaneIssue(repo, name, renderClusterHtml(cluster));
			if (created) filed.push(created);
		}
	}
	return { repo, issueCount: issues.length, clusters, filed };
}

export function renderClusterReport(report: CuratorReport): string {
	const lines = [`Plane curator: ${report.repo}`, `Open issues scanned: ${report.issueCount}`, `Clusters: ${report.clusters.length}`];
	for (const cluster of report.clusters) {
		lines.push("", `## ${cluster.title}`, cluster.reason, `Members (${cluster.members.length}):`);
		for (const m of cluster.members) lines.push(`- ${m.identifier ?? m.id}: ${m.name}`);
	}
	if (report.filed.length) lines.push("", `Filed curator issues: ${report.filed.map((i) => i.identifier ?? i.name).join(", ")}`);
	return lines.join("\n");
}

export function renderClusterHtml(cluster: IssueCluster): string {
	return `<div><p><strong>Curator finding.</strong> ${esc(cluster.reason)}</p><h2>Grouped issues</h2><ul>${cluster.members
		.map((m) => `<li><strong>${esc(m.identifier ?? m.id)}</strong> — ${esc(m.name)}${m.url ? ` (<a href="${esc(m.url)}">open</a>)` : ""}</li>`)
		.join("")}</ul><h2>Action</h2><p>Fix these as one root-cause change, then close the duplicate/source issues after verification.</p></div>`;
}

function toCuratorIssue(ref: IssueRef, detail: TaskDetail | null): CuratorIssue {
	return {
		id: ref.id,
		identifier: detail?.identifier ?? ref.identifier,
		name: detail?.name ?? ref.name,
		url: detail?.url ?? ref.url,
		text: [detail?.body, detail?.tier2?.description, detail?.tier2?.acceptanceCriteria, detail?.tier2?.verification, detail?.tier2?.scope].filter(Boolean).join("\n"),
	};
}

function searchable(i: CuratorIssue): string {
	return `${i.name}\n${i.text}`.replace(/\[[^\]]+\]/g, " ").replace(/do-?not-?auto-?land/gi, " ");
}

function titleTokens(s: string): Set<string> {
	return new Set(
		s
			.toLowerCase()
			.replace(/\[[^\]]+\]/g, " ")
			.replace(/do-?not-?auto-?land|observer|scout|curator|fix|issue|bug|the|and|with|from|into|instead|during/g, " ")
			.split(/[^a-z0-9]+/)
			.filter((t) => t.length > 2),
	);
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (!a.size || !b.size) return 0;
	let hit = 0;
	for (const t of a) if (b.has(t)) hit++;
	return hit / (a.size + b.size - hit);
}

function fingerprint(s: string): string {
	return [...titleTokens(s)].sort().slice(0, 5).join("-") || "issues";
}

function shortTitle(s: string): string {
	return s.replace(/^\[[^\]]+\]\s*/g, "").replace(/^do-not-auto-land:\s*/i, "").slice(0, 80);
}

function sortMembers(members: CuratorIssue[]): CuratorIssue[] {
	return [...members].sort((a, b) => (a.identifier ?? a.name).localeCompare(b.identifier ?? b.name));
}

function esc(s: string): string {
	return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch);
}
