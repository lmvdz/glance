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

/** Choose a process for `task` in `repo`. Pure of side effects beyond reading repo metadata. */
export async function routeIntake(task: string, repo: string): Promise<IntakeDecision> {
	if (FANOUT_SIGNAL.test(task)) return { workflow: FAN_OUT, reason: "several approaches requested → parallel fan-out" };
	if (HIGH_RISK.test(task)) return { workflow: PLAN_IMPLEMENT, reason: "high-risk change → plan + human approval before implementing" };
	const thinking: ThinkingLevel | undefined = HARD.test(task) ? "high" : TRIVIAL.test(task) ? "minimal" : undefined;
	const verify = await detectVerify(repo);
	if (verify) return { verify, thinking, reason: `code change → auto-verify with \`${verify}\`` };
	return { thinking, reason: "no verification command detected → plain agent" };
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
