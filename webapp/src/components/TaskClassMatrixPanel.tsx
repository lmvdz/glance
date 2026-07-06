/**
 * TaskClassMatrixPanel — the "task-class × model" outcome scoreboard (model-routing-control-loop
 * concern 05, GET /api/graph/task-class).
 *
 * THIS PANEL IS OBSERVATIONAL, NOT A DECISION ORACLE. Every row is grouped by a choice the router
 * already made — the routing tier/mode a unit was dispatched with — so a difference between two
 * model columns could just as easily reflect which kind of task each model was HANDED as any real
 * difference between the models. The honesty label below is not decoration; it is the thing that
 * makes shipping this scoreboard before a real causal signal exists (DESIGN.md's deferred D1,
 * randomized exploration) defensible at all. Do not remove or bury it.
 *
 * Layout, top to bottom:
 *   1. Mandatory non-causal label (Callout, tone="info") — always visible, never collapsed.
 *   2. Controls — time range (wired to /api/graph/task-class?days=).
 *   3. The matrix — rows = task classes (routing mode:tier), columns = model families. Each cell
 *      shows merge-rate% (n), with median-cost + coverage% and median-confidence as a sub-line.
 *      Cells below the server's minSamples gate render "insufficient data", grayed, never a
 *      misleading 100%/0%.
 *   4. Raw payload — collapsed <details> for power users, matching HeatPanel's convention.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Table2, RefreshCw } from 'lucide-react';
import { apiJson } from '../lib/api';
import type { TaskClassCell, TaskClassMatrixPayload } from '../lib/insights';
import { PanelShell, Callout, SectionCard } from './ui';

const RANGES = [7, 14, 30] as const;

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** One matrix cell — grayed + "insufficient data" below the sample gate, otherwise the merge-rate
 *  headline plus a compact sub-line of the coverage-qualified cost and confidence. */
const MatrixCell: React.FC<{ cell: TaskClassCell }> = ({ cell }) => {
  if (cell.insufficientData) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-0.5 rounded-md bg-gray-50 dark:bg-gray-800/40 px-2 py-2 text-center opacity-60" title={`n=${cell.n} — below the minimum sample size`}>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">insufficient data</span>
        <span className="text-[10px] text-gray-400">n={cell.n}</span>
      </div>
    );
  }

  const costLabel = cell.medianCostUsd !== undefined
    ? `$${cell.medianCostUsd.toFixed(2)} (${Math.round(cell.costCoveragePct * 100)}% cov.)`
    : cell.nWithCost === 0
    ? 'no cost data'
    : undefined;
  const confLabel = cell.medianConfidence !== undefined ? `conf ${Math.round(cell.medianConfidence * 100)}%` : undefined;
  const reworkLabel = cell.inRunReworkRate !== undefined ? `in-run rework ${pct(cell.inRunReworkRate)}` : undefined;

  const title = [
    `${cell.landed}/${cell.n} landed`,
    costLabel ? `median cost ${costLabel}` : undefined,
    confLabel,
    reworkLabel,
  ].filter(Boolean).join(' · ');

  return (
    <div className="flex h-full flex-col items-center justify-center gap-0.5 rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-2 py-2 text-center" title={title}>
      <span className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">
        {pct(cell.mergeRate)} <span className="text-[10px] font-normal text-gray-400">(n={cell.n})</span>
      </span>
      {costLabel && <span className="text-[10px] text-gray-500 dark:text-gray-400">{costLabel}</span>}
      {(confLabel || reworkLabel) && (
        <span className="text-[10px] text-gray-400 dark:text-gray-500">{[confLabel, reworkLabel].filter(Boolean).join(' · ')}</span>
      )}
    </div>
  );
};

export const TaskClassMatrixPanel: React.FC = () => {
  const [days, setDays] = useState<(typeof RANGES)[number]>(14);
  const [doc, setDoc] = useState<TaskClassMatrixPayload | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await apiJson<TaskClassMatrixPayload>(`/api/graph/task-class?days=${days}`);
      setDoc(d);
      setError('');
    } catch {
      setError('Could not reach the daemon for the task-class matrix.');
    } finally {
      setLoaded(true);
    }
  }, [days]);

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 10_000);
    return () => clearInterval(iv);
  }, [load]);

  const refresh = (
    <button
      onClick={() => void load()}
      className="flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-600 dark:text-gray-300 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
      title="Refresh"
      aria-label="Refresh task-class matrix"
    >
      <RefreshCw className="h-3 w-3" aria-hidden="true" />
    </button>
  );

  return (
    <PanelShell
      icon={<Table2 className="h-4 w-4 text-sky-500" aria-hidden="true" />}
      title="Task-class × model"
      subtitle={doc ? `${doc.totalLanded}/${doc.totalUnits} landed across ${doc.taskClasses.length} task class${doc.taskClasses.length === 1 ? '' : 'es'} × ${doc.models.length} model${doc.models.length === 1 ? '' : 's'}` : undefined}
      actions={refresh}
    >
      {/* MANDATORY honesty label — always visible, never collapsed or buried in a tooltip. */}
      <Callout tone="info" title="Observational — not a causal comparison of models">
        Rows are grouped by the router's own choices (the routing tier/mode a unit was dispatched with), not by a randomized
        assignment. A difference between model columns may reflect which kind of task each model was handed, not a real
        difference between the models. Rework below is <strong>in-run</strong> churn (retries before the agent's own land
        attempt) — there is no post-merge regression signal in this codebase today.
      </Callout>

      {!loaded && !error && (
        <div className="space-y-3 animate-pulse" aria-label="Loading task-class matrix">
          {[1, 2, 3].map((nn) => (
            <div key={nn} className="h-12 rounded-lg bg-gray-100 dark:bg-gray-800" />
          ))}
        </div>
      )}

      {loaded && error && (
        <div role="alert" className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-4 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {loaded && !error && doc && (
        <>
          {/* ── CONTROLS ─────────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">Range</span>
              <div className="flex overflow-hidden rounded-md border border-gray-200 dark:border-gray-700">
                {RANGES.map((r) => (
                  <button
                    key={r}
                    onClick={() => setDays(r)}
                    className={`px-2.5 py-1 text-xs font-medium tabular-nums transition-colors ${
                      days === r
                        ? 'bg-sky-500 text-white'
                        : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
                    }`}
                    aria-pressed={days === r}
                  >
                    {r}d
                  </button>
                ))}
              </div>
            </div>
            <span className="text-[11px] text-gray-400">min n = {doc.minSamples} to render a rate</span>
          </div>

          {/* ── MATRIX ───────────────────────────────────────────────────── */}
          {doc.taskClasses.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-6 py-8 text-center">
              <Table2 className="h-7 w-7 text-gray-300 dark:text-gray-600" aria-hidden="true" />
              <div className="text-sm font-semibold text-gray-600 dark:text-gray-300">No routed units in the last {days} days</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">The matrix fills in as units are dispatched with a routing decision and land (or don't).</div>
            </div>
          ) : (
            <SectionCard title="Merge rate by task class × model" right={`n = distinct units`}>
              <div className="overflow-x-auto p-3">
                <table className="w-full border-separate border-spacing-1">
                  <thead>
                    <tr>
                      <th className="px-2 py-1 text-left text-[11px] font-semibold uppercase tracking-widest text-gray-400">task class</th>
                      {doc.models.map((m) => (
                        <th key={m} className="px-2 py-1 text-center text-[11px] font-semibold uppercase tracking-widest text-gray-400">
                          {m}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {doc.taskClasses.map((tc) => (
                      <tr key={tc}>
                        <td className="whitespace-nowrap px-2 py-1 text-xs font-mono font-medium text-gray-700 dark:text-gray-300">{tc}</td>
                        {doc.models.map((m) => {
                          const cell = doc.cells[tc]?.[m];
                          return (
                            <td key={m} className="min-w-[7rem] p-0.5 align-top">
                              {cell ? <MatrixCell cell={cell} /> : <div className="h-full rounded-md px-2 py-2 text-center text-[10px] text-gray-300 dark:text-gray-700">—</div>}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          )}

          {/* ── RAW PAYLOAD (collapsed) ──────────────────────────────────── */}
          <details className="group rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-xs">
            <summary className="flex cursor-pointer select-none items-center gap-2 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-widest text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500 list-none">
              <span className="mr-auto">Raw matrix data</span>
              <span className="text-gray-300 dark:text-gray-600 group-open:rotate-180 transition-transform" aria-hidden="true">
                ▾
              </span>
            </summary>
            <div className="border-t border-gray-100 dark:border-gray-800 px-4 py-3">
              <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[10px] text-gray-600 dark:text-gray-400 leading-relaxed">
                {JSON.stringify(doc, null, 2)}
              </pre>
            </div>
          </details>
        </>
      )}
    </PanelShell>
  );
};
