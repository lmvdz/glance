/**
 * Plane integration seam.
 *
 * Lets the command center show the real work items (Plane issues) a project's
 * agents are advancing, and spawn an agent directly from an issue.
 *
 * Configured entirely by environment on the daemon (no creds are bundled):
 *   PLANE_API_KEY        required — a Plane personal/API token
 *   PLANE_WORKSPACE      required — workspace slug
 *   PLANE_BASE_URL       optional — defaults to https://api.plane.so
 *   PLANE_PROJECT_ID     optional — fallback project id for every repo
 *   PLANE_PROJECT_MAP    optional — JSON: { "<repo path or basename>": "<plane project id>" }
 *
 * `listPlaneIssues` returns `null` when Plane isn't configured (the server maps
 * that to HTTP 501 and the UI shows a "connect Plane" hint), `[]` when there's
 * no mapped project or no open issues, otherwise the open issues.
 */

import * as path from "node:path";
import { envInt } from "./config.ts";
import type { IssueRef, PlaneTicket, TaskDetail } from "./types.ts";
import { makeCache, throttledFetch } from "./plane-throttle.ts";
import { parseTier2 } from "./tier2.ts";

interface PlaneConfig {
	apiKey: string;
	workspace: string;
	baseUrl: string;
	projectMap: Record<string, string>;
	fallbackProjectId?: string;
}

function readConfig(): PlaneConfig | null {
	// Accept the alternate secret names too, so the daemon reads ~/.claude/secrets/plane.env directly.
	const apiKey = process.env.PLANE_API_KEY ?? process.env.PLANE_API_TOKEN;
	const workspace = process.env.PLANE_WORKSPACE ?? process.env.PLANE_WORKSPACE_SLUG;
	if (!apiKey || !workspace) return null;
	let projectMap: Record<string, string> = {};
	if (process.env.PLANE_PROJECT_MAP) {
		try {
			projectMap = JSON.parse(process.env.PLANE_PROJECT_MAP) as Record<string, string>;
		} catch {
			projectMap = {};
		}
	}
	return {
		apiKey,
		workspace,
		// A pasted base URL may already carry the /api/v1 suffix; strip it since every call appends it.
		baseUrl: (process.env.PLANE_BASE_URL ?? "https://api.plane.so").replace(/\/api\/v1\/?$/, ""),
		projectMap,
		fallbackProjectId: process.env.PLANE_PROJECT_ID,
	};
}

function projectIdFor(repo: string, cfg: PlaneConfig): string | undefined {
	return cfg.projectMap[repo] ?? cfg.projectMap[path.basename(repo)] ?? cfg.fallbackProjectId;
}

interface PlaneContext {
	cfg: PlaneConfig;
	headers: Record<string, string>;
	projectId?: string;
	base: string;
}

function projectBase(cfg: PlaneConfig, projectId: string): string {
	return `${cfg.baseUrl}/api/v1/workspaces/${cfg.workspace}/projects/${projectId}`;
}

/** Shared preamble: config + auth headers + (repo→)project id + project base URL. `undefined` ⇒ Plane not configured. */
function planeContext(repo?: string): PlaneContext | undefined {
	const cfg = readConfig();
	if (!cfg) return undefined;
	const headers = { "x-api-key": cfg.apiKey, "content-type": "application/json" };
	const projectId = repo != null ? projectIdFor(repo, cfg) : undefined;
	// ponytail: base is only valid with a projectId; every caller gates on projectId before using it.
	return { cfg, headers, projectId, base: projectId ? projectBase(cfg, projectId) : "" };
}

interface PlaneIssue {
	id: string;
	name?: string;
	sequence_id?: number;
	project?: string;
	state_detail?: { name?: string; group?: string };
	state?: string;
	project_detail?: { identifier?: string };
	priority?: string;
	created_at?: string;
	updated_at?: string;
	completed_at?: string;
}

/** A Plane issue reduced to what a temporal view needs: state group + parsed epoch timestamps.
 *  Unlike listPlaneIssues, this KEEPS timestamps and does NOT drop completed/cancelled issues
 *  (those are exactly the "closed" milestones a timeline wants). */
export interface PlaneIssueTemporal {
	id: string;
	/** human identifier like OMPSQ-35, when the project prefix is resolvable. */
	identifier?: string;
	name: string;
	/** state group: backlog | unstarted | started | completed | cancelled. */
	state?: string;
	priority?: string;
	createdAt?: number;
	updatedAt?: number;
	completedAt?: number;
}

/** Read all issues for a repo's project (INCLUDING finished ones) with timestamps, for omp-graph.
 *  `null` ⇒ Plane not configured / unreachable (caller degrades to no tracks). */
export async function listPlaneIssuesRaw(repo: string): Promise<PlaneIssueTemporal[] | null> {
	const ctx = planeContext(repo);
	if (!ctx) return null;
	const { headers, projectId, base } = ctx;
	if (!projectId) return [];
	const res = await throttledFetch(`${base}/issues/?per_page=100`, { headers });
	if (!res || !res.ok) return null;
	const data = (await res.json().catch(() => null)) as { results?: PlaneIssue[] } | PlaneIssue[] | null;
	const items = Array.isArray(data) ? data : (data?.results ?? []);
	const [groups, prefix] = await Promise.all([fetchStateGroups(base, headers), projectPrefix(base, headers)]);
	const ms = (s?: string): number | undefined => {
		if (!s) return undefined;
		const t = Date.parse(s);
		return Number.isNaN(t) ? undefined : t;
	};
	return items.map((raw) => ({
		id: raw.id,
		identifier: prefix && raw.sequence_id != null ? `${prefix}-${raw.sequence_id}` : undefined,
		name: raw.name ?? raw.id,
		state: raw.state_detail?.group ?? (raw.state ? groups.get(raw.state) : undefined),
		priority: raw.priority,
		createdAt: ms(raw.created_at),
		updatedAt: ms(raw.updated_at),
		completedAt: ms(raw.completed_at),
	}));
}

/** True when an issue's name flags it for human review / do-NOT-auto-land. The dispatcher skips these,
 *  but they still appear in the UI's issue list (no filtering here). */
export function noAutoDispatchName(name: string): boolean {
	return /do not auto-?land|human[ -]?review|do-?not-?auto/i.test(name);
}

function toIssueRef(raw: PlaneIssue, cfg: PlaneConfig, projectId: string, prefix?: string): IssueRef {
	const ident = raw.project_detail?.identifier ?? prefix;
	const name = raw.name ?? "(untitled)";
	return {
		id: raw.id,
		identifier: ident && raw.sequence_id != null ? `${ident}-${raw.sequence_id}` : undefined,
		name,
		state: raw.state_detail?.group ?? raw.state,
		priority: raw.priority,
		url: `${webBase(cfg)}/${cfg.workspace}/projects/${projectId}/issues/${raw.id}`,
		projectId,
		noAutoDispatch: noAutoDispatchName(name),
	};
}

/** Short-TTL single-flight cache of listPlaneIssues results, keyed by repo — collapses the dispatcher,
 *  observer, reaper, and scout all polling the same repo into ONE API refresh. Cleared on any write. */
const issueListCache = makeCache<IssueRef[] | null>();

/** How many 50-issue pages the issue polls fetch (≈`×50` newest issues). The open-work poll
 *  (listPlaneIssues) MUST fetch as deeply as the all-states reconciler: it filters to open AFTER
 *  fetching, so a single page silently drops open work that sorts past page 1 on any project whose
 *  newest 50 issues are mostly closed. Override with OMP_SQUAD_PLANE_MAX_PAGES for very large backlogs. */
function maxIssuePages(): number {
	const n = Number(process.env.OMP_SQUAD_PLANE_MAX_PAGES);
	return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 4;
}

/** Open issues for the Plane project mapped to `repo`. `null` ⇒ Plane not configured / unreachable. */
export async function listPlaneIssues(repo: string): Promise<IssueRef[] | null> {
	// Cache successful reads (not null/failure) so repeated polls within the TTL share a single call.
	return issueListCache.get(repo, envInt("OMP_SQUAD_PLANE_CACHE_MS", 15000), () => listPlaneIssuesUncached(repo), (v) => v !== null);
}

async function listPlaneIssuesUncached(repo: string): Promise<IssueRef[] | null> {
	const all = await fetchIssueRefs(repo, maxIssuePages());
	if (all === null) return null;
	const open = all.filter((i) => i.state !== "completed" && i.state !== "cancelled");
	const ctx = planeContext(repo);
	if (!ctx) return open;
	// Populate blocked_by relations so the dispatcher can defer an issue while a blocker is still open.
	// Sequential (not concurrent): Plane rate-limits, and a burst of N /relations/ calls trips 429 —
	// which would silently empty blockedBy and let a blocked issue dispatch. Ceiling: O(open) serial
	// requests per poll; fine for a normal backlog, add bounded concurrency if one ever runs large.
	for (const ref of open) ref.blockedBy = await fetchBlockedBy(ctx.base, ctx.headers, ref.id);
	return open;
}

/** Fetch up to `maxPages`×50 issues in EVERY state (terminal included), state resolved to its group. */
async function fetchIssueRefs(repo: string, maxPages: number): Promise<IssueRef[] | null> {
	const ctx = planeContext(repo);
	if (!ctx) return null;
	const { cfg, headers, projectId, base } = ctx;
	if (!projectId) return [];
	// The list endpoint returns `state` as an id, not a group — resolve ids → groups so
	// completed/cancelled are recognizable. It also omits project_detail, so fetch the project's
	// identifier prefix to build human ids (e.g. OMPSQ-35) — without it dispatched agents fall
	// back to agent-N and collide on names.
	const [groups, prefix] = await Promise.all([fetchStateGroups(base, headers), projectPrefix(base, headers)]);
	const out: IssueRef[] = [];
	for (let page = 1; page <= maxPages; page++) {
		const res = await throttledFetch(`${base}/issues/?per_page=50&page=${page}`, { headers });
		if (!res || !res.ok) return page === 1 ? null : out; // first-page failure ⇒ unreachable; later ⇒ partial is fine
		const data = (await res.json().catch(() => null)) as { results?: PlaneIssue[] } | PlaneIssue[] | null;
		const items = Array.isArray(data) ? data : (data?.results ?? []);
		for (const raw of items) {
			const ref = toIssueRef(raw, cfg, projectId, prefix);
			const group = raw.state_detail?.group ?? (raw.state ? groups.get(raw.state) : undefined);
			if (group) ref.state = group;
			out.push(ref);
		}
		if (items.length < 50) break;
	}
	return out;
}

const allStatesCache = makeCache<IssueRef[] | null>();

/**
 * Issues in EVERY state (Done/Cancelled included) — what a reconciler needs; the open-only
 * `listPlaneIssues` never sees a closure. Bounded to maxIssuePages() (default 4 ⇒ 200 newest issues)
 * and cached longer than the open list (reconciliation is a slow loop). No blockedBy enrichment.
 */
export async function listPlaneIssuesAllStates(repo: string): Promise<IssueRef[] | null> {
	const ttl = envInt("OMP_SQUAD_PLANE_CACHE_MS", 15000);
	return allStatesCache.get(repo, Math.max(ttl, 60_000), () => fetchIssueRefs(repo, maxIssuePages()), (v) => v !== null);
}

interface PlaneIssueDetail {
	id: string;
	name?: string;
	sequence_id?: number;
	description_stripped?: string;
	description_html?: string;
	state?: string;
	state_detail?: { group?: string };
	priority?: string;
	labels?: string[];
	project_detail?: { identifier?: string };
}

const issueDetailCache = makeCache<TaskDetail | null>();

/** Fetch one Plane issue WITH its body, parsed into a `TaskDetail` (promote-issue Tier-2 sections +
 *  display properties). `null` ⇒ Plane not configured / no project / unreachable. Cached briefly,
 *  like `listPlaneIssues`, keyed by repo+issue. */
export async function fetchIssueDetail(repo: string, issueId: string): Promise<TaskDetail | null> {
	const ttl = envInt("OMP_SQUAD_PLANE_CACHE_MS", 15000);
	return issueDetailCache.get(`${repo}\u0000${issueId}`, ttl, () => fetchIssueDetailUncached(repo, issueId), (v) => v !== null);
}

async function fetchIssueDetailUncached(repo: string, issueId: string): Promise<TaskDetail | null> {
	const ctx = planeContext(repo);
	if (!ctx) return null;
	const { cfg, headers, projectId, base } = ctx;
	if (!projectId) return null;
	const res = await throttledFetch(`${base}/issues/${encodeURIComponent(issueId)}/`, { headers });
	if (!res || !res.ok) return null;
	const raw = (await res.json().catch(() => null)) as PlaneIssueDetail | null;
	if (!raw || !raw.id) return null;
	// state id → group, label ids → names, and blockers: independent reads, run together.
	const [groups, labelNames, blockedBy] = await Promise.all([
		fetchStateGroups(base, headers),
		fetchLabelNames(base, headers),
		fetchBlockedBy(base, headers, raw.id),
	]);
	const ident = raw.project_detail?.identifier;
	const body = raw.description_stripped ?? "";
	return {
		id: raw.id,
		identifier: ident && raw.sequence_id != null ? `${ident}-${raw.sequence_id}` : undefined,
		name: raw.name ?? "(untitled)",
		state: raw.state_detail?.group ?? (raw.state ? groups.get(raw.state) : undefined),
		priority: raw.priority && raw.priority !== "none" ? raw.priority : undefined,
		labels: (raw.labels ?? []).map((id) => labelNames.get(id)).filter((x): x is string => !!x),
		url: `${webBase(cfg)}/${cfg.workspace}/projects/${projectId}/issues/${raw.id}`,
		blockedBy,
		// Parse the structured HTML body for Tier-2 sections; fall back to the stripped text.
		tier2: parseTier2(raw.description_html ?? body),
		body,
	};
}

/** Map a project's label ids → names (for the task properties row). Empty map on any failure. */
async function fetchLabelNames(base: string, headers: Record<string, string>): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	const data = await getJson(`${base}/labels/?per_page=100`, headers);
	const items: unknown[] = Array.isArray(data)
		? data
		: data && typeof data === "object" && "results" in data && Array.isArray((data as { results?: unknown[] }).results)
			? (data as { results: unknown[] }).results
			: [];
	for (const l of items) {
		if (l && typeof l === "object" && "id" in l && "name" in l) {
			const id = (l as { id: unknown }).id;
			const name = (l as { name: unknown }).name;
			if (typeof id === "string" && typeof name === "string") map.set(id, name);
		}
	}
	return map;
}

/** Issue ids blocking `issueId` (Plane `blocked_by`). Retries on 429 (Plane rate limit); `[]` when none,
 *  unreachable, or still rate-limited after retries — the proof gate still catches any premature work. */
async function fetchBlockedBy(base: string, headers: Record<string, string>, issueId: string): Promise<string[]> {
	const res = await throttledFetch(`${base}/issues/${issueId}/relations/`, { headers });
	return res?.ok ? parseBlockedBy(await res.json().catch(() => null)) : [];
}

/** Extract `blocked_by` issue ids from a Plane `/relations/` response. Tolerant of missing / odd shapes. */
export function parseBlockedBy(data: unknown): string[] {
	if (!data || typeof data !== "object") return [];
	const rel = data as { blocked_by?: unknown };
	if (!Array.isArray(rel.blocked_by)) return [];
	return rel.blocked_by.filter((x): x is string => typeof x === "string");
}

/** Map a project's state ids → group (backlog/unstarted/started/completed/cancelled). */
async function fetchStateGroups(base: string, headers: Record<string, string>): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	for (const s of await fetchStates(base, headers)) if (s.id && s.group) map.set(s.id, s.group);
	return map;
}

/** Fetch a project's workflow states — the single source for the /states call. */
async function fetchStates(base: string, headers: Record<string, string>): Promise<PlaneState[]> {
	const data = (await getJson(`${base}/states/?per_page=100`, headers)) as { results?: PlaneState[] } | PlaneState[] | null;
	return Array.isArray(data) ? data : (data?.results ?? []);
}

export function planeConfigured(): boolean {
	return readConfig() !== null;
}

/** Repos wired to a Plane project (the project-map keys) — the auto-dispatch targets. */
export function planeRepos(): string[] {
	const cfg = readConfig();
	return cfg ? Object.keys(cfg.projectMap) : [];
}

interface PlaneState {
	id: string;
	name?: string;
	group?: string;
}

/** Move an issue to the first state in `group` (e.g. "completed"/"started"). Best-effort; true on success. */
async function transitionTo(issue: IssueRef, group: string): Promise<boolean> {
	const ctx = planeContext();
	if (!ctx || !issue.projectId) return false;
	const { cfg, headers } = ctx;
	const base = projectBase(cfg, issue.projectId);
	const target = (await fetchStates(base, headers)).find((s) => s.group === group);
	if (!target) return false;
	const res = await throttledFetch(`${base}/issues/${issue.id}/`, { method: "PATCH", headers, body: JSON.stringify({ state: target.id }) });
	if (res && res.ok) issueListCache.clear(); // a state change alters the open set
	return !!res && res.ok;
}

/** Transition an issue to a completed-group state. Best-effort; true on success. */
export async function closePlaneIssue(issue: IssueRef): Promise<boolean> {
	return transitionTo(issue, "completed");
}

/** Reopen a false-done issue to Todo when present, else the first open group state. Best-effort; true on success. */
export async function reopenPlaneIssue(issue: IssueRef): Promise<boolean> {
	const ctx = planeContext();
	if (!ctx || !issue.projectId) return false;
	const { cfg, headers } = ctx;
	const base = projectBase(cfg, issue.projectId);
	const states = await fetchStates(base, headers);
	const target = states.find((s) => s.name === "Todo") ?? states.find((s) => s.group === "unstarted") ?? states.find((s) => s.group === "backlog");
	if (!target) return false;
	const res = await throttledFetch(`${base}/issues/${issue.id}/`, { method: "PATCH", headers, body: JSON.stringify({ state: target.id }) });
	if (res && res.ok) issueListCache.clear();
	return !!res && res.ok;
}

/** Transition an issue to a started-group state (backlog → started when a spawn picks it up). Best-effort; true on success. */
export async function startPlaneIssue(issue: IssueRef): Promise<boolean> {
	return transitionTo(issue, "started");
}

/** Create an issue in the Plane project mapped to `repo`, returning its ref. Optional `descriptionHtml`
 *  becomes the issue body. `null` ⇒ not configured / no project / failed. */
export async function createPlaneIssue(repo: string, name: string, descriptionHtml?: string): Promise<IssueRef | null> {
	const ctx = planeContext(repo);
	if (!ctx) return null;
	const { cfg, headers, projectId, base } = ctx;
	if (!projectId) return null;
	const body = JSON.stringify(descriptionHtml ? { name, description_html: descriptionHtml } : { name });
	const res = await throttledFetch(`${base}/issues/`, { method: "POST", headers, body });
	if (!res || !res.ok) return null;
	issueListCache.clear(); // a new issue changes the open set
	const raw = (await res.json().catch(() => null)) as PlaneIssue | null;
	if (!raw?.id) return null;
	const prefix = raw.project_detail?.identifier || raw.sequence_id == null ? undefined : await projectPrefix(base, headers);
	return toIssueRef(raw, cfg, projectId, prefix);
}

/** Write one Plane `blocked_by` relation (issue is blocked by blocker). Best-effort; false on failure. */
export async function addPlaneBlockedByRelation(repo: string, issueId: string, blockerId: string): Promise<boolean | null> {
	const ctx = planeContext(repo);
	if (!ctx) return null;
	const { headers, projectId, base } = ctx;
	if (!projectId) return null;
	const body = JSON.stringify({ relation_type: "blocked_by", related_issue: blockerId });
	const res = await throttledFetch(`${base}/issues/${encodeURIComponent(issueId)}/relations/`, { method: "POST", headers, body });
	if (res?.ok) issueListCache.clear();
	return !!res?.ok;
}

/** Add a comment to a Plane issue by UUID or human identifier (e.g. OMPSQ-42). Best-effort; false when Plane is not configured. */
export async function addPlaneIssueComment(repo: string, issue: string, comment: string): Promise<boolean> {
	const ctx = planeContext(repo);
	if (!ctx) return false;
	const { headers, projectId, base } = ctx;
	if (!projectId) return false;
	const issueId = await resolveIssueId(base, headers, issue);
	if (!issueId) return false;
	const body = JSON.stringify({ comment_html: `<p>${escapeHtml(comment).replace(/\n/g, "<br/>")}</p>` });
	const res = await throttledFetch(`${base}/issues/${encodeURIComponent(issueId)}/comments/`, { method: "POST", headers, body });
	return !!res?.ok;
}

async function resolveIssueId(base: string, headers: Record<string, string>, issue: string): Promise<string | undefined> {
	if (/^[0-9a-f-]{20,}$/i.test(issue)) return issue;
	const prefix = await projectPrefix(base, headers);
	const want = issue.toUpperCase();
	for (const raw of await allIssues(base, headers)) {
		const ident = prefix && raw.sequence_id != null ? `${prefix}-${raw.sequence_id}`.toUpperCase() : undefined;
		if (ident === want) return raw.id;
	}
	return undefined;
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Web-app base for deep links — Plane cloud's app host differs from the API host. */
function webBase(cfg: PlaneConfig): string {
	if (process.env.PLANE_APP_URL) return process.env.PLANE_APP_URL.replace(/\/+$/, "");
	if (cfg.baseUrl.includes("api.plane.so")) return "https://app.plane.so";
	return cfg.baseUrl.replace(/\/api(\/v1)?\/?$/, "");
}

interface IssueRaw {
	id: string;
	name?: string;
	sequence_id?: number;
	state?: string;
	state_detail?: { group?: string };
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
	const res = await throttledFetch(url, { headers });
	if (!res || !res.ok) return null;
	return res.json().catch(() => null);
}

async function projectPrefix(base: string, headers: Record<string, string>): Promise<string | undefined> {
	const data = await getJson(`${base}/`, headers);
	if (data && typeof data === "object" && "identifier" in data && typeof data.identifier === "string") return data.identifier;
	return undefined;
}

async function allIssues(base: string, headers: Record<string, string>): Promise<IssueRaw[]> {
	const data = await getJson(`${base}/issues/?per_page=100`, headers);
	if (Array.isArray(data)) return data as IssueRaw[];
	if (data && typeof data === "object" && "results" in data && Array.isArray(data.results)) return data.results as IssueRaw[];
	return [];
}

/** Resolve a feature's Plane issue identifiers → status group + web deep link. `null` ⇒ not configured. */
export async function featureTickets(repo: string, identifiers: string[]): Promise<PlaneTicket[] | null> {
	const ctx = planeContext(repo);
	if (!ctx) return null;
	const { cfg, headers, projectId, base } = ctx;
	if (!projectId || !identifiers.length) return [];
	const [prefix, groups, issues] = await Promise.all([projectPrefix(base, headers), fetchStateGroups(base, headers), allIssues(base, headers)]);
	const want = new Set(identifiers.map((s) => s.toUpperCase()));
	const app = webBase(cfg);
	const tickets: PlaneTicket[] = [];
	for (const raw of issues) {
		const ident = prefix && raw.sequence_id != null ? `${prefix}-${raw.sequence_id}` : undefined;
		if (!ident || !want.has(ident.toUpperCase())) continue;
		const group = raw.state_detail?.group ?? (raw.state ? groups.get(raw.state) : undefined);
		tickets.push({ identifier: ident, name: raw.name ?? "(untitled)", status: group ?? "unknown", url: `${app}/${cfg.workspace}/projects/${projectId}/issues/${raw.id}` });
	}
	tickets.sort((a, b) => identifiers.indexOf(a.identifier) - identifiers.indexOf(b.identifier));
	return tickets;
}

/** Group existing Plane issue identifiers under an existing module. `null` ⇒ not configured / failed. */
export async function addIssuesToFeatureModule(repo: string, moduleId: string, identifiers: string[]): Promise<boolean | null> {
	const ctx = planeContext(repo);
	if (!ctx) return null;
	const { headers, projectId, base } = ctx;
	if (!projectId) return null;
	if (!identifiers.length) return true;
	const [prefix, issues] = await Promise.all([projectPrefix(base, headers), allIssues(base, headers)]);
	const want = new Set(identifiers.map((s) => s.toUpperCase()));
	const ids = issues.filter((i) => prefix && i.sequence_id != null && want.has(`${prefix}-${i.sequence_id}`.toUpperCase())).map((i) => i.id);
	if (!ids.length) return true;
	const res = await throttledFetch(`${base}/modules/${moduleId}/module-issues/`, { method: "POST", headers, body: JSON.stringify({ issues: ids }) });
	return !!res?.ok;
}

/** Group known Plane issue UUIDs under an existing module. `null` ⇒ not configured / failed. */
export async function addIssueIdsToFeatureModule(repo: string, moduleId: string, issueIds: string[]): Promise<boolean | null> {
	const ctx = planeContext(repo);
	if (!ctx) return null;
	const { headers, projectId, base } = ctx;
	if (!projectId) return null;
	const ids = [...new Set(issueIds.filter(Boolean))];
	if (!ids.length) return true;
	const res = await throttledFetch(`${base}/modules/${moduleId}/module-issues/`, { method: "POST", headers, body: JSON.stringify({ issues: ids }) });
	return !!res?.ok;
}

/** Create a Plane module for a feature and group its issues under it. `null` ⇒ not configured / failed. */
export async function ensureFeatureModule(repo: string, name: string, identifiers: string[]): Promise<{ moduleId: string; moduleUrl: string } | null> {
	const ctx = planeContext(repo);
	if (!ctx) return null;
	const { cfg, headers, projectId, base } = ctx;
	if (!projectId) return null;
	const res = await throttledFetch(`${base}/modules/`, { method: "POST", headers, body: JSON.stringify({ name }) });
	if (!res || !res.ok) return null;
	const mod: unknown = await res.json().catch(() => null);
	if (!mod || typeof mod !== "object" || !("id" in mod) || typeof mod.id !== "string") return null;
	const moduleId = mod.id;
	await addIssuesToFeatureModule(repo, moduleId, identifiers);
	return { moduleId, moduleUrl: `${webBase(cfg)}/${cfg.workspace}/projects/${projectId}/modules/${moduleId}` };
}

/** Delete a feature's Plane MODULE grouping (the issues themselves are NOT deleted — they just
 *  lose this module). Best-effort: `null` when Plane is not configured, else the delete result.
 *  Used by the feature hard-delete cascade only when the operator opts in. */
export async function deletePlaneModule(repo: string, moduleId: string): Promise<boolean | null> {
	const ctx = planeContext(repo);
	if (!ctx) return null;
	const { headers, projectId, base } = ctx;
	if (!projectId) return null;
	const res = await throttledFetch(`${base}/modules/${encodeURIComponent(moduleId)}/`, { method: "DELETE", headers });
	return !!res?.ok;
}
