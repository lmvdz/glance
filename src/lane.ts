/**
 * Lane taxonomy (adw-factory-borrows concern 01) — a closed `WorkLane` union, classified at intake
 * and carried on the unit (threaded on in concern 02), so model routing, cost gating, and racing key
 * on ONE legible parameter instead of each seam re-deriving intent from raw task text.
 *
 * 3 lanes, not 5 (plans/adw-factory-borrows/DESIGN.md): `docs` and `chore` collapse to the SAME
 * policy row, and "investigation" already exists as ask-mode observer units that deliberately never
 * land — a 4th/5th lane would only fragment thin policy cells the matrix has no distinct row for.
 *
 * Policy is HARD CONSTANTS below, not env-JSON (red-team S3, DESIGN.md): the repo already has
 * `policy.json` + agent profiles + ~179 `OMP_SQUAD_*` vars, and fail-soft env-JSON decode is the
 * wrong posture for a security-adjacent policy table. Every non-shadow row is a later concern's
 * named, evidence-gated flip (concern 08's lane-keyed aggregate, concern 09's enforcement) — never a
 * silent default change here.
 *
 * Shipped shadow-first: `classifyLane` only classifies. Nothing in this module enforces anything —
 * callers decide whether to act on `LANE_POLICY`, and today (concern 01) nothing does.
 */

import type { Classify } from "./intake.ts";
import { extractJsonObject } from "./omp-call.ts";

export type WorkLane = "hotfix" | "feature" | "chore";

/** Where a resolved lane came from — the privilege clamp keys on this (only "operator" may move a
 *  privilege axis), so it is persisted alongside the lane: a restart must not upgrade a classifier
 *  lane into an operator one. */
export type WorkLaneSource = "operator" | "label" | "classifier" | "default";

/** Every `WorkLane` value, for exhaustive iteration (tests, dashboards) without re-deriving the list
 *  from `LANE_POLICY`'s keys. */
export const WORK_LANES: readonly WorkLane[] = ["hotfix", "feature", "chore"];

/** Per-lane policy row. Fields are parameters other seams READ, not permissions this module grants —
 *  `classifyLane`'s caller decides whether a fresh policy row may even take effect (see the clamp rule
 *  in concern 02: label/classifier-sourced lanes may only move these axes in shadow or stricter). */
export interface LanePolicy {
	/** Apply model-route's decision (vs. shadow-log it only) for this lane. */
	modelRouteApply: boolean;
	/** Override model-route's `MIN_EDGE` floor (src/smart-spawn.ts) for this lane; `undefined` ⇒ the
	 *  shared default floor. */
	modelRouteMinEdge?: number;
	/** Hard per-run cost ceiling in USD for concern 08's lane-keyed aggregate; `undefined` ⇒ no
	 *  lane-specific ceiling (falls back to the operator's global `OMP_SQUAD_COST_MAX_PER_CHANGE`). */
	costCeilingUsd?: number;
	/** What the cost gate does when this lane is judged over ceiling. */
	costAction: "shadow" | "ask" | "deny";
	/** Whether catastrophe-terminal racing (concern 07) is enabled for this lane. */
	race: 0 | 1;
}

/** Hard per-lane policy constants. `Record<WorkLane, LanePolicy>` makes this exhaustive BY
 *  CONSTRUCTION — the compiler refuses to build if a lane is ever added to `WorkLane` without a row
 *  here (satisfies the concern's "clamp table exhaustiveness" verification). */
export const LANE_POLICY: Record<WorkLane, LanePolicy> = {
	hotfix: {
		modelRouteApply: false, // flip in a later concern once shadow evidence clears the review checkpoint
		modelRouteMinEdge: 0.08, // lower bar than the shared MIN_EDGE (0.15) — an outage justifies acting on a smaller measured edge
		costAction: "shadow",
		race: 1, // an outage fix is exactly where a fresh-context alternate-strategy sibling (concern 07) earns its keep
	},
	feature: {
		modelRouteApply: false, // all-shadow: the default lane, no privilege axis moves without an operator-sourced override
		costAction: "shadow",
		race: 0,
	},
	chore: {
		modelRouteApply: false,
		costCeilingUsd: 2, // low by construction: bumps/renames/typos/reformats should never cost real money
		costAction: "deny", // adw-factory-borrows concern 09: chore lane first (DESIGN.md's rollout) — the
		// only lane whose over-ceiling verdict actually refuses the spawn in v1, now that concern 08's
		// lane-keyed aggregate exists to judge it fairly. hotfix/feature deliberately stay "shadow"/no-op:
		// spending more on a hotfix is sometimes correct, which is where this diverges from the source
		// framework's static prescription (DESIGN.md).
		race: 0,
	},
};

/** Heuristic signals mirroring `src/intake.ts`'s `TRIVIAL`/`HIGH_RISK` regex convention. Order matters:
 *  hotfix is checked before chore so "revert the dependency bump" (both signals) reads as the more
 *  urgent lane. */
const HOTFIX = /\b(revert|hotfix|outage|prod(uction)?\s+(bug|break)|regression|broken main|urgent)\b/i;
const CHORE = /\b(bump|rename|typo|reformat|comment|dep(endency)?\s+update|chore)\b/i;

export interface LaneDecision {
	lane: WorkLane;
	source: "heuristic" | "llm" | "default";
	reason: string;
}

/** Pure heuristic classification — no I/O, usable synchronously wherever a `classify` fn isn't
 *  available or hasn't resolved yet. */
function heuristicLane(task: string): LaneDecision {
	if (HOTFIX.test(task)) return { lane: "hotfix", source: "heuristic", reason: "hotfix signal in task text" };
	if (CHORE.test(task)) return { lane: "chore", source: "heuristic", reason: "chore signal in task text" };
	return { lane: "feature", source: "default", reason: "no lane signal in task text → feature default" };
}

const LANE_PROMPT = `Classify a software task into ONE work lane. Respond with ONLY a JSON object, no prose:
{"lane":"hotfix|feature|chore"}
- hotfix: an urgent production fix (revert, outage, regression, broken main).
- chore: mechanical, no-risk maintenance (rename, typo, dependency bump, formatting).
- feature: anything else (new capability, ordinary bug fix, refactor).
Task: `;

/** Read a `lane` field already present in a parsed router response, e.g. the SAME JSON object
 *  `src/intake.ts`'s `llmRoute` extracts from its one router call — so a caller that already has a
 *  routed decision never pays for a second LLM round-trip just to get the lane. */
export function laneFromRouted(rec: { lane?: unknown } | undefined): WorkLane | undefined {
	const lane = rec?.lane;
	return lane === "hotfix" || lane === "feature" || lane === "chore" ? lane : undefined;
}

async function llmClassifyLane(task: string, classify: Classify): Promise<LaneDecision | undefined> {
	const rec = extractJsonObject(await classify(LANE_PROMPT + task));
	const lane = laneFromRouted(rec);
	return lane ? { lane, source: "llm", reason: `LLM classifier → ${lane}` } : undefined;
}

/**
 * Classify `task` into a `WorkLane`. With a `classify` fn, an LLM call decides (falling back to
 * heuristics on any failure or unparseable output); without one, pure heuristics. `repo` is accepted
 * for signature parity with `routeIntake` (a future per-repo policy read may want it) but unused
 * today — classification is task-text-only.
 */
export async function classifyLane(task: string, repo: string, classify?: Classify): Promise<LaneDecision> {
	void repo;
	if (classify) {
		const llm = await llmClassifyLane(task, classify).catch(() => undefined);
		if (llm) return llm;
	}
	return heuristicLane(task);
}

