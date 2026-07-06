/**
 * task-class-matrix — the "task-class × model" outcome scoreboard (model-routing-control-loop
 * concern 05). Aggregates the joined outcome log (`task-outcomes.ts`, concern 03) against the
 * landing-kind roster (`is-landing-unit.ts`, concern 02) into a matrix of
 * `taskClass (routing.mode + routing.tier) × modelFamily(model)` cells.
 *
 * THIS IS AN OBSERVATIONAL SURFACE, NOT A DECISION ORACLE. Every cell only ever sees choices the
 * router already made — grading the router by its own routing decision is circular until an
 * independent exploration signal exists (deferred, see DESIGN.md's D1). `causal: false` on the doc
 * is not decoration; every consumer (the server route, the webapp panel) MUST surface the
 * accompanying `note` prominently. See DESIGN.md "Key decisions" #1 and #3.
 *
 * Pure (rows + denominator population + range in, doc out) — no I/O — so tests drive it without a
 * daemon. Sibling to `buildAttribution` (./attribution.ts): same "reduce a raw ledger to a fixed
 * matrix at request time" shape, same reuse of `modelFamily`/`TimeRange`/`inRange`.
 */

import type { TaskOutcomeRow } from "../task-outcomes.ts";
import type { TimeRange } from "./schema.ts";
import { inRange } from "./schema.ts";
import { modelFamily } from "./attribution.ts";

/**
 * One denominator-population member: a landing-kind unit (`is-landing-unit.ts`'s `isLandingUnit`
 * filter already applied by the caller — e.g. `SquadManager.landingRosterRouting()`) and its
 * routing decision. Roster members contribute here EVEN WHEN they never produced a `TaskOutcomeRow`
 * (a unit that died before any land attempt) — that is the entire point of the roster-anchored
 * denominator (concern 02): a receipts/rows-only count would structurally exclude the worst
 * failures.
 */
export interface DenominatorUnit {
	agentId: string;
	taskClass: { mode: string; tier: string };
	model?: string;
}

/** One `taskClass × model` cell. `n` is the honest denominator — see `buildTaskClassMatrix`'s doc
 *  for exactly how it's computed. `landed` is always drawn from the SAME deduped agentId set as
 *  `n`, so `mergeRate` can never exceed 1 (enforced with a guard, not just an invariant in prose). */
export interface CellMetrics {
	/** Denominator: distinct landing-kind agentIds known to have existed in this cell (roster ∪ rows). */
	n: number;
	/** Numerator: distinct agentIds among `n` whose collapsed outcome row is `outcome === "landed"`. */
	landed: number;
	mergeRate: number;
	/** Median cost over rows in the cell WITH a defined `costUsd` — never over the whole (mostly
	 *  subscription-priced, null-cost) cell. `undefined` when no row in the cell has a cost. */
	medianCostUsd?: number;
	/** Count of rows in the cell with a defined `costUsd` (the `medianCostUsd` sample size). */
	nWithCost: number;
	/** `nWithCost / (outcome rows in the cell)` — 0 when the cell has no outcome rows at all. Read
	 *  this alongside `medianCostUsd`: a low value means the median is drawn from a thin, possibly
	 *  unrepresentative slice of a mostly-subscription-priced fleet. */
	costCoveragePct: number;
	/** Median confidence over rows in the cell with a defined `confidence`. */
	medianConfidence?: number;
	/** Share of LANDED rows in the cell with `fixupCount > 0` — IN-RUN rework (retries before the
	 *  agent's own land attempt), never a post-merge regression signal (none exists anywhere in this
	 *  codebase). `undefined` when the cell has no landed rows to rate. */
	inRunReworkRate?: number;
	/** True when `n` is below the matrix's `minSamples` gate — the UI must render this cell as
	 *  "insufficient data", never as if a 100%/0% mergeRate off a handful of units were signal. */
	insufficientData: boolean;
}

export interface TaskClassMatrixDoc {
	range: TimeRange;
	/** `taskClass` keys present, e.g. "tdd:heavy", sorted for stable rendering. */
	taskClasses: string[];
	/** `modelFamily` keys present (see `modelFamily` in ./attribution.ts), sorted for stable rendering. */
	models: string[];
	/** taskClass -> model -> metrics. Every (taskClass, model) pair that has ANY denominator member
	 *  gets a cell — a taskClass never seen with a given model simply has no entry for it. */
	cells: Record<string, Record<string, CellMetrics>>;
	/** Sum of every cell's `n` — the total landing-kind population this doc accounts for. */
	totalUnits: number;
	/** Sum of every cell's `landed`. */
	totalLanded: number;
	/** The minimum-sample gate applied to every cell's `insufficientData`. */
	minSamples: number;
	/** Always `false` — this is an observational surface, never a causal comparison of models. A
	 *  literal type (not `boolean`) so a consumer can't accidentally flip it true. */
	causal: false;
	/** The mandatory honesty label every consumer must render prominently. */
	note: string;
	generatedAt: number;
}

/** Cells below this many denominator members render "insufficient data" rather than a misleading
 *  rate. Mirrors the spirit of smart-spawn.ts's `MIN_SAMPLES` gate (a distinct constant/value —
 *  this matrix's cells are far sparser per (taskClass, model) pair than the shift's rolling
 *  per-candidate counts, so a lower bar is the honest one here). */
export const MIN_SAMPLES = 3;

const UNKNOWN_MODEL = "unknown";

function taskClassKey(tc: { mode: string; tier: string }): string {
	return `${tc.mode}:${tc.tier}`;
}

/** Standard median: sorted middle value, averaging the two middle values for an even-length input.
 *  `undefined` on an empty sample — a cell with zero cost-bearing rows must never render a fake 0. */
function median(xs: number[]): number | undefined {
	if (xs.length === 0) return undefined;
	const sorted = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function buildTaskClassMatrix(
	rows: TaskOutcomeRow[],
	denominatorPopulation: DenominatorUnit[],
	range: TimeRange,
	opts: { minSamples?: number; now?: number } = {},
): TaskClassMatrixDoc {
	const minSamples = opts.minSamples ?? MIN_SAMPLES;

	// Outcome rows are range-filtered by `ts` (when the row was recorded) — the same convention
	// buildAttribution uses for receipts. The roster/denominator population is NOT time-filtered: it
	// is inherently a live snapshot (`SquadManager.landingRoster()`/`landingRosterRouting()`), not a
	// historical ledger with its own timestamps, mirroring how the merge-rate denominator is defined
	// end-to-end (concern 02: "the durable roster", not a windowed roster).
	const inRangeRows = rows.filter((r) => inRange(r.ts, range));
	const rowByAgent = new Map(inRangeRows.map((r) => [r.agentId, r] as const));

	// THE DENOMINATOR UNION — the load-bearing correctness detail. A cell's honest denominator is the
	// DEDUPED UNION of (a) the roster/denominator population and (b) the agentIds that have an
	// outcome row:
	//   (a) alone would miss reconciled units evicted from the live roster (they only exist as a row).
	//   (b) alone would miss units that died before `land()` ever wrote a row — the exact
	//       units-never-commit failure class concern 02's roster-anchored denominator exists to catch.
	// CRITICAL: each distinct agentId must resolve to EXACTLY ONE cell, or a landed unit whose roster
	// model and row model disagree gets counted in both — inflating totals and showing a phantom
	// "unknown"-column failure alongside its real-model success. The roster's `model` is the (often
	// stale/undefined ⇒ "unknown") `dto.model`, while the row's `model` is concern 01's real effective
	// model from the receipt; when both exist for one agentId, the ROW WINS (it carries the model omp
	// actually ran, and its routing is the same decision). Resolve every agentId to one (taskClass,
	// model) cell first, then count — so `landed <= n` holds per cell and nothing double-counts.
	const agentCell = new Map<string, { tcKey: string; model: string }>();
	for (const unit of denominatorPopulation) {
		agentCell.set(unit.agentId, { tcKey: taskClassKey(unit.taskClass), model: modelFamily(unit.model) || UNKNOWN_MODEL });
	}
	for (const row of inRangeRows) {
		// Row wins over the roster entry for the same agentId (real effective model + terminal routing).
		agentCell.set(row.agentId, { tcKey: taskClassKey(row.routing), model: modelFamily(row.model) || UNKNOWN_MODEL });
	}

	const cellAgents = new Map<string, Map<string, Set<string>>>(); // taskClass -> model -> Set<agentId>
	for (const [agentId, { tcKey, model }] of agentCell) {
		let byModel = cellAgents.get(tcKey);
		if (!byModel) cellAgents.set(tcKey, (byModel = new Map()));
		let set = byModel.get(model);
		if (!set) byModel.set(model, (set = new Set()));
		set.add(agentId);
	}

	const taskClasses = [...cellAgents.keys()].sort();
	const modelSet = new Set<string>();
	for (const byModel of cellAgents.values()) for (const m of byModel.keys()) modelSet.add(m);
	const models = [...modelSet].sort();

	const cells: Record<string, Record<string, CellMetrics>> = {};
	let totalUnits = 0;
	let totalLanded = 0;

	for (const tcKey of taskClasses) {
		cells[tcKey] = {};
		const byModel = cellAgents.get(tcKey)!;
		for (const model of models) {
			const agentIds = byModel.get(model);
			if (!agentIds) continue; // this (taskClass, model) pair has no denominator member — no cell
			const n = agentIds.size;

			let landed = 0;
			let landedWithFixup = 0;
			let rowsInCell = 0;
			const costs: number[] = [];
			const confidences: number[] = [];

			for (const agentId of agentIds) {
				const row = rowByAgent.get(agentId);
				if (!row) continue; // roster-only member: a real denominator failure, no row to read metrics from
				rowsInCell += 1;
				if (row.outcome === "landed") {
					landed += 1;
					if ((row.fixupCount ?? 0) > 0) landedWithFixup += 1;
				}
				if (typeof row.costUsd === "number") costs.push(row.costUsd);
				if (typeof row.confidence === "number") confidences.push(row.confidence);
			}

			const mergeRate = n > 0 ? landed / n : 0;
			// Denominator-honesty guard: `landed` is a subset of `agentIds` (the SAME set `n` counts),
			// so mergeRate > 1 is only reachable if the union above was built wrong. Fail loudly rather
			// than render a lie — this is the invariant the whole design hinges on (DESIGN.md: "merge
			// rate can never exceed 1 if you dedup by agentId correctly").
			if (mergeRate > 1) {
				throw new Error(
					`task-class-matrix: mergeRate > 1 for cell "${tcKey}"/"${model}" (landed=${landed}, n=${n}) — denominator union is broken`,
				);
			}

			cells[tcKey][model] = {
				n,
				landed,
				mergeRate,
				medianCostUsd: median(costs),
				nWithCost: costs.length,
				costCoveragePct: rowsInCell > 0 ? costs.length / rowsInCell : 0,
				medianConfidence: median(confidences),
				inRunReworkRate: landed > 0 ? landedWithFixup / landed : undefined,
				insufficientData: n < minSamples,
			};
			totalUnits += n;
			totalLanded += landed;
		}
	}

	return {
		range,
		taskClasses,
		models,
		cells,
		totalUnits,
		totalLanded,
		minSamples,
		causal: false,
		note: "Observational — rows are grouped by the router's own choices; not yet a causal comparison of models.",
		generatedAt: opts.now ?? Date.now(),
	};
}
