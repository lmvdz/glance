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
import type { IssueRef, PlaneTicket } from "./types.ts";
import { makeCache, throttledFetch } from "./plane-throttle.ts";

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
		url: `${webBase(cfg)}/${cfg.workspace}/projects/${projectId}/issues/${raw.id}`,
		projectId,
		noAutoDispatch: noAutoDispatchName(name),
	};
}

/** Short-TTL single-flight cache of listPlaneIssues results, keyed by repo — collapses the dispatcher,
 *  observer, reaper, and scout all polling the same repo into ONE API refresh. Cleared on any write. */
const issueListCache = makeCache<IssueRef[] | null>();

/** Open issues for the Plane project mapped to `repo`. `null` ⇒ Plane not configured / unreachable. */
export async function listPlaneIssues(repo: string): Promise<IssueRef[] | null> {
	// Cache successful reads (not null/failure) so repeated polls within the TTL share a single call.
	return issueListCache.get(repo, Number(process.env.OMP_SQUAD_PLANE_CACHE_MS) || 15000, () => listPlaneIssuesUncached(repo), (v) => v !== null);
}

async function listPlaneIssuesUncached(repo: string): Promise<IssueRef[] | null> {
	const ctx = planeContext(repo);
	if (!ctx) return null;
	const { cfg, headers, projectId, base } = ctx;
	if (!projectId) return [];
	const res = await throttledFetch(`${base}/issues/?per_page=50`, { headers });
	if (!res || !res.ok) return null; // unreachable ⇒ null (uncached) so the next poll retries, not a stale []
	const data = (await res.json().catch(() => null)) as { results?: PlaneIssue[] } | PlaneIssue[] | null;
	const items = Array.isArray(data) ? data : (data?.results ?? []);
	// The list endpoint returns `state` as an id, not a group — resolve ids → groups so the
	// completed/cancelled filter actually works (else finished issues get auto-dispatched).
	// The list endpoint omits project_detail, so fetch the project's identifier prefix to build human ids
	// (e.g. OMPSQ-35) — without it dispatched agents fall back to agent-N and collide on names.
	const [groups, prefix] = await Promise.all([fetchStateGroups(base, headers), projectPrefix(base, headers)]);
	const open = items
		.map((raw) => {
			const ref = toIssueRef(raw, cfg, projectId, prefix);
			const group = raw.state_detail?.group ?? (raw.state ? groups.get(raw.state) : undefined);
			if (group) ref.state = group;
			return ref;
		})
		.filter((i) => i.state !== "completed" && i.state !== "cancelled");
	// Populate blocked_by relations so the dispatcher can defer an issue while a blocker is still open.
	// Sequential (not concurrent): Plane rate-limits, and a burst of N /relations/ calls trips 429 —
	// which would silently empty blockedBy and let a blocked issue dispatch. Ceiling: O(open) serial
	// requests per poll; fine for a normal backlog, add bounded concurrency if one ever runs large.
	for (const ref of open) ref.blockedBy = await fetchBlockedBy(base, headers, ref.id);
	return open;
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

/** Transition an issue to a started-group state (backlog → started when a spawn picks it up). Best-effort; true on success. */
export async function startPlaneIssue(issue: IssueRef): Promise<boolean> {
	return transitionTo(issue, "started");
}

/** Create an issue in the Plane project mapped to `repo`, returning its ref. `null` ⇒ not configured / no project / failed. */
export async function createPlaneIssue(repo: string, name: string): Promise<IssueRef | null> {
	const ctx = planeContext(repo);
	if (!ctx) return null;
	const { cfg, headers, projectId, base } = ctx;
	if (!projectId) return null;
	const res = await throttledFetch(`${base}/issues/`, { method: "POST", headers, body: JSON.stringify({ name }) });
	if (!res || !res.ok) return null;
	issueListCache.clear(); // a new issue changes the open set
	const raw = (await res.json().catch(() => null)) as PlaneIssue | null;
	return raw?.id ? toIssueRef(raw, cfg, projectId) : null;
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
	if (identifiers.length) {
		const [prefix, issues] = await Promise.all([projectPrefix(base, headers), allIssues(base, headers)]);
		const want = new Set(identifiers.map((s) => s.toUpperCase()));
		const ids = issues.filter((i) => prefix && i.sequence_id != null && want.has(`${prefix}-${i.sequence_id}`.toUpperCase())).map((i) => i.id);
		if (ids.length) await throttledFetch(`${base}/modules/${moduleId}/module-issues/`, { method: "POST", headers, body: JSON.stringify({ issues: ids }) });
	}
	return { moduleId, moduleUrl: `${webBase(cfg)}/${cfg.workspace}/projects/${projectId}/modules/${moduleId}` };
}
