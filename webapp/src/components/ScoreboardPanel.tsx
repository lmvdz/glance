/**
 * ScoreboardPanel — the agent-selection rubric, measured. Which model earns its keep, and for
 * which task-class (complexity tier)? Land-rate + $/landed-change per model, joined from the
 * model-outcome ledger and receipt cost (GET /api/graph/scoreboard).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Trophy, RefreshCw } from 'lucide-react';
import { apiJson } from '../lib/api';
import { VerdictBadge } from './ui';
import { pct, usd, rateTone, type Scoreboard, type ComplexityTier } from '../lib/scoreboard';

const TIERS: ComplexityTier[] = ['light', 'mid', 'heavy'];

export const ScoreboardPanel: React.FC = () => {
  const [sb, setSb] = useState<Scoreboard | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSb(await apiJson<Scoreboard>('/api/graph/scoreboard'));
      setError('');
    } catch {
      setError('Could not reach the daemon for the scoreboard.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 30_000);
    return () => clearInterval(iv);
  }, [load]);

  const hasData = sb && (sb.models.length > 0 || sb.harnessSpend.length > 0);

  return (
    <main className="flex h-full flex-1 flex-col overflow-hidden bg-white dark:bg-gray-950">
      <div className="flex flex-shrink-0 items-center gap-3 border-b border-gray-200 px-4 py-2 dark:border-gray-800">
        <Trophy className="h-4 w-4 flex-shrink-0 text-orange-500" aria-hidden="true" />
        <h1 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Model scoreboard</h1>
        <VerdictBadge verdict="healthy">land-rate &amp; $/landed by model</VerdictBadge>
        <button
          onClick={() => void load()}
          className="ml-auto flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-600 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
          title="Refresh"
          aria-label="Refresh scoreboard"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {error && !sb && <div role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</div>}
        {!error && !hasData && (
          <div className="mx-auto max-w-md pt-10 text-center text-sm text-gray-500 dark:text-gray-400">
            No landed work recorded yet. As the fleet lands changes, each model's land-rate and cost-per-landed-change appear here — the measured version of "which model for which task".
          </div>
        )}

        {hasData && (
          <div className="mx-auto flex max-w-4xl flex-col gap-6">
            {/* where the money went */}
            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Spend by harness</h2>
              <div className="flex flex-wrap gap-2">
                {sb!.harnessSpend.map((h) => (
                  <div key={h.harness} className="flex items-baseline gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 dark:border-gray-800 dark:bg-gray-900">
                    <span className="font-mono text-xs font-semibold text-gray-800 dark:text-gray-200">{h.harness}</span>
                    <span className="tabular-nums text-sm font-semibold text-gray-900 dark:text-gray-100">{usd(h.costUsd)}</span>
                    <span className="text-[11px] text-gray-400">{h.runs} runs</span>
                  </div>
                ))}
                <div className="flex items-baseline gap-2 rounded-lg border border-orange-300 bg-orange-50 px-3 py-1.5 dark:border-orange-800 dark:bg-orange-950/30">
                  <span className="font-mono text-xs font-semibold text-orange-700 dark:text-orange-400">total</span>
                  <span className="tabular-nums text-sm font-semibold text-orange-800 dark:text-orange-300">{usd(sb!.totals.totalCostUsd)}</span>
                </div>
              </div>
            </section>

            {/* the rubric: land-rate + $/landed per model, per task-class */}
            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Which model earns its keep <span className="font-normal normal-case text-gray-400">· land-rate per complexity tier, and cost per landed change</span>
              </h2>
              {sb!.models.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">No land outcomes recorded yet — spend is shown above, but no model has landed a change to rank.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead>
                      <tr className="border-b border-gray-200 bg-gray-50 text-left text-[11px] uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
                        <th className="px-3 py-2 font-semibold">Model</th>
                        <th className="px-3 py-2 text-right font-semibold">Land-rate</th>
                        {TIERS.map((t) => (
                          <th key={t} className="px-3 py-2 text-right font-semibold" title={`land-rate on ${t}-complexity tasks`}>{t}</th>
                        ))}
                        <th className="px-3 py-2 text-right font-semibold" title="daemon run cost ÷ landed changes">$/landed</th>
                        <th className="px-3 py-2 text-right font-semibold">Spend</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sb!.models.map((m) => (
                        <tr key={m.model} className="border-b border-gray-100 last:border-0 dark:border-gray-800/60">
                          <td className="px-3 py-2 font-mono text-xs text-gray-800 dark:text-gray-200">{m.model}</td>
                          <td className={`px-3 py-2 text-right font-semibold tabular-nums ${rateTone(m.landRate)}`}>
                            {pct(m.landRate)}
                            <span className="ml-1 text-[10px] font-normal text-gray-400">{m.landed}/{m.landed + m.rejected}</span>
                          </td>
                          {TIERS.map((t) => {
                            const to = m.byTier.find((x) => x.tier === t)!;
                            return (
                              <td key={t} className={`px-3 py-2 text-right tabular-nums ${rateTone(to.landRate)}`} title={`${to.landed} landed / ${to.rejected} rejected`}>
                                {pct(to.landRate)}
                              </td>
                            );
                          })}
                          <td className="px-3 py-2 text-right font-semibold tabular-nums text-gray-900 dark:text-gray-100">{usd(m.costPerLandedChange)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-gray-500 dark:text-gray-400" title={`${m.daemonRuns} daemon runs`}>{usd(m.daemonCostUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-2 text-[11px] text-gray-400 dark:text-gray-600">
                $/landed divides daemon run cost by landed changes; external-harness spend (claude-code, codex, openrouter) is shown above but has no land outcome in glance, so it never distorts a model's cost-per-landed. Land outcomes are fleet-wide.
              </p>
            </section>
          </div>
        )}
      </div>
    </main>
  );
};
