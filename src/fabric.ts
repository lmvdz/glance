import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scopeFor } from "./agent-scope.ts";
import { readDigest } from "./digest.ts";
import { readFailureAnnotations } from "./failure-memory.ts";
import { leasesFor, type LeaseEntry } from "./leases.ts";
import { readReceipts } from "./receipts.ts";
import type { Actor, AgentDTO, IssueRef, PersistedFeature, RunReceipt } from "./types.ts";

export interface FactSource {
	agentId?: string;
	runId?: string;
	repo?: string;
	issueId?: string;
	featureId?: string;
	file?: string;
}

export interface FabricAgentFact {
	type: "agent";
	source: FactSource;
	agent: Pick<AgentDTO, "id" | "name" | "status" | "activity" | "todo" | "owns" | "featureId" | "parentId" | "issue" | "repo" | "worktree">;
}

export interface FabricDigestFact {
	type: "digest";
	source: FactSource;
	digest: string;
	/** Epoch ms the underlying run ended (retrieval-provenance concern 02) — the latest receipt's
	 *  `endedAt`, falling back to `startedAt`. Absent when no receipt was found for the agent. */
	ts?: number;
}

export interface FabricHotAreaFact {
	type: "hot-area";
	source: FactSource;
	repo: string;
	file: string;
	score: number;
	touchedBy: FactSource[];
}

export interface FabricScoutFact {
	type: "scout";
	source: FactSource;
	issue: IssueRef;
	title: string;
	filedAt?: number;
}

export interface FabricLeaseFact {
	type: "lease";
	source: FactSource;
	lease: LeaseEntry;
}

export interface FabricDecisionFact {
	type: "decision";
	source: FactSource;
	featureTitle: string;
	text: string;
	decisionSource?: "plan" | "human" | "agent";
	createdAt?: number;
}

/**
 * Recurring-failure memory (agentic-learning-loop concern 05, downscoped) — a root-cause annotation
 * for a failure the observer's fingerprint streak confirmed is RECURRING (not a BM25-similarity
 * guess; see failure-memory.ts). Repo-scoped like `FabricDecisionFact` (annotations aren't tied to
 * any one agent/worktree's lifetime, so there is no `agentId` to scope through `scopeFor`).
 */
export interface FabricFailureFact {
	type: "failure";
	source: FactSource;
	fingerprint: string;
	branch: string;
	rootCause: string;
	at: number;
}

export interface FabricSnapshot {
	actor: string;
	generatedAt: number;
	scope: string[];
	agents: FabricAgentFact[];
	digests: FabricDigestFact[];
	hotAreas: FabricHotAreaFact[];
	scout: FabricScoutFact[];
	leases: FabricLeaseFact[];
	decisions: FabricDecisionFact[];
	failures: FabricFailureFact[];
}

interface ScoutSeenEntry {
	title?: string;
	issueId?: string;
	filedAt?: number;
	agent?: string;
	agentId?: string;
	runId?: string;
	issue?: string;
}

type ScoutSeen = Record<string, ScoutSeenEntry>;

export interface FabricDeps {
	actor: Actor;
	agents: AgentDTO[];
	stateDir: string;
	repos?: string[];
	includeLeases?: boolean;
	listIssues?: (repo: string) => Promise<IssueRef[] | null>;
	/** Persisted features — their decisions become durable KB facts. */
	features?: PersistedFeature[];
	now?: () => number;
}

const SCOUT_TAG = "[scout]";
const HOT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function cleanScoutTitle(name: string): string {
	return name.replace(/^\[scout\]\s*/i, "").replace(/^do-?not-?auto-?land:\s*/i, "").trim();
}

async function receiptAgentIds(stateDir: string, scope: Set<string>): Promise<string[]> {
	try {
		const names = await fs.readdir(path.join(stateDir, "receipts"));
		return names.filter((n) => n.endsWith(".jsonl")).map((n) => n.slice(0, -6)).filter((id) => scope.has(id));
	} catch {
		return [];
	}
}

async function scopedReceipts(stateDir: string, scope: Set<string>): Promise<RunReceipt[]> {
	const out: RunReceipt[] = [];
	for (const id of await receiptAgentIds(stateDir, scope)) out.push(...(await readReceipts(stateDir, id).catch(() => [])));
	return out;
}

export function hotAreasFromReceipts(receipts: RunReceipt[], now = Date.now()): FabricHotAreaFact[] {
	const byFile = new Map<string, { repo: string; file: string; score: number; touchedBy: FactSource[] }>();
	for (const r of receipts) {
		const age = Math.max(0, now - (r.endedAt ?? r.startedAt));
		const weight = 1 / (1 + age / HOT_WINDOW_MS);
		for (const file of r.filesTouched) {
			const key = `${r.repo}\0${file}`;
			const entry = byFile.get(key) ?? { repo: r.repo, file, score: 0, touchedBy: [] };
			entry.score += weight;
			entry.touchedBy.push({ agentId: r.agentId, runId: r.runId, repo: r.repo, file });
			byFile.set(key, entry);
		}
	}
	return [...byFile.values()]
		.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
		.slice(0, 50)
		.map((h) => ({ type: "hot-area", source: h.touchedBy[0] ?? { repo: h.repo, file: h.file }, repo: h.repo, file: h.file, score: Number(h.score.toFixed(4)), touchedBy: h.touchedBy }));
}

async function readScoutSeen(stateDir: string): Promise<ScoutSeen> {
	const out: ScoutSeen = {};
	let names: string[];
	try {
		names = await fs.readdir(stateDir);
	} catch {
		return out;
	}
	for (const name of names.filter((n) => /^scout-seen(?:\.|\.json$)/.test(n))) {
		try {
			const raw = JSON.parse(await fs.readFile(path.join(stateDir, name), "utf8")) as unknown;
			if (raw && typeof raw === "object") Object.assign(out, raw as ScoutSeen);
		} catch {
			// Corrupt scout cache should not break the read-only fabric.
		}
	}
	return out;
}

export async function loadScoutFacts(stateDir: string, issues: IssueRef[], scope?: Set<string>): Promise<FabricScoutFact[]> {
	const seen = await readScoutSeen(stateDir);
	const seenByIssue = new Map(Object.values(seen).filter((e) => e.issueId).map((e) => [e.issueId as string, e]));
	const seenByTitle = new Map(Object.values(seen).filter((e) => e.title).map((e) => [e.title as string, e]));
	const facts: FabricScoutFact[] = [];
	for (const issue of issues.filter((i) => i.name.includes(SCOUT_TAG))) {
		const title = cleanScoutTitle(issue.name);
		const seenEntry = seenByIssue.get(issue.id) ?? seenByTitle.get(title);
		const agentId = seenEntry?.agentId ?? seenEntry?.agent;
		if (scope && (!agentId || !scope.has(agentId))) continue;
		facts.push({
			type: "scout",
			source: { agentId, runId: seenEntry?.runId, issueId: issue.id, repo: issue.projectId },
			issue,
			title,
			filedAt: seenEntry?.filedAt,
		});
	}
	return facts;
}

/**
 * Recurring-failure facts, repo-scoped (copy of `loadScoutFacts`'s scope-filtering INTENT, adapted:
 * an annotation carries no `agentId` — it survives past the worktree that tripped it — so it is
 * filtered by REPO membership instead, exactly like `FabricDecisionFact` above). Never an unscoped
 * global store leak: a repo not in `repos` (when the caller passed one) never surfaces its failures.
 */
export function loadFailureFacts(stateDir: string, repos?: string[]): FabricFailureFact[] {
	const store = readFailureAnnotations(stateDir);
	const facts: FabricFailureFact[] = [];
	for (const a of Object.values(store)) {
		if (repos?.length && !repos.includes(a.repo)) continue;
		facts.push({ type: "failure", source: { repo: a.repo }, fingerprint: a.fingerprint, branch: a.branch, rootCause: a.rootCause, at: a.at });
	}
	return facts;
}

export async function buildFabricSnapshot(deps: FabricDeps): Promise<FabricSnapshot> {
	const generatedAt = deps.now?.() ?? Date.now();
	const scope = scopeFor(deps.actor, deps.agents);
	const scopedAgents = deps.agents.filter((a) => scope.has(a.id));
	const receipts = await scopedReceipts(deps.stateDir, scope);
	const latestRun = new Map<string, RunReceipt>();
	for (const r of receipts) if (!latestRun.get(r.agentId) || (latestRun.get(r.agentId)?.startedAt ?? 0) < r.startedAt) latestRun.set(r.agentId, r);

	const agents: FabricAgentFact[] = scopedAgents.map((a) => ({
		type: "agent",
		source: { agentId: a.id, runId: latestRun.get(a.id)?.runId, repo: a.repo },
		agent: {
			id: a.id,
			name: a.name,
			status: a.status,
			activity: a.activity,
			todo: a.todo,
			owns: a.owns,
			featureId: a.featureId,
			parentId: a.parentId,
			issue: a.issue,
			repo: a.repo,
			worktree: a.worktree,
		},
	}));

	const digests: FabricDigestFact[] = [];
	for (const a of scopedAgents) {
		const digest = await readDigest(deps.stateDir, a.id).catch(() => "");
		if (digest) {
			const run = latestRun.get(a.id);
			digests.push({ type: "digest", source: { agentId: a.id, runId: run?.runId, repo: a.repo }, digest, ts: run?.endedAt ?? run?.startedAt });
		}
	}

	const repos = [...new Set(deps.repos?.length ? deps.repos : scopedAgents.map((a) => a.repo))];
	const repoSet = new Set(repos);
	const issueLists = await Promise.all(repos.map((repo) => (deps.listIssues ? deps.listIssues(repo).catch(() => null) : Promise.resolve(null))));
	const scout = await loadScoutFacts(deps.stateDir, issueLists.flatMap((x) => x ?? []), scope);

	const namesById = new Map(scopedAgents.map((a) => [a.id, a.name]));
	const idsByName = new Map(scopedAgents.map((a) => [a.name, a.id]));
	const leases: FabricLeaseFact[] = [];
	if (deps.includeLeases !== false) {
		for (const repo of repos) {
			for (const lease of await leasesFor(repo).catch(() => [])) {
				const agentId = scope.has(lease.session) ? lease.session : idsByName.get(lease.session);
				if (!agentId && ![...namesById.values()].includes(lease.session)) continue;
				leases.push({ type: "lease", source: { agentId, repo: lease.repo, file: lease.file }, lease });
			}
		}
	}

	const decisions: FabricDecisionFact[] = [];
	for (const f of deps.features ?? []) {
		if (f.archived) continue;
		// Scope decisions to the SAME computed repo set every other fact type uses (agents, digests,
		// leases, issues) — NOT the raw `deps.repos`. When the caller omits `repos` (the default
		// /api/fabric path with no ?repo), filtering on `deps.repos?.length` short-circuits false and
		// leaks decisions from every repo/tenant into an actor's scoped fabric + cold-start primer.
		if (!repoSet.has(f.repo)) continue;
		for (const d of f.decisions ?? []) {
			if (!d.text?.trim()) continue;
			decisions.push({
				type: "decision",
				source: { repo: f.repo, featureId: f.id },
				featureTitle: f.title,
				text: d.text,
				decisionSource: d.source,
				createdAt: d.createdAt,
			});
		}
	}

	const failures = loadFailureFacts(deps.stateDir, deps.repos);

	return {
		actor: deps.actor.id,
		generatedAt,
		scope: [...scope].sort(),
		agents,
		digests,
		hotAreas: hotAreasFromReceipts(receipts, generatedAt),
		scout,
		leases,
		decisions,
		failures,
	};
}
