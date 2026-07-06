/**
 * attribution-scoreboard — the "which model earns its keep, for which task-class" join.
 *
 * The agent-selection rubric needs to be MEASURED, not guessed. Two ledgers already
 * hold the ground truth:
 *  - model-outcomes (`${model}::${tier}` → {landed, rejected}, src/model-outcomes.ts):
 *    land-rate per model per complexity TIER (light/mid/heavy — the task-class axis,
 *    bucketed from thinking level). Recorded at every daemon land.
 *  - receipts (RunReceipt[]): real cost per model, now spanning every harness (omp +
 *    the ingested external ones).
 *
 * This composes them into per-model rows: land-rate (overall + per tier) and
 * $/landed-change. $/landed-change joins DAEMON cost (the runs that actually flow
 * through glance's land pipeline) with daemon lands — external-harness spend has no
 * land outcome in glance, so it is reported separately as context, never divided into
 * a land-rate it can't have. Pure: caller supplies both ledgers, this does the math.
 */

import type { RunReceipt } from "./types.ts";
import { modelKey, tierOf, type ComplexityTier, type ModelOutcomes } from "./model-outcomes.ts";

const TIERS: ComplexityTier[] = ["light", "mid", "heavy"];
/** A receipt is glance-native (flows through the land pipeline) when it has no external harness. */
const isDaemon = (r: RunReceipt): boolean => !r.harness || r.harness === "omp";

export interface TierOutcome {
	tier: ComplexityTier;
	landed: number;
	rejected: number;
	/** landed / (landed + rejected); null when no attempts. */
	landRate: number | null;
}

export interface ModelScore {
	model: string;
	landed: number;
	rejected: number;
	landRate: number | null;
	byTier: TierOutcome[];
	/** cost of DAEMON runs on this model (the ones that can land through glance). */
	daemonCostUsd: number;
	daemonRuns: number;
	/** daemonCostUsd / landed; null when nothing landed yet. */
	costPerLandedChange: number | null;
}

export interface HarnessSpend {
	harness: string;
	runs: number;
	costUsd: number;
}

export interface Scoreboard {
	/** one row per model that has an outcome record OR daemon receipts, ranked by lands desc. */
	models: ModelScore[];
	/** total spend by harness across ALL receipts — the "where did the money go" context. */
	harnessSpend: HarnessSpend[];
	totals: { landed: number; rejected: number; daemonCostUsd: number; totalCostUsd: number };
}

const rate = (landed: number, rejected: number): number | null => (landed + rejected > 0 ? landed / (landed + rejected) : null);

/** Compose the model-outcome ledger and receipts into the scoreboard. Pure. */
export function buildScoreboard(receipts: RunReceipt[], outcomes: ModelOutcomes): Scoreboard {
	// daemon cost + run count per normalized model
	const daemon = new Map<string, { cost: number; runs: number }>();
	const harness = new Map<string, { cost: number; runs: number }>();
	for (const r of receipts) {
		const cost = r.costUsd ?? 0;
		const h = r.harness || "omp";
		const he = harness.get(h) ?? { cost: 0, runs: 0 };
		he.cost += cost;
		he.runs += 1;
		harness.set(h, he);
		if (isDaemon(r)) {
			const k = modelKey(r.model);
			const de = daemon.get(k) ?? { cost: 0, runs: 0 };
			de.cost += cost;
			de.runs += 1;
			daemon.set(k, de);
		}
	}

	// outcomes, folded per model across tiers
	const perModelTier = new Map<string, Map<ComplexityTier, { landed: number; rejected: number }>>();
	for (const [key, counts] of Object.entries(outcomes)) {
		const sep = key.lastIndexOf("::");
		if (sep < 0) continue;
		const model = key.slice(0, sep);
		const tier = key.slice(sep + 2) as ComplexityTier;
		if (!TIERS.includes(tier)) continue;
		const m = perModelTier.get(model) ?? new Map();
		m.set(tier, { landed: counts.landed ?? 0, rejected: counts.rejected ?? 0 });
		perModelTier.set(model, m);
	}

	const modelSet = new Set<string>([...perModelTier.keys(), ...daemon.keys()]);
	const models: ModelScore[] = [];
	for (const model of modelSet) {
		const tiers = perModelTier.get(model) ?? new Map<ComplexityTier, { landed: number; rejected: number }>();
		const byTier: TierOutcome[] = TIERS.map((tier) => {
			const c = tiers.get(tier) ?? { landed: 0, rejected: 0 };
			return { tier, landed: c.landed, rejected: c.rejected, landRate: rate(c.landed, c.rejected) };
		});
		const landed = byTier.reduce((s, t) => s + t.landed, 0);
		const rejected = byTier.reduce((s, t) => s + t.rejected, 0);
		const d = daemon.get(model) ?? { cost: 0, runs: 0 };
		models.push({
			model,
			landed,
			rejected,
			landRate: rate(landed, rejected),
			byTier,
			daemonCostUsd: d.cost,
			daemonRuns: d.runs,
			// null (unknown), not 0, when we have no daemon receipts to price the lands against.
			costPerLandedChange: landed > 0 && d.runs > 0 ? d.cost / landed : null,
		});
	}
	models.sort((a, b) => b.landed - a.landed || b.daemonCostUsd - a.daemonCostUsd || a.model.localeCompare(b.model));

	const harnessSpend: HarnessSpend[] = [...harness.entries()]
		.map(([h, v]) => ({ harness: h, runs: v.runs, costUsd: v.cost }))
		.sort((a, b) => b.costUsd - a.costUsd);

	const totals = {
		landed: models.reduce((s, m) => s + m.landed, 0),
		rejected: models.reduce((s, m) => s + m.rejected, 0),
		daemonCostUsd: [...daemon.values()].reduce((s, d) => s + d.cost, 0),
		totalCostUsd: harnessSpend.reduce((s, h) => s + h.costUsd, 0),
	};

	return { models, harnessSpend, totals };
}

export { tierOf };
