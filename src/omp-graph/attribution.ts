/**
 * attribution — the harness→model spend hierarchy behind the FLEET PULSE bands.
 *
 * Every run is a harness driving a model, and the dollars bill to the model's
 * per-token pricing; the model view and the harness view are MARGINALS of one
 * matrix, never two independent dimensions. This module reduces raw receipts to
 * that matrix at a fixed bin width, plus the subscription-worth verdict
 * (API-equivalent spend ÷ pro-rated plan cost).
 *
 * Pure (receipts + range in, doc out) so tests drive it without a daemon.
 */

import type { RunReceipt } from "../types.ts";
import type { TimeRange } from "./schema.ts";
import { HOUR_MS, inRange } from "./schema.ts";

export interface PlanWorth {
	name: string;
	monthly: number;
	/** Plan cost pro-rated to the doc's range. */
	prorated: number;
	/** API-equivalent spend in range ÷ prorated plan cost. */
	worth: number;
}

export interface AttributionDoc {
	range: TimeRange;
	binMs: number;
	/** Family keys present, ordered by total spend desc. */
	models: string[];
	harnesses: string[];
	/** $ per bin, aligned to range.start. */
	byModel: Record<string, number[]>;
	byHarness: Record<string, number[]>;
	/** harness → model → total $ over the range. */
	matrix: Record<string, Record<string, number>>;
	totalCost: number;
	plan?: PlanWorth;
	generatedAt: number;
}

/** Collapse a raw model id to a comparable family key. NOTE: `src/model-lineage.ts` `modelLineage()`
 *  is built on top of this — the coarser VENDOR grain of the same mapping. Keep them in sync; a new
 *  family added here must get a lineage there (a test enforces it). */
export function modelFamily(model?: string): string {
	const m = (model ?? "").toLowerCase();
	if (m.includes("fable") || m.includes("mythos")) return "fable";
	if (m.includes("opus")) return "opus";
	if (m.includes("sonnet")) return "sonnet";
	if (m.includes("haiku")) return "haiku";
	if (m.includes("gpt") || m.includes("codex") || /\bo[34]\b/.test(m)) return "openai";
	if (m.includes("gemini")) return "gemini";
	return m ? "other" : "unknown";
}

/** The plan config, from env. Absent monthly ⇒ no subscription ⇒ no verdict. */
export function planFromEnv(env: Record<string, string | undefined> = process.env): { name: string; monthly: number } | undefined {
	const monthly = Number(env.OMP_SQUAD_PLAN_MONTHLY);
	if (!Number.isFinite(monthly) || monthly <= 0) return undefined;
	return { name: env.OMP_SQUAD_PLAN_NAME || "subscription", monthly };
}

const MONTH_MS = (365.25 / 12) * 24 * 3_600_000;

export function buildAttribution(
	receipts: RunReceipt[],
	range: TimeRange,
	opts: { binMs?: number; plan?: { name: string; monthly: number }; now?: number } = {},
): AttributionDoc {
	const binMs = opts.binMs ?? HOUR_MS;
	const n = Math.max(1, Math.ceil((range.end - range.start) / binMs));
	const byModel: Record<string, number[]> = {};
	const byHarness: Record<string, number[]> = {};
	const matrix: Record<string, Record<string, number>> = {};
	let totalCost = 0;

	const bins = (rec: Record<string, number[]>, key: string): number[] => (rec[key] ??= new Array<number>(n).fill(0));

	for (const r of receipts) {
		const cost = r.costUsd ?? 0;
		if (cost <= 0) continue;
		const at = r.endedAt ?? r.startedAt; // same convention as the receipts adapter's $/hr
		if (!inRange(at, range)) continue;
		const i = Math.min(n - 1, Math.floor((at - range.start) / binMs));
		const model = modelFamily(r.model);
		const harness = r.harness || "omp";
		bins(byModel, model)[i] += cost;
		bins(byHarness, harness)[i] += cost;
		((matrix[harness] ??= {})[model] ??= 0);
		matrix[harness][model] += cost;
		totalCost += cost;
	}

	const totalsOf = (rec: Record<string, number[]>): [string, number][] =>
		Object.entries(rec)
			.map(([k, arr]) => [k, arr.reduce((a, b) => a + b, 0)] as [string, number])
			.sort((a, b) => b[1] - a[1]);

	let plan: PlanWorth | undefined;
	const cfg = opts.plan;
	if (cfg) {
		// worth compares against the plan pro-rated to the ELAPSED part of the range
		const now = opts.now ?? Date.now();
		const elapsed = Math.max(binMs, Math.min(range.end, now) - range.start);
		const prorated = cfg.monthly * (elapsed / MONTH_MS);
		plan = { name: cfg.name, monthly: cfg.monthly, prorated, worth: prorated > 0 ? totalCost / prorated : 0 };
	}

	return {
		range,
		binMs,
		models: totalsOf(byModel).map(([k]) => k),
		harnesses: totalsOf(byHarness).map(([k]) => k),
		byModel,
		byHarness,
		matrix,
		totalCost,
		plan,
		generatedAt: opts.now ?? Date.now(),
	};
}
