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
 *
 * eap-borrows concern 01 (accounting-core) extends this into the success-COUPLED efficiency view:
 * `RunReceipt[]` join for tokens (mirroring the cost triple), a `reproducible` publish gate a
 * consumer cannot bypass, and `flagEfficiencyRegression`/`selectBaseline`/`detectBaselineStaleness`
 * built on top. The default `groupBy: "family"` keeps `routeModelForTaskClass` (model-route.ts) and
 * every existing cell-key assumption byte-identical; pass `groupBy: "variant"` for the efficiency
 * view, where a candidate/baseline comparison needs `gpt-5.6-sol` distinguishable from
 * `gpt-5.6-luna` — `modelFamily` collapses both to `"openai"`.
 */

import type { TaskOutcomeRow } from "../task-outcomes.ts";
import type { RunReceipt, AttentionEvent } from "../types.ts";
import type { TimeRange } from "./schema.ts";
import { inRange } from "./schema.ts";
import { modelFamily, modelVariant } from "./attribution.ts";

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
	/** Share of rows in the cell with `validation === "veto"` — independent of `outcome` (a veto can
	 *  land on any terminal outcome), part of the composite success signal alongside `mergeRate` and
	 *  `inRunReworkRate` (see `flagEfficiencyRegression`). `undefined` when the cell has no outcome
	 *  rows to rate, mirroring `inRunReworkRate`'s convention. */
	vetoRate?: number;
	/** Median summed `RunReceipt.tokens.total` per row in the cell — SUMMED across a unit's receipts
	 *  first (a resumed/re-spawned unit can have more than one), mirroring `medianCostUsd` exactly.
	 *  `undefined` when the builder was given no `receipts` at all, or none in the cell carry token
	 *  data. */
	medianTokensTotal?: number;
	/** Count of rows in the cell with token data (the `medianTokensTotal` sample size) — mirrors
	 *  `nWithCost`. */
	nWithTokens: number;
	/** `nWithTokens / (outcome rows in the cell)` — mirrors `costCoveragePct` exactly. 0 when the
	 *  builder was given no `receipts`, or the cell has no outcome rows. */
	tokensCoveragePct: number;
	/** True when `n` is below the matrix's `minSamples` gate — the UI must render this cell as
	 *  "insufficient data", never as if a 100%/0% mergeRate off a handful of units were signal. */
	insufficientData: boolean;
	/** The publish gate a consumer CANNOT bypass by recomputing it: `n` clears `minSamples`, cost (and,
	 *  when `receipts` were supplied, token) coverage clear `MIN_COVERAGE_PCT`, AND there is genuine
	 *  variance against this taskClass's auto-champion baseline (`TaskClassMatrixDoc.champions`) — a
	 *  cell tied with the champion at a saturated 0%/100% rate carries no comparative signal (live fleet
	 *  data: every collapsed outcome today is `"landed"`, so a naive mergeRate-only flag would be
	 *  structurally inert). `flagEfficiencyRegression` and any future baseline comparison MUST refuse a
	 *  cell where this is false. Computed here, in the builder, so no consumer can bypass it. */
	reproducible: boolean;
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
	/** taskClass -> auto-selected champion model key (best `mergeRate` among sample-sufficient cells —
	 *  `n`/cost/token coverage clear, prior to the variance-vs-champion check — cost as tie-break), or
	 *  `undefined` when the taskClass has no sample-sufficient cell yet. Computed HERE (not re-derivable
	 *  standalone by a consumer) so `CellMetrics.reproducible` and `selectBaseline` agree on the exact
	 *  same reference cell — read via `selectBaseline`, which also honors an explicit pin. */
	champions: Record<string, string | undefined>;
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

/** Cost/token coverage floor for the `reproducible` publish gate — a median drawn from fewer than
 *  half the cell's rows is a thin, possibly unrepresentative slice (see `CellMetrics.costCoveragePct`'s
 *  doc). NOT applied to token coverage when the builder was never given `RunReceipt[]` at all (see
 *  `buildTaskClassMatrix`'s `receipts` opt) — a caller that isn't tracking tokens yet shouldn't have
 *  every cell gated shut on a dimension it never asked to measure. */
export const MIN_COVERAGE_PCT = 0.5;

/** Noise floor for `inRunReworkRate` deltas in `flagEfficiencyRegression` — a couple points of
 *  fixup-rate jitter between two cells is not a regression signal. */
export const REWORK_EPS = 0.02;

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

/** Sample-sufficient: clears the `minSamples` floor plus the cost (and, when the builder was given
 *  receipts, token) coverage floor. Deliberately NOT the same thing as `CellMetrics.reproducible` —
 *  the champion for a taskClass is chosen FROM the sample-sufficient cells, so this check can't itself
 *  depend on a champion that doesn't exist yet (breaks the circularity `reproducible` alone would have:
 *  you need a champion to compute variance, and you need "sufficient" cells to pick a champion). */
export function isSampleSufficient(cell: CellMetrics, minSamples: number, tokenGateApplies: boolean): boolean {
	return (
		cell.n >= minSamples &&
		cell.costCoveragePct >= MIN_COVERAGE_PCT &&
		(!tokenGateApplies || cell.tokensCoveragePct >= MIN_COVERAGE_PCT)
	);
}

/** False exactly when two cells are tied at a SATURATED mergeRate (both 0 or both 1) — the "all
 *  collapsed outcomes are landed" case DESIGN.md calls out, where a mergeRate-only comparison is
 *  structurally inert (there is no way for either side to move). Any other tie (e.g. both at 0.5) still
 *  carries real information about where the distribution sits, so it counts as having variance. */
export function hasVarianceBetween(a: CellMetrics, b: CellMetrics): boolean {
	return !(a.mergeRate === b.mergeRate && (a.mergeRate === 0 || a.mergeRate === 1));
}

export function buildTaskClassMatrix(
	rows: TaskOutcomeRow[],
	denominatorPopulation: DenominatorUnit[],
	range: TimeRange,
	opts: { minSamples?: number; now?: number; receipts?: RunReceipt[]; groupBy?: "family" | "variant" } = {},
): TaskClassMatrixDoc {
	const minSamples = opts.minSamples ?? MIN_SAMPLES;
	// "family" (default) keeps every existing cell key — and therefore `routeModelForTaskClass`'s
	// family-literal lookups (`ROUTE_CHEAP_FAMILY`="sonnet" etc.) — byte-identical. "variant" is the
	// efficiency view's finer grain (module doc): pass it when the comparison needs `gpt-5.6-sol`
	// distinguishable from `gpt-5.6-luna`, which `modelFamily` would otherwise collapse to one cell.
	const keyModel = opts.groupBy === "variant" ? modelVariant : modelFamily;
	// The token-coverage arm of the `reproducible` gate only applies when the caller actually supplied
	// receipts — see `MIN_COVERAGE_PCT`'s doc. `receipts === []` (deliberately empty) still applies the
	// gate; `receipts === undefined` (never wired up) does not, which is the ONLY difference; see
	// `squad-manager.ts`'s existing call site (concern 01 didn't touch it — that's a later concern).
	const tokenGateApplies = opts.receipts !== undefined;

	// Outcome rows are range-filtered by `ts` (when the row was recorded) — the same convention
	// buildAttribution uses for receipts. The roster/denominator population is NOT time-filtered: it
	// is inherently a live snapshot (`SquadManager.landingRoster()`/`landingRosterRouting()`), not a
	// historical ledger with its own timestamps, mirroring how the merge-rate denominator is defined
	// end-to-end (concern 02: "the durable roster", not a windowed roster).
	const inRangeRows = rows.filter((r) => inRange(r.ts, range));
	const rowByAgent = new Map(inRangeRows.map((r) => [r.agentId, r] as const));

	// Receipts join (eap-borrows concern 01): SUM `tokens.total` per agentId across every in-range
	// receipt BEFORE it enters a cell — a resumed/re-spawned unit can have more than one receipt, and
	// the matrix's denominator is per-agentId, not per-receipt (mirrors the cost triple's contract:
	// one number per row, never one row per receipt). Range convention matches `buildAttribution`
	// (./attribution.ts): `endedAt ?? startedAt`. `.has()` (not a falsy check) distinguishes "no token
	// data at all" from "a receipt legitimately reported 0 tokens".
	const tokensByAgent = new Map<string, number>();
	for (const r of opts.receipts ?? []) {
		if (!inRange(r.endedAt ?? r.startedAt, range)) continue;
		if (!r.tokens || typeof r.tokens.total !== "number") continue;
		tokensByAgent.set(r.agentId, (tokensByAgent.get(r.agentId) ?? 0) + r.tokens.total);
	}

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
		agentCell.set(unit.agentId, { tcKey: taskClassKey(unit.taskClass), model: keyModel(unit.model) || UNKNOWN_MODEL });
	}
	for (const row of inRangeRows) {
		// Row wins over the roster entry for the same agentId (real effective model + terminal routing).
		agentCell.set(row.agentId, { tcKey: taskClassKey(row.routing), model: keyModel(row.model) || UNKNOWN_MODEL });
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
			let vetoed = 0;
			let rowsInCell = 0;
			const costs: number[] = [];
			const confidences: number[] = [];
			const tokens: number[] = [];

			for (const agentId of agentIds) {
				const row = rowByAgent.get(agentId);
				if (!row) continue; // roster-only member: a real denominator failure, no row to read metrics from
				rowsInCell += 1;
				if (row.outcome === "landed") {
					landed += 1;
					if ((row.fixupCount ?? 0) > 0) landedWithFixup += 1;
				}
				if (row.validation === "veto") vetoed += 1;
				if (typeof row.costUsd === "number") costs.push(row.costUsd);
				if (typeof row.confidence === "number") confidences.push(row.confidence);
				if (tokensByAgent.has(agentId)) tokens.push(tokensByAgent.get(agentId)!);
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
				vetoRate: rowsInCell > 0 ? vetoed / rowsInCell : undefined,
				medianTokensTotal: median(tokens),
				nWithTokens: tokens.length,
				tokensCoveragePct: rowsInCell > 0 ? tokens.length / rowsInCell : 0,
				insufficientData: n < minSamples,
				reproducible: false, // filled in by the champion pass below — every cell needs a real champion first
			};
			totalUnits += n;
			totalLanded += landed;
		}
	}

	// Second pass: per-taskClass auto-champion (best `mergeRate` among sample-sufficient cells, cost as
	// tie-break) + the `reproducible` gate. Deliberately split from the pass above: the champion for a
	// taskClass can only be chosen once every cell in it has its base metrics, and `reproducible` needs
	// the champion to compare variance against — computing both in one pass would mean comparing a cell
	// against a champion that hasn't seen its own final numbers yet.
	const champions: Record<string, string | undefined> = {};
	for (const tcKey of taskClasses) {
		const byModel = cells[tcKey];
		let championModel: string | undefined;
		let championCell: CellMetrics | undefined;
		for (const [model, cell] of Object.entries(byModel)) {
			if (!isSampleSufficient(cell, minSamples, tokenGateApplies)) continue;
			const better =
				!championCell ||
				cell.mergeRate > championCell.mergeRate ||
				(cell.mergeRate === championCell.mergeRate && (cell.medianCostUsd ?? Infinity) < (championCell.medianCostUsd ?? Infinity));
			if (better) {
				championModel = model;
				championCell = cell;
			}
		}
		champions[tcKey] = championModel;
		for (const cell of Object.values(byModel)) {
			cell.reproducible = !!championCell && isSampleSufficient(cell, minSamples, tokenGateApplies) && hasVarianceBetween(cell, championCell);
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
		champions,
		causal: false,
		note: "Observational — rows are grouped by the router's own choices; not yet a causal comparison of models.",
		generatedAt: opts.now ?? Date.now(),
	};
}

/** One taskClass's baseline: the auto-champion (or pin) cell a candidate is measured against. */
export interface TaskClassBaseline {
	taskClass: string;
	model: string;
	cell: CellMetrics;
	/** True when `opts.pinnedModel` selected this baseline; false when it's the auto-champion. */
	pinned: boolean;
}

/**
 * Resolve a taskClass's baseline for efficiency comparisons. An explicit `pinnedModel` ALWAYS wins
 * over the computed champion (an operator's pin is a deliberate override, not a suggestion) — but only
 * when its cell actually exists in this doc; a pin pointing at a model this taskClass has never seen
 * resolves to `undefined` rather than silently falling back to the auto-champion (a rotting pin should
 * surface via `detectBaselineStaleness`, never fail open into a different comparison the operator
 * didn't ask for). Absent a pin, reads `doc.champions` — the SAME champion `CellMetrics.reproducible`
 * was computed against, so a consumer can never see a baseline disagree with the gate that graded it.
 */
export function selectBaseline(doc: TaskClassMatrixDoc, taskClass: string, opts: { pinnedModel?: string } = {}): TaskClassBaseline | undefined {
	const cellsForClass = doc.cells[taskClass];
	if (!cellsForClass) return undefined;
	if (opts.pinnedModel) {
		const pinned = cellsForClass[opts.pinnedModel];
		return pinned ? { taskClass, model: opts.pinnedModel, cell: pinned, pinned: true } : undefined;
	}
	const model = doc.champions[taskClass];
	if (!model) return undefined;
	const cell = cellsForClass[model];
	return cell ? { taskClass, model, cell, pinned: false } : undefined;
}

/**
 * A pinned-or-previously-champion baseline that has degraded to `insufficientData` (or dropped out of
 * the fleet entirely) is a GHOST — comparing anything against it is comparing against noise, not a
 * measured reference. Call with the model a caller was PREVIOUSLY treating as this taskClass's
 * baseline (from a persisted pin, or the last time `selectBaseline` resolved one); returns an
 * `AttentionEvent` when that baseline can no longer support a comparison, `undefined` when it's still
 * healthy. Pure — delivering the event (attaching it somewhere a human sees it) is the caller's job.
 */
export function detectBaselineStaleness(
	taskClass: string,
	previousBaselineModel: string,
	doc: TaskClassMatrixDoc,
	now: number = Date.now(),
): AttentionEvent | undefined {
	const cell = doc.cells[taskClass]?.[previousBaselineModel];
	if (cell && !cell.insufficientData) return undefined; // still healthy — no ghost comparison risk
	return {
		id: `baseline-stale:${taskClass}:${previousBaselineModel}:${now}`,
		summary: `Baseline "${previousBaselineModel}" for taskClass "${taskClass}" is stale`,
		detail: cell
			? `n=${cell.n} < minSamples=${doc.minSamples} — insufficient data to keep comparing against it`
			: `no cell recorded for "${previousBaselineModel}" in taskClass "${taskClass}" — it dropped out of the fleet or was never dispatched here`,
		source: "notify",
		createdAt: now,
	};
}

/**
 * The efficiency-regression checker: does `candidate` win on cost/tokens but lose on the composite
 * success signal? Fires when candidate is cheaper (lower `medianCostUsd` OR lower `medianTokensTotal`
 * — either dimension counts) AND at least one of:
 *   - a LOWER `mergeRate`, but only when `hasVarianceBetween` says the comparison isn't a saturated tie
 *     (a "cheaper AND landed less" read off two cells both stuck at 100% is not a signal — see
 *     `CellMetrics.reproducible`'s doc for why);
 *   - a HIGHER `vetoRate`;
 *   - a HIGHER `inRunReworkRate`, beyond `REWORK_EPS` noise.
 * Deliberately self-contained (does NOT read `.reproducible` off either cell): a caller comparing two
 * arbitrary cells — not necessarily `candidate` against its taskClass's `champions` entry — still gets
 * the saturated-tie guard for free, rather than a silent false positive if it forgot to check
 * `reproducible` itself. Callers building a publish-gated view should still filter to
 * `reproducible`-cells before calling this; that gate gets skipped for a candidate-vs-champion
 * comparison a caller runs directly against `champions`, this function alone.
 */
export function flagEfficiencyRegression(candidate: CellMetrics, baseline: CellMetrics): boolean {
	const cheaperCost = candidate.medianCostUsd !== undefined && baseline.medianCostUsd !== undefined && candidate.medianCostUsd < baseline.medianCostUsd;
	const cheaperTokens =
		candidate.medianTokensTotal !== undefined && baseline.medianTokensTotal !== undefined && candidate.medianTokensTotal < baseline.medianTokensTotal;
	if (!cheaperCost && !cheaperTokens) return false;

	const lowerMergeUnderVariance = hasVarianceBetween(candidate, baseline) && candidate.mergeRate < baseline.mergeRate;
	const higherVeto = candidate.vetoRate !== undefined && baseline.vetoRate !== undefined && candidate.vetoRate > baseline.vetoRate;
	const higherRework =
		candidate.inRunReworkRate !== undefined && baseline.inRunReworkRate !== undefined && candidate.inRunReworkRate - baseline.inRunReworkRate > REWORK_EPS;

	return lowerMergeUnderVariance || higherVeto || higherRework;
}
