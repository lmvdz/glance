/**
 * Agent profiles + runtime model options — pure parsing/rendering extracted from the
 * squad-manager god-file (it re-exports these, so import paths are unchanged).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentProfile, McpServerSpec, ThinkingLevel } from "./types.ts";
import { getHarness } from "./harness-registry.ts";

export interface RuntimeModelOption {
	label: string;
	value: string;
}

export function modelOptionsFromRuntime(models: unknown): RuntimeModelOption[] {
	if (!Array.isArray(models)) return [];
	const seen = new Set<string>();
	return models.flatMap((item): RuntimeModelOption[] => {
		if (!item || typeof item !== "object") return [];
		const rec = item as Record<string, unknown>;
		const id = typeof rec.id === "string" ? rec.id.trim() : "";
		if (!id) return [];
		const provider = typeof rec.provider === "string" ? rec.provider.trim() : "";
		const value = provider ? `${provider}/${id}` : id;
		if (seen.has(value)) return [];
		seen.add(value);
		return [{ label: value, value }];
	});
}

export function profileOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): AgentProfile[] {
	const configured = parseProfiles(env.OMP_SQUAD_PROFILES, "env");
	const fallback: AgentProfile = {
		id: "default",
		name: "Default OMP operator",
		description: "Live omp --mode rpc session with the daemon's default model and write approvals.",
		runtime: "omp-operator",
		approvalMode: "write",
		default: true,
	};
	return configured.length ? configured : [fallback];
}

const THINKING_LEVELS = new Set<ThinkingLevel>(["minimal", "low", "medium", "high", "xhigh"]);

const MCP_TYPES = new Set<McpServerSpec["type"]>(["stdio", "sse", "http"]);

/** A string→string record, tolerant of a malformed shape (missing ⇒ undefined, non-string values dropped). */
function parseStringRecord(v: unknown): Record<string, string> | undefined {
	if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
	const out: Record<string, string> = {};
	for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
		if (typeof val === "string") out[k] = val;
	}
	return Object.keys(out).length ? out : undefined;
}

/** Parse `AgentProfile.mcp` — tolerant of malformed entries (dropped silently, like `capabilities`'
 *  string filter); an entry missing `name` or a valid `type` is not a server at all. Does NOT enforce
 *  the repo-source RCE rule — that's the caller's job (mirrors how `bin`/`harness` are parsed first,
 *  then sanitized by `source` below). */
function parseMcpServers(raw: unknown): McpServerSpec[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out = raw.flatMap((item): McpServerSpec[] => {
		if (!item || typeof item !== "object") return [];
		const r = item as Record<string, unknown>;
		const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : "";
		const type = typeof r.type === "string" && MCP_TYPES.has(r.type as McpServerSpec["type"]) ? (r.type as McpServerSpec["type"]) : undefined;
		if (!name || !type) return [];
		return [{
			name,
			type,
			command: typeof r.command === "string" ? r.command : undefined,
			args: Array.isArray(r.args) ? r.args.filter((v): v is string => typeof v === "string") : undefined,
			env: parseStringRecord(r.env),
			url: typeof r.url === "string" ? r.url : undefined,
			headers: parseStringRecord(r.headers),
			enabled: typeof r.enabled === "boolean" ? r.enabled : undefined,
		}];
	});
	return out.length ? out : undefined;
}

/** `source` distinguishes operator-set env profiles (fully trusted) from `.glance/profiles.json`
 *  (repo-committed — anyone who can open a PR can edit it). A "repo" profile is sanitized: `bin`
 *  is dropped outright (it flows unchecked to `Bun.spawn` — RCE if a repo could set it), `harness`
 *  is rejected unless it names a *verified* registered harness (an unverified one is already hidden
 *  from every other create surface; letting a repo file pick one anyway would be a backdoor around
 *  that gate), and `mcp` is dropped ENTIRELY (a `stdio` server is `{command,args}` — the SAME RCE
 *  class as `bin` — so there is no partial-trust merge, unlike env↔repo profile merging by id
 *  elsewhere: a repo profile simply may not define MCP servers). Each rejection logs a console.warn
 *  naming the field and profile id — loud, not a silent drop. */
function parseProfiles(raw: string | undefined, source: "env" | "repo" = "env"): AgentProfile[] {
	if (!raw?.trim()) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((item): AgentProfile[] => {
			if (!item || typeof item !== "object") return [];
			const r = item as Record<string, unknown>;
			const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : "";
			const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : id;
			const runtime = r.runtime === "flue-service" || r.runtime === "workflow" ? r.runtime : "omp-operator";
			const thinking = typeof r.thinking === "string" && THINKING_LEVELS.has(r.thinking as ThinkingLevel) ? (r.thinking as ThinkingLevel) : undefined;
			if (!id) return [];
			let bin = typeof r.bin === "string" ? r.bin : undefined;
			let harness = typeof r.harness === "string" ? r.harness : undefined;
			let mcp = parseMcpServers(r.mcp);
			if (source === "repo") {
				if (bin !== undefined) {
					console.warn(`[agent-profiles] repo profile "${id}" sets "bin" — dropped (a repo-committed profile cannot set a binary override, it would be arbitrary code execution)`);
					bin = undefined;
				}
				if (harness !== undefined && !getHarness(harness)?.verified) {
					console.warn(`[agent-profiles] repo profile "${id}" sets harness "${harness}" — rejected (repo-committed profiles may only select a verified registered harness)`);
					harness = undefined;
				}
				if (mcp !== undefined) {
					console.warn(`[agent-profiles] repo profile "${id}" sets "mcp" — dropped (a repo-committed profile cannot define inline MCP servers: a stdio server is {command,args}, the same arbitrary-code-execution class as "bin")`);
					mcp = undefined;
				}
			}
			return [{
				id,
				name,
				description: typeof r.description === "string" ? r.description : undefined,
				runtime,
				harness,
				bin,
				mcp,
				model: typeof r.model === "string" ? r.model : undefined,
				thinking,
				approvalMode: r.approvalMode === "always-ask" || r.approvalMode === "write" || r.approvalMode === "yolo" ? r.approvalMode : undefined,
				capabilities: Array.isArray(r.capabilities) ? r.capabilities.filter((v): v is string => typeof v === "string") : undefined,
				memory: typeof r.memory === "string" ? r.memory : undefined,
				default: r.default === true,
			}];
		});
	} catch {
		return [];
	}
}

/** Shareable project profile catalog, `<repoRoot>/.glance/profiles.json` — same array shape as
 *  `OMP_SQUAD_PROFILES` but sanitized as repo-sourced input (see `parseProfiles`). Missing file (the
 *  common case) or unreadable/corrupt JSON → `[]`, never throws. */
export function loadRepoProfiles(repoRoot: string): AgentProfile[] {
	try {
		const file = path.join(repoRoot, ".glance", "profiles.json");
		if (!fs.existsSync(file)) return [];
		return parseProfiles(fs.readFileSync(file, "utf8"), "repo");
	} catch {
		return [];
	}
}

/** Render a capability profile's tool-grant allow-list as a hard system-prompt constraint. This is the part
 *  of capability tool-scoping (#3) that reaches the omp child (via --append-system-prompt); host tool calls
 *  outside the list are additionally hard-denied at the onHostTool seam. Returns undefined for an empty grant. */
export function toolGrantsPrompt(grants: string[] | undefined): string | undefined {
	if (!grants || grants.length === 0) return undefined;
	return [
		"--- Capability tool grant (hard constraint) ---",
		`You are scoped to ONLY these tools: ${grants.join(", ")}.`,
		"Do not use, request, or attempt any tool outside this list. Tool calls outside the grant are denied by the host.",
	].join("\n");
}
