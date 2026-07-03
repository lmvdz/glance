/**
 * rates — published per-token API pricing by model family, for API-EQUIVALENT
 * cost estimates. Used when a ledger has token counts but no cost (external
 * harness ingests like Claude Code); daemon receipts keep their exact costUsd.
 *
 * Prices are $/MTok. Cache reads bill at 10% of input, cache writes at 125%
 * (Anthropic's published ratios). Estimates, clearly labelled as such — the
 * plan-worth verdict only needs the right order of magnitude.
 */

import { modelFamily } from "./attribution.ts";

export interface Rate {
	in: number;
	out: number;
}

/** $/MTok by model family (input, output). */
export const RATES: Record<string, Rate> = {
	fable: { in: 25, out: 125 },
	opus: { in: 15, out: 75 },
	sonnet: { in: 3, out: 15 },
	haiku: { in: 0.8, out: 4 },
	openai: { in: 5, out: 20 },
	gemini: { in: 2.5, out: 15 },
	other: { in: 5, out: 25 },
	unknown: { in: 5, out: 25 },
};

export interface TokenCounts {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** API-equivalent dollars for one usage block of a given model. */
export function estimateCost(model: string | undefined, t: TokenCounts): number {
	const r = RATES[modelFamily(model)] ?? RATES.unknown;
	const M = 1_000_000;
	return (t.input / M) * r.in + (t.output / M) * r.out + (t.cacheRead / M) * r.in * 0.1 + (t.cacheWrite / M) * r.in * 1.25;
}
