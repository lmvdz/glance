/**
 * Agent profiles + runtime model options — pure parsing/rendering extracted from the
 * squad-manager god-file (it re-exports these, so import paths are unchanged).
 */

import type { AgentProfile } from "./types.ts";

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
	const configured = parseProfiles(env.OMP_SQUAD_PROFILES);
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

function parseProfiles(raw: string | undefined): AgentProfile[] {
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
			if (!id) return [];
			return [{
				id,
				name,
				description: typeof r.description === "string" ? r.description : undefined,
				runtime,
				model: typeof r.model === "string" ? r.model : undefined,
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
