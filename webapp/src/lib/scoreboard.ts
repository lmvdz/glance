/**
 * scoreboard — client mirror of src/attribution-scoreboard.ts (GET /api/graph/scoreboard).
 * Keep in lockstep with the server type.
 */

export type ComplexityTier = 'light' | 'mid' | 'heavy';

export interface TierOutcome {
  tier: ComplexityTier;
  landed: number;
  rejected: number;
  landRate: number | null;
}

export interface ModelScore {
  model: string;
  landed: number;
  rejected: number;
  landRate: number | null;
  byTier: TierOutcome[];
  daemonCostUsd: number;
  daemonRuns: number;
  costPerLandedChange: number | null;
}

export interface HarnessSpend {
  harness: string;
  runs: number;
  costUsd: number;
}

export interface Scoreboard {
  models: ModelScore[];
  harnessSpend: HarnessSpend[];
  totals: { landed: number; rejected: number; daemonCostUsd: number; totalCostUsd: number };
}

export const pct = (r: number | null): string => (r == null ? '—' : `${Math.round(r * 100)}%`);
export const usd = (n: number | null): string => (n == null ? '—' : n >= 100 ? `$${Math.round(n)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);

/** Tone for a land-rate: good ≥0.75, warn ≥0.5, else bad; muted when unknown. */
export function rateTone(r: number | null): string {
  if (r == null) return 'text-gray-400 dark:text-gray-600';
  if (r >= 0.75) return 'text-emerald-600 dark:text-emerald-400';
  if (r >= 0.5) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}
