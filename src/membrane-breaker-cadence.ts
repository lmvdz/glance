/**
 * Membrane breaker cadence caller (eap-borrows concern 05, batch-2 review fix) — the missing wiring
 * `runtime-settings.ts#runMembraneBreaker` was built for but never got. That module ships the PURE
 * check plus the one-shot disable action; this module is the caller that actually builds the
 * flagged-cohort and baseline `CellMetrics` it needs from real fleet state and hands both to it, on
 * the SAME event-driven cadence `threshold-tuner.ts`'s `recordConfidenceOutcome` uses (called once per
 * non-retryable land outcome — see `SquadManager.land()`) — "threshold-tuner-cadence check" per
 * concern 05's Approach. Without this module, DESIGN.md's "Membrane measurement" ruling ("hard
 * auto-disable breaker", resolving red-team B M3's "ceremonial posture" rejection) was not live: an
 * operator flipping `OMP_SQUAD_MEMBRANE_PROFILES=1` ran with no safety net.
 *
 * Cohort membership: a landing-kind unit counts as "membrane-flagged" when `unitEfficiencyFlags`
 * (receipts.ts — its CONFIRMED-delivered flags, unioned across every receipt it wrote) contains at
 * least one `membrane:*` token and is not the `["mixed"]` sentinel (concern 01's rule: a population
 * whose runs disagree on delivered flags is excluded rather than read as clean).
 *
 * Grain: `task-class-matrix.ts`'s natural cell key is (taskClass, model); the breaker's promise is
 * measured at (taskClass, membrane-flag) instead. The flagged cohort is collapsed into ONE cell per
 * taskClass by overriding `DenominatorUnit.model` to a local sentinel before calling
 * `buildTaskClassMatrix` — this stays entirely inside this scratch computation and never touches the
 * real per-model attribution any other reader (the routing panel, cost gate, etc.) depends on.
 *
 * Baseline (round-2 review fix): DESIGN.md/05-membrane-disciplines.md's ruling is "flagged cohort vs
 * auto-champion baseline" — but the auto-champion must be chosen from the UNFLAGGED population, not
 * the unfiltered one. A champion selected over the unfiltered population can itself BE (or be diluted
 * by) the very units this check is trying to catch, which quietly defeats the comparison in exactly
 * the regime the breaker exists for (a membrane-flagged cohort large enough to dominate a taskClass).
 * `flagged`/`unflagged`, not `flagged`/`everyone`.
 *
 * Cohort population (round-2 review fix): built from the UNION of the live roster
 * (`denominatorPopulation`, for units still in flight with no outcome row yet) and historical
 * task-outcomes rows (for flagged units that already landed and were reaped off the live roster) —
 * the same "denominator union" shape `buildTaskClassMatrix` itself uses internally. Reading only the
 * live-roster intersection meant a slow trickle of flagged units that land-then-reap one at a time
 * could NEVER accumulate `MEMBRANE_BREAKER_MIN_UNITS` concurrently live evidence, even with a large
 * total flagged population sitting in history.
 *
 * Baseline producer (eap-borrows follow-up, concern 01 DESIGN decision 4): this module is the ONE live
 * caller of `task-class-matrix.ts`'s baseline-selection contract, so it is also where
 * `baseline-tracker.ts#selectAndTrackBaseline` persists the selected champion and surfaces staleness —
 * see that call below and its own module doc.
 */

import { unitEfficiencyFlags, readAllReceipts, EFFICIENCY_FLAG_PREFIX } from "./receipts.ts";
import { readTaskOutcomes } from "./task-outcomes.ts";
import { buildTaskClassMatrix, type DenominatorUnit } from "./omp-graph/task-class-matrix.ts";
import { DAY_MS } from "./omp-graph/schema.ts";
import { runMembraneBreaker, RuntimeSettingsStore } from "./runtime-settings.ts";
import { selectAndTrackBaseline } from "./baseline-tracker.ts";
import type { AttentionEvent, RunReceipt } from "./types.ts";

/** Local-only model-key sentinel the flagged cohort is bucketed under so `buildTaskClassMatrix`
 *  collapses every flagged agentId in a taskClass into one cell, regardless of its real model. Never
 *  written to any durable record — this computation is scratch, thrown away after one check. */
const FLAGGED_MODEL_SENTINEL = "membrane-flagged";

function taskClassKey(tc: { mode: string; tier: string }): string {
	return `${tc.mode}:${tc.tier}`;
}

/** Which of the fleet's agentIds have at least one CONFIRMED-delivered `membrane:*` efficiency flag,
 *  read from every receipt they ever wrote (`readAllReceipts` — the same whole-fleet primitive
 *  `/api/usage`/`/api/heat`/the attribution board already read). Excludes a `["mixed"]` identity. */
async function flaggedAgentIds(stateDir: string): Promise<Set<string>> {
	const receipts = await readAllReceipts(stateDir);
	const byAgent = new Map<string, RunReceipt[]>();
	for (const r of receipts) {
		const list = byAgent.get(r.agentId);
		if (list) list.push(r);
		else byAgent.set(r.agentId, [r]);
	}
	const flagged = new Set<string>();
	for (const [agentId, rs] of byAgent) {
		const flags = unitEfficiencyFlags(rs);
		if (flags.length === 0) continue;
		if (flags.length === 1 && flags[0] === "mixed") continue; // concern 01: mixed populations excluded
		if (flags.some((f) => f.startsWith(EFFICIENCY_FLAG_PREFIX))) flagged.add(agentId);
	}
	return flagged;
}

/**
 * Builds the flagged-cohort `CellMetrics` for `taskClass` from real fleet state and, when it shows a
 * measured composite-success degradation against the taskClass's UNFLAGGED auto-champion baseline,
 * hard-disables `OMP_SQUAD_MEMBRANE_PROFILES` and returns the `AttentionEvent` explaining what tripped
 * (the actual check + disable is delegated to `runtime-settings.ts#runMembraneBreaker` — this module's
 * only job is building real `flagged`/`baseline` cells for it). `undefined` when there is no flagged
 * cohort yet, no comparable baseline, or the cohort is healthy — mirrors `runMembraneBreaker`'s own
 * "no signal, no state change" contract. Never throws — every I/O step here mirrors the non-fatal
 * try/catch every sibling cadence write (`recordModelOutcome`, `recordConfidenceOutcome`) already uses
 * at its call site; this function itself stays pure of that concern so it's testable without one.
 */
export async function membraneBreakerCadence(
	stateDir: string,
	denominatorPopulation: DenominatorUnit[],
	taskClass: { mode: string; tier: string },
	opts: { minEdge?: number; minUnits?: number; minSamples?: number; now?: number; store?: RuntimeSettingsStore; onStaleness?: (event: AttentionEvent) => void } = {},
): Promise<AttentionEvent | undefined> {
	const now = opts.now ?? Date.now();
	const range = { start: now - 30 * DAY_MS, end: now };
	const [rows, flagged] = await Promise.all([readTaskOutcomes(stateDir), flaggedAgentIds(stateDir)]);
	if (flagged.size === 0) return undefined;

	const tcKey = taskClassKey(taskClass);

	// Baseline: the taskClass's auto-champion computed off the UNFLAGGED population/rows only (round-2
	// review fix) — excluding every flagged agentId so the champion the flagged cohort is measured
	// against can never itself be diluted by the units under test.
	const unflaggedPopulation = denominatorPopulation.filter((u) => !flagged.has(u.agentId));
	const unflaggedRows = rows.filter((r) => !flagged.has(r.agentId));
	const baselineDoc = buildTaskClassMatrix(unflaggedRows, unflaggedPopulation, range);
	// eap-borrows follow-up (concern 01 DESIGN decision 4): this is the ONE live selection site for a
	// taskClass's baseline — `selectAndTrackBaseline` (baseline-tracker.ts) wraps the pure `selectBaseline`
	// with the missing producer: it persists whatever it picks and, when a previously-persisted (or
	// operator-pinned) baseline has rotted, reports it via `onStaleness` rather than silently swapping to
	// a new one or comparing against a ghost. A caller that doesn't wire `onStaleness` (e.g. tests that
	// only care about the membrane trip) simply drops the staleness signal on the floor — never a crash.
	const { baseline, staleness } = selectAndTrackBaseline(stateDir, baselineDoc, tcKey, { now });
	for (const event of staleness) opts.onStaleness?.(event);
	if (!baseline) return undefined; // no auto-champion (or valid pin) for this taskClass yet — nothing to compare against

	// Flagged population: the UNION of the live roster (flagged agentIds still in flight, possibly with
	// no outcome row yet) and historical task-outcomes rows (flagged agentIds that already landed and
	// were reaped off the live roster) — round-2 review fix. A roster-only filter drops a unit the
	// instant it's reaped, so a slow trickle of flagged units landing one at a time could never
	// accumulate MEMBRANE_BREAKER_MIN_UNITS of concurrently-live evidence even with plenty of history.
	const fromRoster = new Map<string, DenominatorUnit>();
	for (const u of denominatorPopulation) {
		if (flagged.has(u.agentId) && taskClassKey(u.taskClass) === tcKey) {
			fromRoster.set(u.agentId, { ...u, model: FLAGGED_MODEL_SENTINEL });
		}
	}
	for (const r of rows) {
		if (fromRoster.has(r.agentId)) continue; // roster entry already covers this agentId
		if (flagged.has(r.agentId) && taskClassKey(r.routing) === tcKey) {
			fromRoster.set(r.agentId, { agentId: r.agentId, taskClass: r.routing, model: FLAGGED_MODEL_SENTINEL });
		}
	}
	const flaggedPopulation: DenominatorUnit[] = [...fromRoster.values()];
	if (flaggedPopulation.length === 0) return undefined;

	// `buildTaskClassMatrix` has an agentId ROW win over the roster/population entry for the SAME
	// agentId (its real effective model) — see the module's "denominator union" comment. Passing the
	// unfiltered `rows` here would silently restore each flagged unit's real model and defeat the
	// sentinel override above, fragmenting the flagged cohort back across its real models instead of
	// collapsing it into one cell. Filter rows to the flagged cohort's agentIds and remap `model` on
	// them too, so row and population agree on the sentinel.
	const flaggedAgentIdSet = new Set(flaggedPopulation.map((u) => u.agentId));
	const flaggedRows = rows.filter((r) => flaggedAgentIdSet.has(r.agentId)).map((r) => ({ ...r, model: FLAGGED_MODEL_SENTINEL }));
	// `groupBy: "variant"` (not the default "family"): `modelFamily` would normalize the sentinel down
	// to its generic "other" bucket (any model string it doesn't recognize), which could collide with a
	// real unrecognized-model cell. `modelVariant` keeps the sentinel verbatim as its own cell key.
	const flaggedDoc = buildTaskClassMatrix(flaggedRows, flaggedPopulation, range, { groupBy: "variant" });
	const flaggedCell = flaggedDoc.cells[tcKey]?.[FLAGGED_MODEL_SENTINEL];
	if (!flaggedCell) return undefined;

	const store = opts.store ?? new RuntimeSettingsStore(stateDir);
	return runMembraneBreaker(store, tcKey, flaggedCell, baseline.cell, opts);
}
