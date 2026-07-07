/**
 * Resolver — failure-routing policy (#11).
 *
 * Maps a run failure to the next action with a bounded, tiered policy: a `red` gate retries up to
 * a budget then escalates; a `conflict` retries once (the #12 conflict-resolver's single shot) then
 * escalates. Pure + deterministic — it's only the DECISION; the orchestrator reads the route and
 * drives the re-attempt.
 */

import { envInt } from "./config.ts";

/** What kind of failure a run hit: a red gate (tests/verify failed) or a merge conflict on land. */
export type FailureKind = "red" | "conflict";

/** Where a failure routes next: re-run it, ask a human, or park it. */
export type FailureRoute = "retry" | "escalate" | "hold";

/** Signals the router weighs to pick a route. */
export interface FailureContext {
	/** Retries already spent on this unit of work. */
	attempts?: number;
	/** Agent that hit the failure. */
	agentId?: string;
}

/**
 * Tiered, bounded routing policy (#11). Pure + deterministic given `kind`, `ctx`, and env:
 *
 * - `red` (a gate failed): retry while `attempts` are under the repair budget, then escalate.
 *   Budget = `OMP_SQUAD_REPAIR_BUDGET` (default 3) — re-read per call so ops/tests can retune it
 *   without a restart (matches Scheduler.cap()).
 * - `conflict` (a land conflicted): retry exactly once — the automated conflict-resolver (#12)
 *   gets a single shot — then escalate.
 *
 * This is only the DECISION. The orchestrator drives the actual re-attempt by reading the route.
 */
export function routeFailure(kind: FailureKind, ctx?: FailureContext): FailureRoute {
	const attempts = ctx?.attempts ?? 0;
	if (kind === "conflict") return attempts < 1 ? "retry" : "escalate";
	const budget = envInt("OMP_SQUAD_REPAIR_BUDGET", 3);
	return attempts < budget ? "retry" : "escalate";
}
