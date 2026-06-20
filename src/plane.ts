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

	const url = `${cfg.baseUrl}/api/v1/workspaces/${cfg.workspace}/projects/${projectId}/issues/?per_page=50`;
	const res = await fetch(url, { headers: { "x-api-key": cfg.apiKey, "content-type": "application/json" } }).catch(() => null);
	if (!res || !res.ok) return [];
	const data = (await res.json().catch(() => null)) as { results?: PlaneIssue[] } | PlaneIssue[] | null;
	const items = Array.isArray(data) ? data : (data?.results ?? []);
	return items
		.map((raw) => toIssueRef(raw, cfg, projectId))
		.filter((i) => i.state !== "completed" && i.state !== "cancelled");
}

export function planeConfigured(): boolean {
	return readConfig() !== null;
}
