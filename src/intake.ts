/**
 * Intake router — turn a plain task into a configured run, so a human only ever
 * describes intent (no forms, no flags) and the OS picks the process:
 *   - a verify loop for ordinary code changes (autonomous: implement → verify → fixup),
 *   - plan + approval for high-risk changes (the rare human-in-the-loop gate),
 *   - parallel fan-out when several approaches are wanted,
 *   - else a plain agent.
 * Heuristics today; an LLM router can drop in behind `routeIntake` without changing
 * callers. The decision carries a human-readable `reason`, logged for transparency.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ThinkingLevel } from "./types.ts";

export interface IntakeDecision {
	/** Bundled workflow graph to run as the process. */
	workflow?: string;
	/** Verification command to wrap the task in (implement → verify → fixup). */
	verify?: string;
	/** Reasoning effort for the run. */
	thinking?: ThinkingLevel;
	/** Why this process was chosen — logged so the operator sees the OS's reasoning. */
	reason: string;
}

const PLAN_IMPLEMENT = path.join(import.meta.dir, "..", "workflows", "plan-implement", "workflow.fabro");
const FAN_OUT = path.join(import.meta.dir, "..", "workflows", "fan-out", "workflow.fabro");

const HIGH_RISK = /\b(migrat\w+|deletion|drop\s|rewrit\w+|redesign\w*|re-?architect\w*|mainnet|deploy\w*|production|breaking change|schema change)\b/i;
const FANOUT_SIGNAL = /\b(in parallel|fan ?out|several approaches|multiple approaches|compare approaches|\d+\s+approaches|\d+\s+ways|brainstorm)\b/i;
const HARD = /\b(complex|carefully|tricky|subtle|thorough|deep dive)\b/i;
const TRIVIAL = /\b(typo|rename|comment|bump|whitespace|reformat|format)\b/i;

/** A one-shot LLM classification call (e.g. omp `-p --no-tools --smol`). Returns raw text. */
export type Classify = (prompt: string) => Promise<string>;

/**
 * Choose a process for `task` in `repo`. With a `classify` fn, an LLM picks the process
 * (falling back to heuristics on any failure); without one, pure heuristics. Side effects
 * are limited to reading repo metadata + the (injected) classify call.
 */
export async function routeIntake(task: string, repo: string, classify?: Classify): Promise<IntakeDecision> {
	if (classify) {
		const llm = await llmRoute(task, repo, classify).catch(() => undefined);
		if (llm) return llm;
	}
	return heuristicRoute(task, repo);
}

async function heuristicRoute(task: string, repo: string): Promise<IntakeDecision> {
	if (FANOUT_SIGNAL.test(task)) return { workflow: FAN_OUT, reason: "several approaches requested → parallel fan-out" };
	if (HIGH_RISK.test(task)) return { workflow: PLAN_IMPLEMENT, reason: "high-risk change → plan + human approval before implementing" };
	const thinking: ThinkingLevel | undefined = HARD.test(task) ? "high" : TRIVIAL.test(task) ? "minimal" : undefined;
	const verify = await detectVerify(repo);
	if (verify) return { verify, thinking, reason: `code change → auto-verify with \`${verify}\`` };
	return { thinking, reason: "no verification command detected → plain agent" };
}

const ROUTER_PROMPT = `Route a software task to ONE process. Respond with ONLY a JSON object, no prose:
{"process":"verify|plan|fanout|plain","effort":"minimal|low|high"}
- verify: an ordinary code change (implement, then run tests/typecheck).
- plan: a high-risk or destructive change (migration, deletion, deploy, breaking API) that needs human approval first.
- fanout: explore several competing approaches in parallel.
- plain: no code verification needed (docs, copy, trivial, non-code).
Task: `;

async function llmRoute(task: string, repo: string, classify: Classify): Promise<IntakeDecision | undefined> {
	const parsed = extractDecision(await classify(ROUTER_PROMPT + task));
	if (!parsed) return undefined;
	const effort = parsed.effort === "high" || parsed.effort === "minimal" || parsed.effort === "low" ? parsed.effort : undefined;
	if (parsed.process === "fanout") return { workflow: FAN_OUT, thinking: effort, reason: "LLM router → parallel fan-out" };
	if (parsed.process === "plan") return { workflow: PLAN_IMPLEMENT, thinking: effort, reason: "LLM router → plan + human approval (high-risk)" };
	if (parsed.process === "verify") {
		const verify = await detectVerify(repo);
		return verify ? { verify, thinking: effort, reason: `LLM router → auto-verify with \`${verify}\`` } : { thinking: effort, reason: "LLM router → plain (no verify command)" };
	}
	return { thinking: effort, reason: "LLM router → plain agent" };
}

/** Extract the last balanced JSON object from model output and read its routing fields. */
function extractDecision(text: string): { process?: string; effort?: string } | undefined {
	const start = text.lastIndexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try {
		const obj: unknown = JSON.parse(text.slice(start, end + 1));
		if (!obj || typeof obj !== "object") return undefined;
		const rec = obj as Record<string, unknown>; // guarded: a non-null object literal from the model
		const process = typeof rec.process === "string" ? rec.process : undefined;
		const effort = typeof rec.effort === "string" ? rec.effort : undefined;
		return { process, effort };
	} catch {
		return undefined;
	}
}

/** A `Classify` backed by a one-shot omp call on the fast/smol model (no tools). */
export function ompClassify(bin = "omp"): Classify {
	return async (prompt: string): Promise<string> => {
		const proc = Bun.spawn([bin, "-p", "--no-tools", "--smol", "--hide-thinking", prompt], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env } });
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		return out;
	};
}

/** Infer the repo's verification command from its toolchain manifests. */
export async function detectVerify(repo: string): Promise<string | undefined> {
	const pkg = await readJsonObject(path.join(repo, "package.json"));
	const scriptsRaw = pkg?.scripts;
	if (scriptsRaw && typeof scriptsRaw === "object" && !Array.isArray(scriptsRaw)) {
		const scripts = scriptsRaw as Record<string, unknown>; // guarded above: a non-array object
		const has = (k: string): boolean => typeof scripts[k] === "string";
		const pm = await detectPackageManager(repo);
		const cmds: string[] = [];
		if (has("typecheck")) cmds.push(`${pm} run typecheck`);
		else if (has("check")) cmds.push(`${pm} run check`);
		if (has("test")) cmds.push(`${pm} run test`);
		if (cmds.length) return cmds.join(" && ");
	}
	if (await exists(path.join(repo, "Cargo.toml"))) return "cargo check && cargo test";
	if (await exists(path.join(repo, "go.mod"))) return "go build ./... && go test ./...";
	if (await exists(path.join(repo, "pyproject.toml"))) return "pytest -q";
	return undefined;
}

async function detectPackageManager(repo: string): Promise<string> {
	if ((await exists(path.join(repo, "bun.lock"))) || (await exists(path.join(repo, "bun.lockb")))) return "bun";
	if (await exists(path.join(repo, "pnpm-lock.yaml"))) return "pnpm";
	if (await exists(path.join(repo, "yarn.lock"))) return "yarn";
	return "npm";
}

async function readJsonObject(p: string): Promise<Record<string, unknown> | undefined> {
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(p, "utf8"));
		// Narrow at the boundary, then trust the named typed value (not an inline member cast).
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}
