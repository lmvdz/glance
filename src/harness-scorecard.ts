/**
 * Harness scorecard — the deferred advisory shadow from
 * plans/research-learn-harness-engineering/03-harness-scorecard-shadow.md, now buildable because
 * concern 01 (authored-spec injection, `digest.ts#authoredSpecBlock`) shipped its highest-value red
 * signal ("instructions" = title-only + empty primer).
 *
 * Statically scores a unit's harness bundle across the five subsystems the learn-harness-engineering
 * curriculum names — instructions, tools, environment, state, feedback (BRIEF.md concept 21:
 * "completeness is auditable but effectiveness is not") — so a context-poor unit is visible at
 * ADMISSION (before it spends a run) instead of after a wasted one.
 *
 * ADVISORY ONLY, STRUCTURALLY: this module exports one pure function over already-decided inputs
 * (booleans the caller derives from its own opts/state) and returns a plain data record. It cannot
 * block, delay, retry, or mutate a spawn because it has nothing to call — no manager, no scheduler,
 * no host-tool seam, no LLM. Same contract as `drift-lens.ts`'s MONITOR half of Sentinel v0 (measures,
 * never rules, never acts), enforced the same way: by what this file does NOT import, not by
 * convention. Zero LLM calls, zero I/O — the DESIGN.md verdict was that static scoring from the spawn
 * options / harness descriptor / workflow presence is sufficient; no budget is needed because there is
 * nothing to budget.
 *
 * The original design sketched splitting the scoring into two hook points (instructions/tools before
 * the worktree cut, environment/state after) specifically to avoid scoring environment/state before
 * they exist. This implementation scores all five from a SINGLE hook placed AFTER
 * `SquadManager#createWithId` has cut the worktree, resolved the harness, and run `routeIntake` — so
 * every dimension has real data at score time and the two-hook split is unnecessary.
 */

import { envBool } from "./config.ts";

/** The five subsystems (BRIEF.md concept 2 / lecture 2: "what a harness is"). */
export type HarnessDimension = "instructions" | "tools" | "environment" | "state" | "feedback";

const DIMENSION_ORDER: readonly HarnessDimension[] = ["instructions", "tools", "environment", "state", "feedback"];

/** Computed, never persisted (no PersistedAgent field) — a fresh score reflects the CURRENT spawn's
 *  inputs; recomputing on the next spawn is strictly correct, so there is nothing to keep durable. */
export interface HarnessScorecard {
	/** Count of green dimensions, 0-5. */
	score: number;
	dimensions: Record<HarnessDimension, boolean>;
	/** One human-readable reason per RED (false) dimension, in `DIMENSION_ORDER`. Empty when score is 5. */
	redFlags: string[];
	at: number;
}

/** Raw signals a caller derives from its own already-resolved spawn context. Every field is a
 *  plain boolean the caller computes from data it already has in hand (opts/profile/harness/worktree)
 *  — this module never re-derives them, so it never needs to see the raw opts/profile/harness types
 *  and stays import-free of the rest of the fleet machinery. */
export interface HarnessScorecardInput {
	/** Real task/spec text reaches the agent beyond a bare auto-generated issue title — e.g. an
	 *  authored Tier-2 spec body, a cold-start context primer, or (for a non-issue ad-hoc dispatch,
	 *  where the whole task string IS the instructions) a non-empty task. */
	hasInstructions: boolean;
	/** A scoped tool grant (profile capability allow-list) OR an explicit requires/produces contract.
	 *  False means the unit runs with full, unscoped tool access — the red case. */
	toolsScoped: boolean;
	/** A real, isolated git worktree was cut for this unit (not running in-place on the shared tree). */
	isolatedEnvironment: boolean;
	/** A durable continuity anchor exists — a feature membership, a tracked work item, or a resumable
	 *  workflow checkpoint — so a crash/restart doesn't strand this unit's context with nothing to
	 *  reattach to. */
	continuityAnchor: boolean;
	/** A real feedback loop drives completion (a verify command or a workflow graph), not a bare
	 *  fire-and-forget prompt with nothing judging "done". */
	hasFeedbackGate: boolean;
	/** Clock seam (defaults to Date.now), mirroring drift-lens.ts's HypothesisContext. */
	now?: () => number;
}

const RED_FLAG_TEXT: Record<HarnessDimension, string> = {
	instructions: "no real task/spec text reaches the agent — title-only dispatch (context-poor)",
	tools: "no tool grant or scope contract — agent runs with full, unscoped tool access",
	environment: "no isolated worktree — running in place on the shared tree",
	state: "no continuity anchor (featureId/issue/workflowState) — a crash strands this unit's context",
	feedback: "no real feedback gate — dispatched with neither a verify command nor a workflow graph",
};

/**
 * Pure — no I/O, no LLM call, never throws. The ONLY function this module exports that produces a
 * `HarnessScorecard`; every caller must treat the result as advisory (stamp it for display, log it,
 * or surface it as a finding) and MUST NOT feed it back into any decision that gates, delays, or
 * retries the spawn it describes.
 */
export function scoreHarness(input: HarnessScorecardInput): HarnessScorecard {
	const dimensions: Record<HarnessDimension, boolean> = {
		instructions: input.hasInstructions,
		tools: input.toolsScoped,
		environment: input.isolatedEnvironment,
		state: input.continuityAnchor,
		feedback: input.hasFeedbackGate,
	};
	const redFlags = DIMENSION_ORDER.filter((d) => !dimensions[d]).map((d) => RED_FLAG_TEXT[d]);
	const score = DIMENSION_ORDER.reduce((n, d) => n + (dimensions[d] ? 1 : 0), 0);
	const now = input.now ?? Date.now;
	return { score, dimensions, redFlags, at: now() };
}

/** Default ON — this is advisory-only and free (no LLM call, no extra I/O), so unlike a shadow that
 *  spends budget, there is no cost-based reason to default it off. Set OMP_SQUAD_HARNESS_SCORECARD=0
 *  to silence it entirely if it turns out to be noisy for a given fleet. */
export function harnessScorecardEnabled(): boolean {
	return envBool("OMP_SQUAD_HARNESS_SCORECARD", true);
}

/**
 * Format a one-line diagnostic for a scorecard, or `undefined` when there is nothing to say (no
 * scorecard, or a clean 5/5). Callers (e.g. `dispatch.ts`'s tick loop) can call this unconditionally
 * without their own threshold branching — it never returns a line for a fully green unit.
 */
export function harnessScorecardLogLine(scorecard: HarnessScorecard | undefined): string | undefined {
	if (!scorecard || scorecard.redFlags.length === 0) return undefined;
	return `harness scorecard ${scorecard.score}/5 — ${scorecard.redFlags.join("; ")}`;
}
