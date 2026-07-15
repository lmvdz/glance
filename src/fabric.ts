import * as path from "node:path";
import { scopeFor } from "./agent-scope.ts";
import { getStorageBackend } from "./dal/storage.ts";
import { readDigest } from "./digest.ts";
import { readFailureAnnotations } from "./failure-memory.ts";
import { leasesFor, type LeaseEntry } from "./leases.ts";
import { normalizeRepoPath } from "./project-registry.ts";
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

/** `scope: undefined` means unrestricted (every id on disk) — see `buildFabricSnapshot`'s
 *  `readScope` doc for why a human actor must get this instead of a live-roster-derived Set. */
async function receiptAgentIds(stateDir: string, scope: Set<string> | undefined): Promise<string[]> {
	const names = await getStorageBackend().readdir(path.join(stateDir, "receipts"));
	const ids = names.filter((n) => n.endsWith(".jsonl")).map((n) => n.slice(0, -6));
	return scope ? ids.filter((id) => scope.has(id)) : ids;
}

async function scopedReceipts(stateDir: string, scope: Set<string> | undefined): Promise<RunReceipt[]> {
	const out: RunReceipt[] = [];
	for (const id of await receiptAgentIds(stateDir, scope)) out.push(...(await readReceipts(stateDir, id).catch(() => [])));
	return out;
}

/** Every agent id with a persisted digest file on disk, regardless of live-roster membership.
 *  Mirrors `receiptAgentIds`'s directory-listing approach so a digest survives its agent being
 *  pruned from the live roster (completed/removed) exactly like a receipt already does. */
async function digestAgentIds(stateDir: string): Promise<string[]> {
	const names = await getStorageBackend().readdir(path.join(stateDir, "digests")).catch(() => []);
	return names.filter((n) => n.endsWith(".md")).map((n) => n.slice(0, -3));
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
	const b = getStorageBackend();
	const names = await b.readdir(stateDir);
	for (const name of names.filter((n) => /^scout-seen(?:\.|\.json$)/.test(n))) {
		try {
			const raw0 = await b.readText(path.join(stateDir, name));
			if (raw0 === undefined) continue; // entry vanished between readdir and read — skip it
			const raw = JSON.parse(raw0) as unknown;
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
	// Normalized both sides, like every other fact type: a raw `includes()` made `/srv/app/` a different
	// repo from `/srv/app` and silently dropped its recurring-failure memory.
	const admit = repoAdmitter(repos);
	const facts: FabricFailureFact[] = [];
	for (const a of Object.values(store)) {
		if (repos?.length && !admit(a.repo)) continue;
		facts.push({ type: "failure", source: { repo: a.repo }, fingerprint: a.fingerprint, branch: a.branch, rootCause: a.rootCause, at: a.at });
	}
	return facts;
}

/**
 * When a caller names its repos, EVERY fact type must honour that — not just the four that used to.
 *
 * `decisions`, `failures`, `leases` and `scout` were repo-filtered; `agents`, `digests` and the
 * receipts behind `hotAreas` were not. So `?repo=A` on the Knowledge view listed repo B's agents, and
 * the cold-start primer — which asks for exactly one repo — could BM25-rank repo B's digest to the top
 * and paste it into a unit working in repo A. Cross-repo (and, in DB-root mode, cross-tenant-adjacent)
 * bleed of another codebase's summarized source into a system prompt. (gpt-5.6-sol)
 *
 * Fails closed: a fact whose repo can't be resolved is dropped rather than admitted. Both sides are
 * normalized so a trailing slash doesn't silently empty the snapshot.
 */
function repoAdmitter(repos: string[] | undefined): (repo: string | undefined) => boolean {
	if (!repos?.length) return () => true; // unrestricted — the caller named no repos
	const keys = new Set(repos.map(normalizeRepoPath));
	return (repo) => repo !== undefined && keys.has(normalizeRepoPath(repo));
}

/**
 * The exact repo set an actor may see when no explicit `?repo=` narrows it — the SAME fallback
 * chain `buildFabricSnapshot` computes below for its own unrestricted `repos` (scoped agents' own
 * repos, falling back to the actor's persisted features when nothing is currently running).
 * Exported standalone for routes that need the fail-closed repo check WITHOUT building a full
 * snapshot (comprehension concern 01: `POST /api/attention` validates its `repo` field against
 * this before writing anything). Fails closed by construction: no scoped agents and no features ⇒
 * an empty set ⇒ every candidate repo is rejected, never "everything visible" by omission.
 */
export function actorVisibleRepoSet(actor: Actor, agents: AgentDTO[], features: PersistedFeature[] = []): Set<string> {
	const scope = scopeFor(actor, agents);
	const scopedAgents = agents.filter((a) => scope.has(a.id));
	const repos = scopedAgents.length ? scopedAgents.map((a) => a.repo) : features.map((f) => f.repo);
	return new Set(repos.map(normalizeRepoPath));
}

export async function buildFabricSnapshot(deps: FabricDeps): Promise<FabricSnapshot> {
	const generatedAt = deps.now?.() ?? Date.now();
	const scope = scopeFor(deps.actor, deps.agents);
	const inRepo = repoAdmitter(deps.repos);
	const scopedAgents = deps.agents.filter((a) => scope.has(a.id) && inRepo(a.repo));

	// The empty-Knowledge-view incident: for a human actor, `scopeFor` returns the CURRENT live
	// roster's ids as its "no restriction" proxy — correct for picking which AgentDTOs appear in
	// `agents` below (a live-roster view IS the right semantics there), but wrong for every OTHER
	// fact type that's read straight off disk (receipts → hot areas, digest files, scout). Once an
	// agent's run ends and it's pruned from the live roster (the common case — a daemon with 0
	// currently-running agents but hundreds of historical receipt/digest files), a roster-derived
	// scope never contains its id again, so `scopedReceipts`/digest reads silently returned nothing
	// FOREVER, even though the files sit right there under `stateDir`. Agent actors keep the real
	// restricted scope unchanged (their own subtree — a genuine security boundary, not a roster-
	// membership accident: `scopeFor`'s agent branch only ever admits roster-known ids anyway, so
	// `readScope` is never wider than `scope` for them). `undefined` here means "unrestricted read
	// of every id found on disk" — the `receiptAgentIds`/`digestAgentIds` directory listings.
	const readScope = deps.actor.origin === "agent" ? scope : undefined;

	// ATTRIBUTION vs INCLUSION are different questions, and answering them with the same filtered list
	// leaks. `latestRun` decides which repo a digest BELONGS to; it must be computed from every receipt
	// this actor may read. Filter first and an agent id reused across repos resolves to its stale
	// repo-A receipt — so repo B's digest, which overwrote `digests/<id>.md`, gets attributed to repo A
	// and admitted into a repo-A primer. Nothing binds a digest file to one repo forever; only the
	// LATEST receipt names its current one. (gpt-5.6-sol)
	const allReceipts = await scopedReceipts(deps.stateDir, readScope);
	const latestRun = new Map<string, RunReceipt>();
	for (const r of allReceipts) if (!latestRun.get(r.agentId) || (latestRun.get(r.agentId)?.startedAt ?? 0) < r.startedAt) latestRun.set(r.agentId, r);
	// Hot areas are per-FILE evidence, so they take the filtered list.
	const receipts = allReceipts.filter((r) => inRepo(r.repo));

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

	// Union the live-roster ids (always included — a just-started agent may have a digest before its
	// repo/name ever lands on disk elsewhere) with every digest file on disk when unrestricted
	// (`readScope` undefined). An agent actor's restricted set adds nothing beyond `scopedAgents`
	// (see the `readScope` doc above), so this is a no-op for that branch.
	const digestRepoById = new Map(scopedAgents.map((a) => [a.id, a.repo]));
	const digestIds = new Set(scopedAgents.map((a) => a.id));
	if (!readScope) for (const id of await digestAgentIds(deps.stateDir)) digestIds.add(id);

	const digests: FabricDigestFact[] = [];
	for (const id of digestIds) {
		const digest = await readDigest(deps.stateDir, id).catch(() => "");
		if (digest) {
			const run = latestRun.get(id);
			// A digest is a summary OF a repo's source. When the caller named repos, an unattributable
			// digest (no live agent, no surviving receipt) is dropped: we cannot prove it belongs here.
			const repo = digestRepoById.get(id) ?? run?.repo;
			if (!inRepo(repo)) continue;
			digests.push({ type: "digest", source: { agentId: id, runId: run?.runId, repo }, digest, ts: run?.endedAt ?? run?.startedAt });
		}
	}

	// Same disk-vs-roster fallback as digests: when there's no explicit `?repo=` AND no live agent
	// in scope, fall back to every repo this actor's own PERSISTED features know about (still never
	// unrestricted — decisions below are filtered to this exact set) rather than silently resolving
	// to an empty repo list just because nothing happens to be running right now.
	const repos = [
		...new Set(
			deps.repos?.length ? deps.repos : scopedAgents.length ? scopedAgents.map((a) => a.repo) : (deps.features ?? []).map((f) => f.repo),
		),
	];
	// Normalized, like `repoAdmitter` — a raw Set made `/srv/app/` a different repo from `/srv/app` and
	// silently dropped that feature's decisions from the primer.
	const repoSet = new Set(repos.map(normalizeRepoPath));
	const issueLists = await Promise.all(repos.map((repo) => (deps.listIssues ? deps.listIssues(repo).catch(() => null) : Promise.resolve(null))));
	const scout = await loadScoutFacts(deps.stateDir, issueLists.flatMap((x) => x ?? []), readScope);

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
		if (!repoSet.has(normalizeRepoPath(f.repo))) continue;
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
