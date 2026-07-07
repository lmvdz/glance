/**
 * Pre-execution cost projection (plans/policy-and-cost-gates/ concern C-COST, research #3).
 *
 * Today cost is post-hoc (receipts/scoreboard). This projects a unit's expected $/landed-change BEFORE
 * it spawns, from the SAME history the scoreboard already computes, and — in v1 — only WARNS (shadow).
 * Enforce mode (a hard park/deny) is deliberately deferred: it needs an O(1) $ ledger, and `readAll-
 * Receipts` is an async full scan, so v1 keeps the projection opt-in and off the blocking path.
 *
 * Two guards keep a noisy signal quiet: no verdict below `OMP_SQUAD_COST_MIN_SAMPLE` attempts (thin
 * history stays silent), and no verdict at all unless the operator set a ceiling `OMP_SQUAD_COST_MAX_
 * PER_CHANGE` (> 0). Default `OMP_SQUAD_COST_GATE=off` ⇒ nothing runs.
 */

import { buildScoreboard } from "./attribution-scoreboard.ts";
import { envInt, envNumber } from "./config.ts";
import { type ComplexityTier, modelFamily, modelOutcomes, readModelOutcomes } from "./model-outcomes.ts";
import { readAllReceipts } from "./receipts.ts";

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

/** Project the expected cost/land-rate for a (model, tier) from existing history. Never throws. */
export async function projectCost(stateDir: string, model: string | undefined, tier: ComplexityTier): Promise<CostProjection> {
	const oc = modelOutcomes(stateDir, model, tier);
	const sample = oc.landed + oc.rejected;
	let landRate: number | null = oc.landed + oc.rejected > 0 ? oc.landed / (oc.landed + oc.rejected) : null;
	let costPerLandedChange: number | null = null;
	try {
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
	action: "ask" | "deny";
	line: string;
}

/**
 * Pure decision from a projection + config. `undefined` (silent) when: no ceiling configured, thin
 * history (< min sample), or no cost data / under budget. Over 2× budget ⇒ "deny", else "ask". In v1
 * the caller only LOGS this line (shadow) — it never blocks.
 */
export function costGateVerdict(p: CostProjection): CostVerdict | undefined {
	const budget = envNumber("OMP_SQUAD_COST_MAX_PER_CHANGE", 0); // 0 ⇒ operator set no ceiling ⇒ silent
	if (budget <= 0) return undefined;
	if (p.sample < envInt("OMP_SQUAD_COST_MIN_SAMPLE", 5)) return undefined;
	if (p.costPerLandedChange == null || p.costPerLandedChange <= budget) return undefined;
	const action: "ask" | "deny" = p.costPerLandedChange > budget * 2 ? "deny" : "ask";
	const pct = p.landRate == null ? "?" : `${Math.round(p.landRate * 100)}%`;
	const line = `cost-gate(${costGateMode()}): ${p.model}/${p.tier} projects $${p.costPerLandedChange.toFixed(2)}/landed-change (land-rate ${pct}, n=${p.sample}) — over budget $${budget.toFixed(2)}; would ${action.toUpperCase()}`;
	return { action, line };
}

/** Shadow entry point for the caller: project + emit a warn line if the gate would fire. Fire-and-
 *  forget safe (never throws, never blocks); no-op unless the gate is on. */
export async function shadowCostCheck(stateDir: string, model: string | undefined, tier: ComplexityTier, log: (line: string) => void): Promise<void> {
	if (costGateMode() === "off") return;
	try {
		const verdict = costGateVerdict(await projectCost(stateDir, model, tier));
		if (verdict) log(verdict.line);
	} catch {
		/* shadow check must never affect a spawn */
	}
}
