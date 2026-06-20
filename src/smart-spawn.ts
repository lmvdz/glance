/**
 * Smart spawn — turn one free-text line into a ready-to-run agent.
 *
 * Instead of filling out repo/name/model/approval/thinking, the user just types
 * what they want done. A fast model (omp --smol) reads the task plus the list of
 * candidate repos and returns a spawn plan: which repo to target, a short agent
 * name, and sensible model/approval/thinking. If the model is unreachable or
 * replies with junk, deterministic heuristics fill every field — the spawn never
 * fails just because inference did.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ApprovalMode, CreateAgentOptions, ThinkingLevel } from "./types.ts";

const INFER_TIMEOUT_MS = 20_000;

export interface SpawnPlan extends CreateAgentOptions {
	/** One-line rationale for the chosen repo/name, surfaced in the UI. */
	reason?: string;
}

/** The raw, untrusted fields a model may return. */
export interface RawPlan {
	repo?: string;
	name?: string;
	model?: string;
	approval?: string;
	thinking?: string;
	reason?: string;
}

function isGitRepo(p: string): boolean {
	try {
		return fs.existsSync(path.join(p, ".git"));
	} catch {
		return false;
	}
}

/** Candidate repos the planner may target: cwd, repos squad already tracks, and a shallow scan of common roots. */
export function discoverRepos(cwd: string, tracked: string[]): string[] {
	const out = new Set<string>();
	if (isGitRepo(cwd)) out.add(path.resolve(cwd));
	for (const r of tracked) {
		if (r.length > 0 && isGitRepo(r)) out.add(path.resolve(r));
	}
	const home = process.env.HOME ?? "";
	const rootsEnv = process.env.OMP_SQUAD_REPO_ROOTS ?? [path.dirname(cwd), `${home}/sui`, `${home}/src`, `${home}/code`].join(",");
	for (const root of rootsEnv.split(",")) {
		const dir = root.trim();
		if (dir.length === 0) continue;
		let entries: string[];
		try {
			entries = fs.readdirSync(dir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry);
			if (isGitRepo(full)) out.add(path.resolve(full));
		}
	}
	return [...out];
}

/** A short, filesystem-safe agent name from arbitrary text. */
export function slug(text: string): string {
	const parts = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.split("-")
		.filter((p) => p.length > 0)
		.slice(0, 4);
	return parts.length > 0 ? parts.join("-") : "agent";
}

function asApproval(v: string | undefined): ApprovalMode | undefined {
	return v === "always-ask" || v === "write" || v === "yolo" ? v : undefined;
}

function asThinking(v: string | undefined): ThinkingLevel | undefined {
	return v === "minimal" || v === "low" || v === "medium" || v === "high" || v === "xhigh" ? v : undefined;
}

/** Pick the candidate whose name the task mentions, else the cwd, else the first candidate. */
export function pickRepoHeuristic(prompt: string, candidates: string[], cwd: string): string {
	const low = prompt.toLowerCase();
	let best: string | undefined;
	let bestLen = 0;
	for (const c of candidates) {
		const base = path.basename(c).toLowerCase();
		if (base.length > bestLen && low.includes(base)) {
			best = c;
			bestLen = base.length;
		}
	}
	if (best !== undefined) return best;
	const resolvedCwd = path.resolve(cwd);
	if (candidates.includes(resolvedCwd)) return resolvedCwd;
	return candidates[0] ?? resolvedCwd;
}

/** Extract a single JSON object from model output and coerce its fields to strings. */
export function parsePlanJson(text: string): RawPlan | undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const r = parsed as Record<string, unknown>;
	const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined);
	return { repo: str(r.repo), name: str(r.name), model: str(r.model), approval: str(r.approval), thinking: str(r.thinking), reason: str(r.reason) };
}

const SYSTEM_PROMPT =
	"You convert a developer's free-text task into a JSON spawn plan for a coding agent. " +
	"Reply with ONLY one JSON object, no prose, no code fences, no tools. Keys: " +
	'"repo" (absolute path; MUST be exactly one of the candidate paths — pick the best fit for the task, else the first), ' +
	'"name" (short kebab-case, 2-4 words, describing the task), ' +
	'"model" (optional: "opus" for hard/architectural work, omit otherwise), ' +
	'"approval" ("write" by default; "yolo" only if the task clearly wants no confirmation), ' +
	'"thinking" ("low" default; "high" for complex reasoning; "minimal" for trivial), ' +
	'"reason" (<=12 words explaining the repo+name choice).';

async function infer(prompt: string, candidates: string[]): Promise<RawPlan | undefined> {
	const user = `Candidate repos:\n${candidates.map((c) => `- ${c}`).join("\n")}\n\nTask: ${prompt}\n\nJSON:`;
	try {
		const proc = Bun.spawn(["omp", "-p", "--smol", "--system-prompt", SYSTEM_PROMPT, user], {
			stdout: "pipe",
			stderr: "ignore",
			signal: AbortSignal.timeout(INFER_TIMEOUT_MS),
		});
		const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (code !== 0) return undefined;
		return parsePlanJson(out);
	} catch {
		return undefined;
	}
}

/** Resolve a free-text task into a complete, valid spawn plan. Never throws; always returns a usable plan. */
export async function planSpawn(prompt: string, opts: { cwd: string; candidates: string[] }): Promise<SpawnPlan> {
	const candidates = opts.candidates.length > 0 ? opts.candidates : [path.resolve(opts.cwd)];
	const raw = await infer(prompt, candidates);

	const claimed = raw?.repo === undefined ? undefined : path.resolve(raw.repo);
	const repo = claimed !== undefined && candidates.includes(claimed) ? claimed : pickRepoHeuristic(prompt, candidates, opts.cwd);

	const plan: SpawnPlan = { repo, name: raw?.name ? slug(raw.name) : slug(prompt), task: prompt };
	if (raw?.model !== undefined) plan.model = raw.model;
	const approval = asApproval(raw?.approval);
	if (approval !== undefined) plan.approvalMode = approval;
	const thinking = asThinking(raw?.thinking);
	if (thinking !== undefined) plan.thinking = thinking;
	if (raw?.reason !== undefined) plan.reason = raw.reason;
	return plan;
}
