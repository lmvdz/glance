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
import type { IssueRef } from "./types.ts";

interface PlaneConfig {
	apiKey: string;
	workspace: string;
	baseUrl: string;
	projectMap: Record<string, string>;
	fallbackProjectId?: string;
}

function readConfig(): PlaneConfig | null {
	const apiKey = process.env.PLANE_API_KEY;
	const workspace = process.env.PLANE_WORKSPACE;
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
		baseUrl: process.env.PLANE_BASE_URL ?? "https://api.plane.so",
		projectMap,
		fallbackProjectId: process.env.PLANE_PROJECT_ID,
	};
}

function projectIdFor(repo: string, cfg: PlaneConfig): string | undefined {
	return cfg.projectMap[repo] ?? cfg.projectMap[path.basename(repo)] ?? cfg.fallbackProjectId;
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

function toIssueRef(raw: PlaneIssue, cfg: PlaneConfig, projectId: string): IssueRef {
	const ident = raw.project_detail?.identifier;
	return {
		id: raw.id,
		identifier: ident && raw.sequence_id != null ? `${ident}-${raw.sequence_id}` : undefined,
		name: raw.name ?? "(untitled)",
		state: raw.state_detail?.group ?? raw.state,
		url: `${cfg.baseUrl.replace(/\/api.*/, "")}/${cfg.workspace}/projects/${projectId}/issues/${raw.id}`,
		projectId,
	};
}

/** Open issues for the Plane project mapped to `repo`. `null` ⇒ Plane not configured. */
export async function listPlaneIssues(repo: string): Promise<IssueRef[] | null> {
	const cfg = readConfig();
	if (!cfg) return null;
	const projectId = projectIdFor(repo, cfg);
	if (!projectId) return [];

	const headers = { "x-api-key": cfg.apiKey, "content-type": "application/json" };
	const base = `${cfg.baseUrl}/api/v1/workspaces/${cfg.workspace}/projects/${projectId}`;
	const res = await fetch(`${base}/issues/?per_page=50`, { headers }).catch(() => null);
	if (!res || !res.ok) return [];
	const data = (await res.json().catch(() => null)) as { results?: PlaneIssue[] } | PlaneIssue[] | null;
	const items = Array.isArray(data) ? data : (data?.results ?? []);
	// The list endpoint returns `state` as an id, not a group — resolve ids → groups so the
	// completed/cancelled filter actually works (else finished issues get auto-dispatched).
	const groups = await fetchStateGroups(base, headers);
	return items
		.map((raw) => {
			const ref = toIssueRef(raw, cfg, projectId);
			const group = raw.state_detail?.group ?? (raw.state ? groups.get(raw.state) : undefined);
			if (group) ref.state = group;
			return ref;
		})
		.filter((i) => i.state !== "completed" && i.state !== "cancelled");
}

/** Map a project's state ids → group (backlog/unstarted/started/completed/cancelled). */
async function fetchStateGroups(projectBase: string, headers: Record<string, string>): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	const res = await fetch(`${projectBase}/states/?per_page=100`, { headers }).catch(() => null);
	if (!res || !res.ok) return map;
	const data = (await res.json().catch(() => null)) as { results?: PlaneState[] } | PlaneState[] | null;
	const states = Array.isArray(data) ? data : (data?.results ?? []);
	for (const s of states) if (s.id && s.group) map.set(s.id, s.group);
	return map;
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

/** Transition an issue to a completed-group state. Best-effort; true on success. */
export async function closePlaneIssue(issue: IssueRef): Promise<boolean> {
	const cfg = readConfig();
	if (!cfg || !issue.projectId) return false;
	const base = `${cfg.baseUrl}/api/v1/workspaces/${cfg.workspace}/projects/${issue.projectId}`;
	const headers = { "x-api-key": cfg.apiKey, "content-type": "application/json" };
	const statesRes = await fetch(`${base}/states/?per_page=100`, { headers }).catch(() => null);
	if (!statesRes || !statesRes.ok) return false;
	const sdata = (await statesRes.json().catch(() => null)) as { results?: PlaneState[] } | PlaneState[] | null;
	const states = Array.isArray(sdata) ? sdata : (sdata?.results ?? []);
	const done = states.find((s) => s.group === "completed");
	if (!done) return false;
	const res = await fetch(`${base}/issues/${issue.id}/`, { method: "PATCH", headers, body: JSON.stringify({ state: done.id }) }).catch(() => null);
	return !!res && res.ok;
}
