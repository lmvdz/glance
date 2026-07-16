/**
 * cost-aggregate.ts — lane-keyed O(1) rolling cost aggregate (adw-factory-borrows concern 08).
 *
 * `src/cost-gate.ts`'s `projectCost` is today an async FULL SCAN over every receipt on disk
 * (`readAllReceipts`) — fine for a shadow-only warn line, but the header there names exactly why
 * enforce (a hard park/deny) is deferred: it needs an O(1) $ ledger. This module is that ledger:
 * a tiny-JSON-per-stateDir document (mirrors `model-outcomes.ts` exactly: sync read-modify-write,
 * corrupt/missing ⇒ fresh, best-effort write, single-writer/single-event-loop) keyed
 * `${modelFamily}::${tier}::${lane}`, PLUS a lane-agnostic `${modelFamily}::${tier}::*` roll-up per
 * DESIGN.md's fallback discipline: a chore-lane ceiling checked against feature-dominated history
 * denies wrongly on arrival, so a thin lane-keyed cell must fall back to the roll-up rather than
 * either firing on noise or refusing to answer at all.
 *
 * Pure at the core (`buildCostAggregateFromReceipts`, `projectFromCostAggregate`) — no I/O — so the
 * "rebuild from receipts equals incremental state" property is testable without a filesystem. This
 * module has NO dependency on `receipts.ts` (avoiding an import cycle, since `receipts.ts` calls
 * `recordCostAttempt` from its own `appendReceipt`); the full-scan rebuild ORCHESTRATION (fetch
 * receipts + outcomes, call the pure builder, persist) lives in `cost-gate.ts`, which already
 * imports both `readAllReceipts` and `readModelOutcomes`.
 *
 * Window: a TUMBLING (not sliding) 30-day window per cell — cheap O(1) storage trades a little
 * precision (a cell can hold up to `COST_AGGREGATE_WINDOW_MS` of history, not an exact trailing
 * slice) for never storing per-event history. A write past a cell's window start resets it; a READ
 * of an already-stale cell (no write since it went stale) also treats it as absent, so a cell can't
 * read as live forever just because nothing happened to trigger a reset. 30 days matches the
 * model-route matrix window (`squad-manager.ts`'s `Date.now() - 30 * DAY_MS` call into
 * `buildTaskClassMatrix`) — recent history is the decision-relevant slice, not all-time.
 *
 * IMPORTANT rollout note (see this concern's reported anomaly): `RunReceipt.tier` and the real
 * per-lane `landed` signal both need a call-site wire in `squad-manager.ts` that is OUTSIDE this
 * concern's declared scope (`recordCostLanded` below is the exported, never-yet-called hook for it,
 * mirroring `model-outcomes.ts`'s `recordModelOutcome` call site exactly). Until that wiring lands,
 * every real receipt's `tier` is `undefined` (bucketed under the literal "unknown" tier, which a real
 * `ComplexityTier` query never matches) and lane-keyed `landed` stays 0 — so `projectFromCostAggregate`
 * never answers from a real tier bucket today, and `cost-gate.ts`'s existing full-scan fallback keeps
 * answering exactly as it does before this concern. That is intentional: the data layer ships safe
 * and inert until the wiring exists, matching this plan's repeated "shadow first, wire later" shape.
 */

import * as path from "node:path";
import type { ComplexityTier, ModelOutcomes } from "./model-outcomes.ts";
import { modelFamily } from "./model-outcomes.ts";
import type { WorkLane } from "./lane.ts";
import type { RunReceipt } from "./types.ts";
import { DAY_MS } from "./omp-graph/schema.ts";
import { getStorageBackend } from "./dal/storage.ts";

/** One `(model, tier, lane)` — or lane-agnostic `(model, tier)` — cell's rolling counters. */
export interface CostAggregateCell {
	/** Attempts (finalized receipts) counted in the current window. */
	attempts: number;
	/** Of those attempts, how many are known to have landed (see the rollout note above — real
	 *  lane-keyed data needs a future wire; the lane-agnostic roll-up gets this from the existing
	 *  `model-outcomes.ts` ledger at rebuild time). */
	landed: number;
	/** Sum of `costUsd` over the attempts counted in the current window. */
	costUsdSum: number;
	/** When the CURRENT window started (ms epoch) — a write past `COST_AGGREGATE_WINDOW_MS` since
	 *  this resets the cell to a fresh window rather than extending it forever. */
	windowStart: number;
}

export interface CostAggregateDoc {
	schemaVersion: number;
	generatedAt: number;
	/** `${modelFamily}::${tier|"unknown"}::${lane}` for a lane-keyed cell, or `::${LANE_AGNOSTIC}` for
	 *  the roll-up — see `cellKey`. */
	cells: Record<string, CostAggregateCell>;
}

export const COST_AGGREGATE_SCHEMA_VERSION = 1;
/** Matches the model-route matrix window (`squad-manager.ts`'s `30 * DAY_MS` into
 *  `buildTaskClassMatrix`) — see the module doc's "Window" section. */
export const COST_AGGREGATE_WINDOW_MS = 30 * DAY_MS;

/** Sentinel lane segment for the lane-agnostic `model|tier` roll-up cell — never a real `WorkLane`
 *  value (the union is `"hotfix" | "feature" | "chore"`), so it can never collide with a real lane's
 *  cell. */
const LANE_AGNOSTIC = "*";

function docPath(stateDir: string): string {
	return path.join(stateDir, "cost-aggregate.json");
}

function emptyDoc(now = Date.now()): CostAggregateDoc {
	return { schemaVersion: COST_AGGREGATE_SCHEMA_VERSION, generatedAt: now, cells: {} };
}

function tierKeyPart(tier: ComplexityTier | undefined): string {
	// "unknown" is a literal bucket name a real ComplexityTier ("light"/"mid"/"heavy") can never
	// equal — see the rollout note: every receipt lands here until a future concern stamps a real
	// tier onto RunSeed/RunReceipt, and no real query ever asks for "unknown" by construction.
	return tier ?? "unknown";
}

function cellKey(model: string | undefined, tier: ComplexityTier | undefined, lane: string): string {
	return `${modelFamily(model)}::${tierKeyPart(tier)}::${lane}`;
}

function readRaw(stateDir: string): { doc: CostAggregateDoc; valid: boolean } {
	try {
		const p = docPath(stateDir);
		const b = getStorageBackend();
		if (!b.exists(p)) return { doc: emptyDoc(), valid: false };
		const raw = b.readTextSync(p);
		if (raw === undefined) return { doc: emptyDoc(), valid: false };
		const parsed: unknown = JSON.parse(raw);
		if (
			!parsed ||
			typeof parsed !== "object" ||
			(parsed as CostAggregateDoc).schemaVersion !== COST_AGGREGATE_SCHEMA_VERSION ||
			typeof (parsed as CostAggregateDoc).cells !== "object"
		) {
			return { doc: emptyDoc(), valid: false }; // missing/corrupt/schema-mismatch ⇒ caller rebuilds
		}
		return { doc: parsed as CostAggregateDoc, valid: true };
	} catch {
		return { doc: emptyDoc(), valid: false }; // corrupt/unreadable ⇒ start fresh, same posture as model-outcomes.ts
	}
}

/** Read-only: the on-disk doc, or a fresh empty one on missing/corrupt/schema-mismatch. Never throws. */
export function readCostAggregateDoc(stateDir: string): CostAggregateDoc {
	return readRaw(stateDir).doc;
}

/**
 * True when the on-disk doc is missing, corrupt, or schema-mismatched — the caller's cue to run a
 * full-scan rebuild ONCE (`cost-gate.ts`'s `rebuildCostAggregate`). A legitimately new
 * model/tier/lane combo with no data yet is NOT this case — `projectFromCostAggregate` just returns
 * `undefined` for it, cheaply, no rebuild triggered on every cold cell-miss.
 */
export function costAggregateNeedsRebuild(stateDir: string): boolean {
	return !readRaw(stateDir).valid;
}

/** Best-effort persist — a disk failure here must never break the receipt write or land that
 *  triggered it (mirrors `model-outcomes.ts`'s `writeLedger`). */
export function persistCostAggregateDoc(stateDir: string, doc: CostAggregateDoc): void {
	try {
		getStorageBackend().writeDurableSync(docPath(stateDir), JSON.stringify(doc));
	} catch {
		/* best-effort: the receipt/land it derives from must never fail because the cache couldn't write */
	}
}

/** Apply one dated delta to a cell, resetting to a fresh window when the existing cell (if any) has
 *  fully elapsed its `COST_AGGREGATE_WINDOW_MS` as of `now` — see the module doc's "Window" section.
 *  `now` is the EVENT's own timestamp when replaying history (`buildCostAggregateFromReceipts`), or
 *  wall-clock `Date.now()` for a live write (`recordCostAttempt`/`recordCostLanded`) — using the
 *  event's own timestamp both times is what makes a full replay reproduce the exact state a live
 *  incremental process would have reached feeding the same events in the same order. */
function bump(cell: CostAggregateCell | undefined, now: number, delta: { attempts?: number; landed?: number; costUsdSum?: number }): CostAggregateCell {
	const fresh = !cell || now - cell.windowStart >= COST_AGGREGATE_WINDOW_MS;
	const base: CostAggregateCell = fresh ? { attempts: 0, landed: 0, costUsdSum: 0, windowStart: now } : cell;
	return {
		attempts: base.attempts + (delta.attempts ?? 0),
		landed: base.landed + (delta.landed ?? 0),
		costUsdSum: base.costUsdSum + (delta.costUsdSum ?? 0),
		windowStart: base.windowStart,
	};
}

function applyAttemptToDoc(doc: CostAggregateDoc, model: string | undefined, tier: ComplexityTier | undefined, lane: WorkLane | undefined, costUsd: number, now: number): void {
	const laneKey = cellKey(model, tier, lane ?? LANE_AGNOSTIC);
	doc.cells[laneKey] = bump(doc.cells[laneKey], now, { attempts: 1, costUsdSum: costUsd });
	if (lane) {
		// A real lane also feeds the lane-agnostic roll-up (skip when lane is itself absent — that
		// write already targeted the roll-up cell directly above, via the `?? LANE_AGNOSTIC` fallback).
		const rollupKey = cellKey(model, tier, LANE_AGNOSTIC);
		doc.cells[rollupKey] = bump(doc.cells[rollupKey], now, { attempts: 1, costUsdSum: costUsd });
	}
}

function applyLandedToDoc(doc: CostAggregateDoc, model: string | undefined, tier: ComplexityTier | undefined, lane: WorkLane | undefined, now: number): void {
	const laneKey = cellKey(model, tier, lane ?? LANE_AGNOSTIC);
	doc.cells[laneKey] = bump(doc.cells[laneKey], now, { landed: 1 });
	if (lane) {
		const rollupKey = cellKey(model, tier, LANE_AGNOSTIC);
		doc.cells[rollupKey] = bump(doc.cells[rollupKey], now, { landed: 1 });
	}
}

/**
 * Record one cost-bearing attempt (a finalized receipt) for `(model, tier, lane)` AND the
 * lane-agnostic roll-up — synchronous read-modify-write, called from `receipts.ts`'s `appendReceipt`
 * on every receipt write. `tier`/`lane` absent ⇒ bucketed under "unknown"/the roll-up respectively
 * (see the rollout note in the module doc) — never throws internally (`persistCostAggregateDoc` is
 * best-effort), so a caller doesn't need to guard this beyond its own try/catch discipline.
 */
export function recordCostAttempt(stateDir: string, model: string | undefined, tier: ComplexityTier | undefined, lane: WorkLane | undefined, costUsd: number, now = Date.now()): void {
	const doc = readCostAggregateDoc(stateDir);
	applyAttemptToDoc(doc, model, tier, lane, costUsd, now);
	doc.generatedAt = now;
	persistCostAggregateDoc(stateDir, doc);
}

/**
 * Record one LANDED outcome for `(model, tier, lane)` — the counterpart `recordCostAttempt` needs to
 * make `costPerLandedChange` real for a lane-keyed cell. NOT called anywhere in this concern: land
 * outcome is only known at `squad-manager.ts`'s `land()` call site (right beside its existing
 * `recordModelOutcome(this.stateDir, effectiveModel, tierOf(rec.options.thinking), result.ok)` call),
 * which is outside this concern's declared TOUCHES. Exported so that future wire is a single line:
 * `if (result.ok) recordCostLanded(this.stateDir, effectiveModel, tierOf(rec.options.thinking), rec.dto.lane);`
 * Until then every lane-keyed cell's `landed` stays 0, so `projectFromCostAggregate`'s min-sample gate
 * keeps falling back to the lane-agnostic roll-up (fed from the existing `model-outcomes.ts` ledger at
 * rebuild time) — i.e. behavior is unchanged until that wiring exists.
 */
export function recordCostLanded(stateDir: string, model: string | undefined, tier: ComplexityTier | undefined, lane: WorkLane | undefined, now = Date.now()): void {
	const doc = readCostAggregateDoc(stateDir);
	applyLandedToDoc(doc, model, tier, lane, now);
	doc.generatedAt = now;
	persistCostAggregateDoc(stateDir, doc);
}

/**
 * Pure rebuild: replay every receipt (oldest first, so the tumbling window behaves exactly as a live
 * incremental process would) into a fresh doc, then overlay the lane-agnostic roll-up's `landed` from
 * the EXISTING `model-outcomes.ts` ledger (the only real land/reject truth today — see
 * `recordCostLanded`'s doc). No I/O — `cost-gate.ts`'s `rebuildCostAggregate` is the persisted wrapper
 * that fetches `receipts`/`outcomes` and calls this. Kept pure and receipts.ts-independent
 * specifically so `receipts.ts` (which calls `recordCostAttempt`) and this module never import each
 * other (see the module doc).
 */
export function buildCostAggregateFromReceipts(receipts: RunReceipt[], outcomes: ModelOutcomes, now = Date.now()): CostAggregateDoc {
	const doc = emptyDoc(now);
	const sorted = [...receipts].sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
	for (const r of sorted) {
		applyAttemptToDoc(doc, r.model, r.tier, r.lane, r.costUsd ?? 0, r.endedAt ?? r.startedAt);
	}
	for (const [key, counts] of Object.entries(outcomes)) {
		const sep = key.lastIndexOf("::");
		if (sep < 0) continue;
		const model = key.slice(0, sep);
		const tier = key.slice(sep + 2) as ComplexityTier;
		const rollupKey = cellKey(model, tier, LANE_AGNOSTIC);
		const existing = doc.cells[rollupKey];
		// Only attach a landed count where there's cost data to divide it against — a (model,tier) the
		// outcomes ledger knows about but no receipt in this window ever priced has no costUsdSum to
		// pair it with, and `costPerLandedChange` would be undefined for it anyway (see
		// `cellProjection`'s null guard below). The outcomes ledger is ALL-TIME while this doc's
		// attempts are 30-day-windowed, so clamp landed to attempts: an unclamped overlay lets
		// landRate exceed 1.0 and undercounts costPerLandedChange — an under-deny (fail-open) skew
		// once enforce mode reads these cells.
		if (existing) doc.cells[rollupKey] = { ...existing, landed: Math.min(counts.landed ?? 0, existing.attempts) };
	}
	doc.generatedAt = now;
	return doc;
}

export interface CostAggregateProjection {
	sample: number;
	/** landed / attempts for the answering cell; null when the cell has zero attempts (never happens
	 *  for a cell `projectFromCostAggregate` actually returns, since it only returns cells clearing
	 *  `minSample`, but kept nullable for the type's own sake). */
	landRate: number | null;
	/** costUsdSum / landed; null when the cell has zero landed attempts (a real risk today per the
	 *  rollout note — see `recordCostLanded`). */
	costPerLandedChange: number | null;
	/** Which cell answered — logged so a shadow-mode operator can see the fallback ladder fire; never
	 *  itself part of the verdict. */
	source: "lane" | "rollup";
}

/** A cell's derived projection, or `undefined` when absent OR its window has fully elapsed since
 *  `windowStart` (an expired cell reads as absent even with no write to trigger a reset — see the
 *  module doc's "Window" section). */
function cellProjection(cell: CostAggregateCell | undefined, now: number): { sample: number; landRate: number | null; costPerLandedChange: number | null } | undefined {
	if (!cell || now - cell.windowStart >= COST_AGGREGATE_WINDOW_MS) return undefined;
	return {
		sample: cell.attempts,
		landRate: cell.attempts > 0 ? cell.landed / cell.attempts : null,
		costPerLandedChange: cell.landed > 0 ? cell.costUsdSum / cell.landed : null,
	};
}

/**
 * O(1) fast-path projection with DESIGN.md's fallback ladder: the lane-keyed cell first; the
 * lane-agnostic roll-up when the lane cell is below `minSample` (or `lane` is undefined); `undefined`
 * when BOTH are below `minSample` (silent — matches `projectCost`'s existing thin-history posture,
 * never a false verdict off noise).
 */
export function projectFromCostAggregate(
	doc: CostAggregateDoc,
	model: string | undefined,
	tier: ComplexityTier,
	lane: WorkLane | undefined,
	minSample: number,
	now = Date.now(),
): CostAggregateProjection | undefined {
	// A cell only ANSWERS when it can actually price a landed change: costPerLandedChange === null
	// (enough attempts, zero landed — a fresh or all-failing lane) must fall through to the rollup /
	// full-scan rungs, which may hold real landed data projecting over budget. Returning the null
	// cell would short-circuit projectCost and silence the verdict for exactly the burn pattern
	// (money spent, nothing landing) the gate exists to refuse (code-review, CONFIRMED).
	if (lane) {
		const laneCell = cellProjection(doc.cells[cellKey(model, tier, lane)], now);
		if (laneCell && laneCell.sample >= minSample && laneCell.costPerLandedChange !== null) return { ...laneCell, source: "lane" };
	}
	const rollupCell = cellProjection(doc.cells[cellKey(model, tier, LANE_AGNOSTIC)], now);
	if (rollupCell && rollupCell.sample >= minSample && rollupCell.costPerLandedChange !== null) return { ...rollupCell, source: "rollup" };
	return undefined;
}
