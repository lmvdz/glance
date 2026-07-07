/**
 * model-route — the control loop's ACTION arm (model-routing-control-loop concern 06).
 *
 * Turns C05's observational task-class × model matrix (`omp-graph/task-class-matrix.ts`) into an
 * up-front DISPATCH decision: for a given taskClass, if the cheap/default model's merge-rate is
 * materially — and reliably — below a frontier candidate's, escalate the STARTING model; otherwise
 * stay cheap. Pure (taskClass + matrix in, decision out) so it is unit-testable without a daemon —
 * the caller (`SquadManager.createWithId`) supplies the matrix built from `readTaskOutcomes` +
 * `landingRosterRouting()`.
 *
 * Deliberately conservative, mirroring `smart-spawn.ts`'s `shiftedModel`:
 *   - an `insufficientData` cell on EITHER side of the comparison (cheap or frontier) is not
 *     evidence — it falls through to "keep default", never a shift (thin cells never trigger one);
 *   - the frontier only wins by a MATERIAL edge (`MIN_EDGE`, the same floor `shiftedModel` uses),
 *     never a coin-flip-sized difference;
 *   - this is boost-only — it never demotes below the cheap default, and it never explores/regenerates
 *     policy (that needs epsilon-random exploration, deferred — see DESIGN.md's D1). Grading the
 *     router by cells it populated itself is circular until D1 lands; staying boost-only and
 *     sample-gated keeps that circularity from compounding into a policy that entrenches itself.
 */

import type { TaskClassMatrixDoc } from "./omp-graph/task-class-matrix.ts";
import { MIN_EDGE } from "./smart-spawn.ts";

/** The two `modelFamily` buckets (see `omp-graph/attribution.ts`) this router compares at dispatch —
 *  the same conceptual pair as `smart-spawn.ts`'s `SHIFT_CANDIDATES` ("opus" vs the unset/"default"
 *  path), expressed as matrix family keys so the comparison reads directly off C05's cells. */
export const ROUTE_CHEAP_FAMILY = "sonnet";
export const ROUTE_FRONTIER_FAMILY = "opus";
/** The literal model string set on `opts.model` when routing escalates — the same `"opus"` literal
 *  `smart-spawn.ts`'s `SHIFT_CANDIDATES` already uses, so a dispatch-routed shift and an interactive
 *  smart-spawn shift key the model-outcomes ledger on the same bucket downstream. */
export const ROUTE_FRONTIER_MODEL = "opus";

export interface RouteDecision {
	/** The model to set on `opts.model` when routing escalates. `undefined` ⇒ leave the default
	 *  untouched (insufficient data, cheap already competitive, or no cell for this taskClass). */
	model?: string;
	/** One-line audit trail — always populated (even on a no-shift), so the decision is logged
	 *  whether the caller is in shadow or apply mode. */
	reason: string;
}

function taskClassKey(tc: { mode: string; tier: string }): string {
	return `${tc.mode}:${tc.tier}`;
}

function noShift(reason: string): RouteDecision {
	return { reason: `no-shift: ${reason}` };
}

/**
 * The pure routing decision (see module doc). `currentDefault` is the matrix family key the cheap
 * path resolves to — defaults to `ROUTE_CHEAP_FAMILY` ("sonnet", this codebase's actual cheap/default
 * model family); callers almost never need to override it. `opts.frontier`/`opts.minEdge` are
 * override seams for tests, not expected to vary in production.
 */
export function routeModelForTaskClass(
	taskClass: { mode: string; tier: string },
	matrix: TaskClassMatrixDoc,
	currentDefault: string = ROUTE_CHEAP_FAMILY,
	opts: { frontier?: string; frontierModel?: string; minEdge?: number } = {},
): RouteDecision {
	const frontier = opts.frontier ?? ROUTE_FRONTIER_FAMILY;
	const frontierModel = opts.frontierModel ?? ROUTE_FRONTIER_MODEL;
	const minEdge = opts.minEdge ?? MIN_EDGE;
	const tcKey = taskClassKey(taskClass);

	const cell = matrix.cells[tcKey];
	if (!cell) return noShift(`no cell for taskClass "${tcKey}"`);

	const cheap = cell[currentDefault];
	const rival = cell[frontier];
	// Cold/thin cell on EITHER side ⇒ no basis for comparison ⇒ no shift — same "unmeasured incumbent
	// is not a free win for the challenger, and a thin challenger cannot win either" symmetry
	// `shiftedModel` enforces, expressed via the matrix's own `insufficientData`/MIN_SAMPLES gate
	// rather than re-deriving a sample floor here.
	if (!cheap || cheap.insufficientData) return noShift(`cheap "${currentDefault}" insufficient data for "${tcKey}"`);
	if (!rival || rival.insufficientData) return noShift(`frontier "${frontier}" insufficient data for "${tcKey}"`);

	const edge = rival.mergeRate - cheap.mergeRate;
	if (edge < minEdge) return noShift(`edge ${edge.toFixed(2)} (< floor ${minEdge}) for "${tcKey}"`);

	return {
		model: frontierModel,
		reason: `route ${tcKey}: ${currentDefault} (${cheap.mergeRate.toFixed(2)}) -> ${frontier} (${rival.mergeRate.toFixed(2)}), edge ${edge.toFixed(2)}`,
	};
}
