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
 *
 * adw-factory-borrows concern 09 (per-lane enforcement) repurposes `routeModelForTaskClass`'s
 * `opts.minEdge`/`opts.frontier`/`opts.frontierModel` trio: they were documented above as override
 * seams FOR TESTS ONLY — this concern re-documents them, on the record, as OPERATOR-POLICY seams too:
 * `modelRouteMinEdgeFor` below reads a per-lane `LANE_POLICY[lane].modelRouteMinEdge` override and
 * passes it through the exact same `opts.minEdge` parameter a test would use. The shared `MIN_EDGE`
 * evidence floor still applies wherever no lane override exists (no lane threaded, or the lane's row
 * carries no override, e.g. every lane but "hotfix" today) — a lane earns a lower bar explicitly, in
 * `src/lane.ts`'s constants, never implicitly.
 */

import { LANE_POLICY, type WorkLane } from "./lane.ts";
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
 * model family); callers almost never need to override it. `opts.frontier`/`opts.minEdge` are override
 * seams for tests AND, since adw-factory-borrows concern 09, for per-lane operator policy (see the
 * module doc and `modelRouteMinEdgeFor` below) — not expected to vary any other way.
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
	// `reproducible` (eap-borrows concern 01) is the STRICTER gate `insufficientData` alone can't
	// catch: coverage-thin medians and saturated-tie cells (every collapsed outcome landed, both sides
	// pinned at 1.0) both pass `insufficientData` but carry no real comparative signal. Same fail-closed
	// posture as the two checks above — a cell that clears the sample floor but not this one still
	// means "no basis for comparison", not "shift anyway".
	if (!cheap.reproducible) return noShift(`cheap "${currentDefault}" not reproducible for "${tcKey}"`);
	if (!rival.reproducible) return noShift(`frontier "${frontier}" not reproducible for "${tcKey}"`);

	const edge = rival.mergeRate - cheap.mergeRate;
	if (edge < minEdge) return noShift(`edge ${edge.toFixed(2)} (< floor ${minEdge}) for "${tcKey}"`);

	return {
		model: frontierModel,
		reason: `route ${tcKey}: ${currentDefault} (${cheap.mergeRate.toFixed(2)}) -> ${frontier} (${rival.mergeRate.toFixed(2)}), edge ${edge.toFixed(2)}`,
	};
}

/**
 * Whether a model-route decision should be APPLIED (vs shadow-logged only) for `lane` — the per-lane
 * enforcement flip (adw-factory-borrows concern 09).
 *
 * The FLEET-WIDE `OMP_SQUAD_MODEL_ROUTE_SHADOW=0` escape hatch, unchanged from concern 06, is the
 * baseline: it applies regardless of lane, lane source, or any `LANE_POLICY` row (this is the exact
 * contract `lane-threading.test.ts`'s clamp tests lock down — a label/classifier-sourced lane must
 * NEVER suppress the operator's global apply flag; DESIGN.md: the clamp only moves privilege
 * axes STRICTER for ticket-text lanes, never looser, so it can't touch this baseline at all).
 *
 * On top of that baseline, an OPERATOR-sourced lane (`appliesPrivilege` true — concern 02's clamp)
 * may WIDEN past a global "shadow" default: if the global flag says shadow but the lane's OWN
 * `LANE_POLICY[lane].modelRouteApply` is `true`, this lane still applies — a genuinely per-lane flip
 * (e.g. flip JUST "hotfix" to apply) independent of the fleet-wide flag, which is what the Goal names
 * ("model routing can flip from shadow to apply per lane"). v1 ships every lane's flag `false`, so
 * this widening path is inert until an operator flips one (an evidence-gated, named exit, not this
 * concern's job to flip). A label/classifier-sourced lane can NEVER widen this way — ticket text must
 * never buy privilege on its own.
 */
export function modelRouteShouldApply(lane: WorkLane, appliesPrivilege: boolean, globalShadowFlag = process.env.OMP_SQUAD_MODEL_ROUTE_SHADOW): boolean {
	if (globalShadowFlag === "0") return true; // fleet-wide apply — unaffected by lane or lane source
	return appliesPrivilege && LANE_POLICY[lane].modelRouteApply; // per-lane widening, operator-only
}

/**
 * The per-lane `minEdge` override to pass through `routeModelForTaskClass`'s `opts.minEdge` (the
 * "operator-policy seam" the module doc names), or `undefined` to keep the shared `MIN_EDGE` floor —
 * ONLY when `appliesPrivilege` (same clamp as `modelRouteShouldApply`: a label/classifier lane must
 * never buy a lower evidence bar for itself either). A lane whose `LANE_POLICY` row sets no override
 * (every lane but "hotfix" today) also falls through to `undefined`, i.e. the shared floor.
 */
export function modelRouteMinEdgeFor(lane: WorkLane, appliesPrivilege: boolean): number | undefined {
	return appliesPrivilege ? LANE_POLICY[lane].modelRouteMinEdge : undefined;
}
