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
import { extractJsonObject, ompOneShot } from "./omp-call.ts";

export interface IntakeDecision {
	/** Bundled workflow graph to run as the process. */
	workflow?: string;
	/** Verification command to wrap the task in (implement → verify → fixup). */
	verify?: string;
	/** Selects the TDD variant of the verify loop — write the acceptance test first. Only ever
	 *  emitted alongside `verify`; "observe" is Observer-initiated, never router-initiated. */
	mode?: "tdd";
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
const TDD_SIGNAL = /\b(add|implement|feature|support|endpoint|api|handler|route|behaviou?r|new )\b/i;

/**
 * Whether a verify-routed task should run the TDD variant (write the acceptance test first).
 * `OMP_SQUAD_TDD=0` disables globally; `=force` emits tdd on every verify-routed task; unset
 * falls back to the behavior-adding signal heuristic (never on a TRIVIAL task).
 */
function tddMode(task: string): "tdd" | undefined {
	const env = process.env.OMP_SQUAD_TDD;
	if (env === "0") return undefined;
	if (env === "force") return "tdd";
	return !TRIVIAL.test(task) && TDD_SIGNAL.test(task) ? "tdd" : undefined;
}

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
	if (verify) {
		const mode = tddMode(task);
		return { verify, thinking, mode, reason: `code change → auto-verify with \`${verify}\`${mode === "tdd" ? " (TDD: test first)" : ""}` };
	}
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
		if (!verify) return { thinking: effort, reason: "LLM router → plain (no verify command)" };
		const mode = tddMode(task);
		return { verify, thinking: effort, mode, reason: `LLM router → auto-verify with \`${verify}\`${mode === "tdd" ? " (TDD: test first)" : ""}` };
	}
	return { thinking: effort, reason: "LLM router → plain agent" };
}

/** Extract the last balanced JSON object from model output and read its routing fields. */
function extractDecision(text: string): { process?: string; effort?: string } | undefined {
	const rec = extractJsonObject(text);
	if (!rec) return undefined;
	const process = typeof rec.process === "string" ? rec.process : undefined;
	const effort = typeof rec.effort === "string" ? rec.effort : undefined;
	return { process, effort };
}

/**
 * A `Classify` backed by a one-shot omp call on the fast/smol model (no tools). `timeoutMs`
 * defaults to `ompOneShot`'s own 1s budget (fine for routeIntake's/Scout's short classification
 * prompts) — a substantive generation call (e.g. the resident planner's decompose, which asks
 * for a full multi-concern JSON plan with prose) needs a much larger budget or it silently times
 * out on every real call; pass one explicitly for those.
 */
export function ompClassify(bin = "omp", timeoutMs?: number): Classify {
	return async (prompt: string): Promise<string> => (await ompOneShot(["-p", "--no-tools", "--smol", "--hide-thinking", prompt], { bin, timeoutMs })).out;
}

/** One named, cheap-first verification stage. The stage boundary is captured HERE, at the structured
 *  source — never by re-tokenizing a joined `a && b` string downstream (which would silently drop
 *  `cd`/`export`/quoted-`&&` semantics and could turn a red gate green). */
export interface GateStage {
	name: string;
	command: string;
}

/** Infer the repo's verification as an ORDERED, cheap-first stage list (typecheck → test). Empty when
 *  no toolchain is recognized. `detectVerify` is exactly the `&&`-join of this — one source of truth. */
export async function detectVerifyStages(repo: string): Promise<GateStage[]> {
	const pkg = await readJsonObject(path.join(repo, "package.json"));
	const scriptsRaw = pkg?.scripts;
	if (scriptsRaw && typeof scriptsRaw === "object" && !Array.isArray(scriptsRaw)) {
		const scripts = scriptsRaw as Record<string, unknown>; // guarded above: a non-array object
		const has = (k: string): boolean => typeof scripts[k] === "string";
		const pm = await detectPackageManager(repo);
		const stages: GateStage[] = [];
		if (has("typecheck")) stages.push({ name: "typecheck", command: `${pm} run typecheck` });
		else if (has("check")) stages.push({ name: "check", command: `${pm} run check` });
		if (has("test")) stages.push({ name: "test", command: `${pm} run test` });
		if (stages.length) return stages;
	}
	if (await exists(path.join(repo, "Cargo.toml"))) return [{ name: "typecheck", command: "cargo check" }, { name: "test", command: "cargo test" }];
	if (await exists(path.join(repo, "go.mod"))) return [{ name: "build", command: "go build ./..." }, { name: "test", command: "go test ./..." }];
	if (await exists(path.join(repo, "pyproject.toml"))) return [{ name: "test", command: "pytest -q" }];
	return [];
}

/** Infer the repo's verification command from its toolchain manifests — the `&&`-join of
 *  {@link detectVerifyStages}. Undefined when no toolchain is recognized. */
export async function detectVerify(repo: string): Promise<string | undefined> {
	const stages = await detectVerifyStages(repo);
	return stages.length ? stages.map((s) => s.command).join(" && ") : undefined;
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
