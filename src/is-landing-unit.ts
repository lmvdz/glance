/**
 * Denominator honesty (Epic 6 concern 02 — model-routing-control-loop).
 *
 * Merge-rate's denominator must be anchored on the durable dispatched-unit ROSTER, not on land
 * receipts: a unit that dies before `finalizeRun` never appends a receipt (the documented
 * units-never-commit pattern), so a receipts-based count structurally excludes the worst failures
 * and merge-rate reads inflated. `createWithId` (squad-manager.ts) constructs the `PersistedAgent`,
 * inserts it into the live roster, and `await this.persist()`s a full snapshot before returning — so
 * every dispatched unit that survives its own create() leaves a roster record even if it crashes a
 * moment later. (Residual: a crash DURING the create handshake, between construct and persist, never
 * leaves a row — an accepted, undocumented-elsewhere gap, not chased here.)
 *
 * Not every roster record is a candidate to land, though — some kinds/roles/modes never commit by
 * design, and counting them as denominator failures would read as false failures. `isLandingUnit`
 * draws that line.
 */

import type { AutonomyMode } from "./autonomy.ts";
import type { AgentDTO } from "./types.ts";

/**
 * Structural subset of `AgentDTO` this predicate needs. Deliberately NOT `AgentRecord` (the live
 * in-memory shape isn't exported from squad-manager.ts) and not `PersistedAgent` either: `kind`,
 * `executionRole`, and `workflow` live on both, but the runtime-capped autonomy mode
 * (`effectiveMode`) is DTO-only — the manager keeps it continuously recomputed via `syncAuthority`
 * (squad-manager.ts) on every agent broadcast, so reading it here is single-source-of-truth rather
 * than a second `effectiveAutonomyMode` computation that could drift from the live one. Any
 * `AgentDTO`, or an object shaped like one (e.g. a test fixture), satisfies this type.
 */
export type LandingUnitCandidate = Pick<AgentDTO, "kind" | "executionRole"> & {
	workflow?: { verify?: { mode?: "verify" | "tdd" | "observe" } };
	/** Requested/static authority for this run (`AgentDTO.autonomyMode`) — NOT the runtime-capped
	 *  `effectiveMode`. We key the observe exclusion off the STATIC mode on purpose: `effectiveMode`
	 *  collapses to "observe" whenever a `blockedReason` is set (autonomy.ts) — and `blockedReason`
	 *  fires on `dto.error`/`dto.pending`, so an errored or awaiting-input unit that never landed would
	 *  read as effectiveMode "observe". That unit is a real merge-rate FAILURE and must stay in the
	 *  denominator; only a by-design plan-only unit (statically requested `autonomyMode: "observe"`)
	 *  is a non-lander. `effectiveMode` can't distinguish the two — `autonomyMode` can. */
	autonomyMode?: AutonomyMode;
};

/**
 * True unless the record is one of the kinds/roles/modes that, by design, never lands — in which
 * case counting a missing land row against it would be a false failure:
 *  - `kind === "flue-service"` (types.ts:55) — a synthetic repo ("(flue-service)"), no branch, never merges.
 *  - `executionRole === "observer"` (types.ts:58) — reproduce-and-report; never commits.
 *  - `autonomyMode === "observe"` (types.ts:657) — a by-design plan-only unit; `land` is stripped
 *    from `availableActions` (autonomy.ts). Keyed off the STATIC requested mode, not the runtime
 *    `effectiveMode`: the latter collapses to "observe" on any `blockedReason` (incl. `dto.error`/
 *    `dto.pending`), which would wrongly drop errored/abandoned units — real failures that must be
 *    counted. See `LandingUnitCandidate.autonomyMode` for the full rationale.
 *  - `workflow.verify.mode === "observe"` (types.ts VerifySpec) — the synthesized observe loop never
 *    fixes/commits.
 *
 * Everything else counts as a landing unit, including `kind` in `{"omp-operator","workflow"}`,
 * `executionRole === "tester"` (a tdd unit still lands), and adopted units (they land directly via
 * the orchestrator — `adopted` is never itself a kind/role/mode value, so it never needs its own
 * check: it falls through to true here unless one of the four exclusions above also applies).
 */
export function isLandingUnit(rec: LandingUnitCandidate): boolean {
	if (rec.kind === "flue-service") return false;
	if (rec.executionRole === "observer") return false;
	if (rec.autonomyMode === "observe") return false;
	if (rec.workflow?.verify?.mode === "observe") return false;
	return true;
}

/**
 * The merge-rate denominator population (concern 05 computes `landed / landingRosterOf(...).length`):
 * every roster record that's actually expected to land, filtered out of the full dispatched-unit
 * roster. Pure and testable on its own — takes the roster array rather than reaching into a live
 * `SquadManager`, so it works identically on `[...agents.values()].map(r => r.dto)` (the live roster;
 * see `SquadManager.landingRoster`), a `state.json` snapshot, or a test fixture.
 */
export function landingRosterOf<T extends LandingUnitCandidate>(roster: T[]): T[] {
	return roster.filter(isLandingUnit);
}
