/**
 * Pre-execution cost projection (plans/policy-and-cost-gates/ concern C-COST, research #3).
 *
 * Today cost is post-hoc (receipts/scoreboard). This projects a unit's expected $/landed-change BEFORE
 * it spawns, from the SAME history the scoreboard already computes, and — in v1 — only WARNS (shadow).
 * Enforce mode (a hard park/deny) is deliberately deferred: it needs an O(1) $ ledger, and `readAll-
 * Receipts` is an async full scan, so v1 keeps the projection opt-in and off the blocking path.
 *
 * adw-factory-borrows concern 08 closes that deferral's prerequisite: `projectCost` now has an O(1)
 * fast path over `cost-aggregate.ts`'s lane-keyed rolling doc (`(model, tier, lane)`, with a
 * lane-agnostic fallback per DESIGN.md), falling back to the ORIGINAL full-scan computation below
 * unchanged whenever the aggregate can't yet answer (cold cache, thin sample) — so this concern makes
 * NO behavior change to verdicts, only a new data shape underneath (same shadow posture; enforce
 * itself is a later concern's flip).
 *
 * adw-factory-borrows concern 09 closes THAT deferral: `costGateVerdict` now takes an optional `lane`
 * and, when given one, reads `LANE_POLICY[lane].costCeilingUsd`/`costAction` VERBATIM as the verdict's
 * ceiling and action — the lane's own row is the single source of truth for how far a verdict may
 * escalate (v1 rollout, DESIGN.md: only "chore" is "deny"; "hotfix"/"feature" stay "shadow", so they
 * never surface as ask/deny even over 2x budget). A lane-LESS call keeps the ORIGINAL severity-only
 * heuristic (over 2x budget ⇒ deny) for backward compatibility with any caller that hasn't threaded a
 * lane through yet. `squad-manager.ts`'s `createWithId` is where this actually enforces: a "deny"
 * verdict under `OMP_SQUAD_COST_GATE=enforce` refuses the spawn; an "ask" verdict stages the SAME
 * "Needs you" attention lane a landConfirm-held unit uses; "shadow" (or the gate off/shadow globally)
 * only ever logs — never blocks.
 *
 * `laneAppliesPrivilege` (mirroring `model-route.ts`'s `modelRouteMinEdgeFor`/`modelRouteShouldApply`
 * clamp, review follow-up on this same concern): a label/classifier-sourced lane (`false`) may only
 * move the cost axis STRICTER than `LANE_POLICY.feature`'s row, never looser — DESIGN.md's "label/
 * classifier lanes may only move privilege axes in shadow or stricter". Today this is a coincidence
 * (feature is the loosest row already), not a construction; the clamp makes it one, so a future lane
 * row looser than feature's can never become purchasable by the word "urgent" in ticket text. An
 * operator-sourced lane (`true`, the default — every EXISTING caller that hasn't threaded lane source
 * is trusted, matching `costGateVerdict`'s pre-clamp signature) applies its row verbatim.
 *
 * Two guards keep a noisy signal quiet: no verdict below `OMP_SQUAD_COST_MIN_SAMPLE` attempts (thin
 * history stays silent), and no verdict at all unless a ceiling is set — the lane's own
 * `costCeilingUsd`, or the operator's global `OMP_SQUAD_COST_MAX_PER_CHANGE` (> 0) when the lane has
 * none. Default `OMP_SQUAD_COST_GATE=off` ⇒ nothing runs.
 */

import { buildScoreboard } from "./attribution-scoreboard.ts";
import { envInt, envNumber } from "./config.ts";
import { errText } from "./err-text.ts";
import { type ComplexityTier, modelFamily, modelOutcomes, readModelOutcomes } from "./model-outcomes.ts";
import { readAllReceipts } from "./receipts.ts";
import { LANE_POLICY, type WorkLane } from "./lane.ts";
import {
	buildCostAggregateFromReceipts,
	costAggregateNeedsRebuild,
	type CostAggregateDoc,
	persistCostAggregateDoc,
	projectFromCostAggregate,
	readCostAggregateDoc,
} from "./cost-aggregate.ts";

export type CostGateMode = "off" | "shadow" | "enforce";

/** off (default) | shadow (log only) | enforce (reserved — treated as shadow in v1; hard block deferred). */
export function costGateMode(): CostGateMode {
	const m = process.env.OMP_SQUAD_COST_GATE;
	return m === "shadow" || m === "enforce" ? m : "off";
}

export interface CostProjection {
	model: string;
	tier: ComplexityTier;
	/** landed + rejected attempts for this (model, tier) — the confidence in the projection. */
	sample: number;
	/** land-rate for this (model, tier), or the model overall; null when no attempts. */
	landRate: number | null;
	/** $ per landed change for this model's daemon runs; null when nothing has landed yet. */
	costPerLandedChange: number | null;
}

/**
 * Full-scan rebuild wrapper (adw-factory-borrows concern 08): fetch receipts + the model-outcomes
 * ledger, replay them through `cost-aggregate.ts`'s pure builder, and persist the result. Invoked from
 * `projectCost`'s fast path on first run or schema-version mismatch (`costAggregateNeedsRebuild`) —
 * receipts remain the source of truth; the aggregate doc is a derived cache, corruption-safe by
 * rebuild. Lives here (not in cost-aggregate.ts) so that module stays receipts.ts-independent (see
 * its module doc — avoids an import cycle with `receipts.ts`'s own `recordCostAttempt` call).
 */
export async function rebuildCostAggregate(stateDir: string): Promise<CostAggregateDoc> {
	const receipts = await readAllReceipts(stateDir);
	const doc = buildCostAggregateFromReceipts(receipts, readModelOutcomes(stateDir));
	persistCostAggregateDoc(stateDir, doc);
	return doc;
}

/** Project the expected cost/land-rate for a (model, tier[, lane]) from existing history. Never throws. */
export async function projectCost(stateDir: string, model: string | undefined, tier: ComplexityTier, lane?: WorkLane): Promise<CostProjection> {
	const oc = modelOutcomes(stateDir, model, tier);
	const sample = oc.landed + oc.rejected;
	let landRate: number | null = oc.landed + oc.rejected > 0 ? oc.landed / (oc.landed + oc.rejected) : null;
	let costPerLandedChange: number | null = null;
	try {
		const minSample = envInt("OMP_SQUAD_COST_MIN_SAMPLE", 5);
		const doc = costAggregateNeedsRebuild(stateDir) ? await rebuildCostAggregate(stateDir) : readCostAggregateDoc(stateDir);
		const fast = projectFromCostAggregate(doc, model, tier, lane, minSample);
		if (fast) {
			return { model: model ?? "unknown", tier, sample: fast.sample, landRate: fast.landRate ?? landRate, costPerLandedChange: fast.costPerLandedChange };
		}
		// Fast path missed (aggregate present but too thin for either the lane-keyed or lane-agnostic
		// cell) — fall back to the ORIGINAL full-scan computation, unchanged, so a thin aggregate never
		// silently regresses a verdict the old path could already make.
		const board = buildScoreboard(await readAllReceipts(stateDir), readModelOutcomes(stateDir));
		const key = modelFamily(model);
		const score = board.models.find((m) => modelFamily(m.model) === key);
		if (score) {
			costPerLandedChange = score.costPerLandedChange;
			landRate = score.byTier.find((t) => t.tier === tier)?.landRate ?? landRate ?? score.landRate;
		}
	} catch {
		/* projection is best-effort — a ledger read failure just leaves cost null (silent) */
	}
	return { model: model ?? "unknown", tier, sample, landRate, costPerLandedChange };
}

export interface CostVerdict {
	action: "shadow" | "ask" | "deny";
	line: string;
}

/** Ordinal severity of a `CostVerdict.action`, loosest→strictest — the privilege clamp's comparison
 *  axis (see `costGateVerdict`'s `laneAppliesPrivilege` doc above). */
const ACTION_RANK: Record<CostVerdict["action"], number> = { shadow: 0, ask: 1, deny: 2 };

/**
 * Pure decision from a projection + config. `undefined` (silent) when: no ceiling configured, thin
 * history (< min sample), or no cost data / under budget.
 *
 * With a `lane`, the ceiling and the action both come from `LANE_POLICY[lane]` VERBATIM — the lane's
 * `costCeilingUsd` (falling back to the operator's global `OMP_SQUAD_COST_MAX_PER_CHANGE` when the
 * lane sets none, e.g. hotfix/feature today) and its `costAction` ("shadow" | "ask" | "deny") AS THE
 * VERDICT'S ACTION, not re-derived from the dollar amount — a lane whose row says "shadow" can never
 * surface as ask/deny here no matter how far over budget it runs (v1 rollout, DESIGN.md: only
 * "chore" is "deny"). Without a `lane` (a caller that hasn't threaded one), the ORIGINAL severity-only
 * heuristic applies: over 2× budget ⇒ "deny", else "ask".
 *
 * `laneAppliesPrivilege` (default `true`, see module doc): when `false` (a label/classifier-sourced
 * lane), the lane's row is clamped to never move LOOSER than `LANE_POLICY.feature`'s — a lane-defined
 * ceiling above the operator's global `OMP_SQUAD_COST_MAX_PER_CHANGE` is capped to the global, and an
 * action below feature's own (there is none today; feature already sits at the loosest "shadow") is
 * raised to feature's. Moving STRICTER on ticket text alone (e.g. classifier-resolved "chore" ⇒
 * "deny") is exactly what DESIGN.md allows and stays untouched.
 *
 * In v1 the caller decides whether to act: `costGateMode() !== "enforce"` ⇒ log only, never block.
 */
export function costGateVerdict(p: CostProjection, lane?: WorkLane, laneAppliesPrivilege = true): CostVerdict | undefined {
	const policy = lane ? LANE_POLICY[lane] : undefined;
	const globalBudget = envNumber("OMP_SQUAD_COST_MAX_PER_CHANGE", 0); // 0 ⇒ operator has no global ceiling
	let budget = policy?.costCeilingUsd ?? globalBudget;
	if (policy?.costCeilingUsd !== undefined && !laneAppliesPrivilege && globalBudget > 0) {
		// Clamp: a non-privileged lane's own ceiling may only make the budget STRICTER than the global,
		// never looser — a lane row with no override already falls back to `globalBudget` above, so this
		// only ever narrows a lane-defined ceiling down, never widens one.
		budget = Math.min(budget, globalBudget);
	}
	if (budget <= 0) return undefined;
	if (p.sample < envInt("OMP_SQUAD_COST_MIN_SAMPLE", 5)) return undefined;
	if (p.costPerLandedChange == null || p.costPerLandedChange <= budget) return undefined;
	let action: CostVerdict["action"] = policy ? policy.costAction : p.costPerLandedChange > budget * 2 ? "deny" : "ask";
	if (policy && !laneAppliesPrivilege) {
		const featureAction = LANE_POLICY.feature.costAction;
		if (ACTION_RANK[action] < ACTION_RANK[featureAction]) action = featureAction; // never looser than feature
	}
	const pct = p.landRate == null ? "?" : `${Math.round(p.landRate * 100)}%`;
	const line = `cost-gate(${costGateMode()}): ${p.model}/${p.tier}${lane ? `/${lane}` : ""} projects $${p.costPerLandedChange.toFixed(2)}/landed-change (land-rate ${pct}, n=${p.sample}) — over budget $${budget.toFixed(2)}; would ${action.toUpperCase()}`;
	return { action, line };
}

/** Cost-gate entry point (both shadow AND enforce): project + resolve a lane-aware verdict, logging
 *  it whenever it fires (shadow visibility persists even under `enforce` — the operator still sees
 *  the line the moment it would act). No-op (never logs, returns `undefined`) when the gate is off.
 *  Never throws.
 *
 *  `laneAppliesPrivilege` (default `true`) threads straight through to `costGateVerdict`'s clamp — see
 *  its doc. Pass the caller's own privilege-clamp result (`squad-manager.ts`'s `laneAppliesPrivilege`)
 *  when calling with a label/classifier-sourced lane.
 *
 *  Safe to fire-and-forget (`void shadowCostCheck(...)`, optionally `.then(...)` to observe the
 *  verdict) for shadow/off mode, since the return value is inert without an enforce decision at the
 *  call site — but an ENFORCE-mode caller (`squad-manager.ts`'s `createWithId`) MUST `await` it: a
 *  "deny" verdict is what refuses the spawn.
 *
 *  On a projection/read failure the catch below logs a `cost-gate: check failed` line (via the SAME
 *  `log` callback verdicts use) before returning `undefined` — a corrupt/unreadable cost aggregate
 *  under `OMP_SQUAD_COST_GATE=enforce` must never look identical to "the gate judged this fine": the
 *  operator needs to be able to tell "no signal fired" apart from "the check itself couldn't run".
 *  Still never throws and never blocks the spawn either way — "shadow check must never affect a
 *  spawn" is preserved; only the SILENCE around a failure is fixed. */
export async function shadowCostCheck(stateDir: string, model: string | undefined, tier: ComplexityTier, log: (line: string) => void, lane?: WorkLane, laneAppliesPrivilege = true): Promise<CostVerdict | undefined> {
	if (costGateMode() === "off") return undefined;
	try {
		const verdict = costGateVerdict(await projectCost(stateDir, model, tier, lane), lane, laneAppliesPrivilege);
		if (verdict) log(verdict.line);
		return verdict;
	} catch (err) {
		log(`cost-gate(${costGateMode()}): check failed (non-fatal, spawn unaffected) — ${errText(err)}`);
		return undefined;
	}
}

/**
 * Whether `OMP_SQUAD_COST_GATE=enforce` has ANY usable signal to verdict on — `glance doctor`'s
 * config-posture check (adw-factory-borrows concern 09, red-team S1: "the fail-soft env-JSON hazard
 * is gone by construction; the only env inputs here are the existing cost-gate vars — validate them
 * loudly at boot"). `enforce` with no cell clearing `OMP_SQUAD_COST_MIN_SAMPLE` anywhere is armed but
 * SILENTLY inert (every verdict comes back `undefined`) — indistinguishable from `off` at the
 * operator's chair without this. True as soon as EITHER ledger (the O(1) cost aggregate, concern 08,
 * or the legacy model-outcomes ledger `projectCost`'s full-scan fallback reads) has one cell past the
 * sample floor. Never throws (mirrors every other probe in this module — a diagnostic must not die on
 * the thing it is diagnosing). */
export async function costGateAggregateReady(stateDir: string): Promise<boolean> {
	try {
		const minSample = envInt("OMP_SQUAD_COST_MIN_SAMPLE", 5);
		const doc = costAggregateNeedsRebuild(stateDir) ? await rebuildCostAggregate(stateDir) : readCostAggregateDoc(stateDir);
		if (Object.values(doc.cells).some((c) => c.attempts >= minSample)) return true;
		const outcomes = readModelOutcomes(stateDir);
		return Object.values(outcomes).some((c) => (c.landed ?? 0) + (c.rejected ?? 0) >= minSample);
	} catch {
		return false;
	}
}
