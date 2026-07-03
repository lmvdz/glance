/**
 * ActivityHeatmapPanel — "Activity rhythm": a day×hour heatmap of file-touch
 * activity across the fleet. Rows = calendar days, columns = hours 00–23, cell
 * intensity = files touched in that hour (GET /api/activity/heatmap, backed by
 * receipts.filesTouched — the SAME source as the Heat panel, just bucketed by
 * hour-of-day too, so the two views agree on totals).
 *
 * Aesthetic north star: the Felton / FlowingData "a day in the life" temporal
 * matrix — magma-on-black, dense tiny cells, faint stipple in the dead hours, a
 * quiet glow on the hot ones. It renders on its own dark canvas regardless of
 * app theme, because that IS the language of this chart. Reuses magma() /
 * MAGMA_GRADIENT from lib/heatmap so the ramp matches everywhere.
 *
 * Every number traces to real receipts — no fabricated intensity.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, RefreshCw, Sparkles } from 'lucide-react';
import { apiJson } from '../lib/api';
import { magma, MAGMA_GRADIENT } from '../lib/heatmap';
import { PanelShell, VerdictBadge } from './ui';

// ──────────────────────────────── types ──────────────────────────────────────

interface ActivityHeatmapPayload {
  days: string[];
  hours: number[];
  matrix: { day: string; hourly: number[] }[];
  /** largest single (day, hour) cell — cells normalize against this. */
  max: number;
  /** total file-touches across the window. */
  total: number;
  source: string;
  generatedAt: number;
}

const RANGES = [7, 14, 30] as const;

/** 24 equal hour columns — inline (matching HeatTree) rather than a grid-cols-24 class. */
const GRID_24: React.CSSProperties = { gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' };

// ──────────────────────────────── helpers ────────────────────────────────────

/** Split an ISO day into the reference's two-line label ("Tuesday" / "15 Dec 2025"). */
function dayLabel(iso: string): { weekday: string; date: string } {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return { weekday: iso, date: '' };
  return {
    weekday: d.toLocaleDateString(undefined, { weekday: 'long' }),
    date: d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }),
  };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** One day's 24-cell row. Zero-activity hours read as a faint stipple, not a solid block. */
const HeatRow: React.FC<{ hourly: number[]; max: number }> = ({ hourly, max }) => (
  <div className="grid flex-1 gap-px" style={GRID_24}>
    {hourly.map((v, h) => {
      const t = max > 0 ? v / max : 0;
      if (v === 0) {
        // dead hour — a dim dot on near-black, the reference's stipple field
        return (
          <div key={h} className="flex h-3.5 items-center justify-center rounded-[1px] bg-[#0c0f17]" title={`${pad2(h)}:00 — no activity`}>
            <span className="h-[1.5px] w-[1.5px] rounded-full bg-[#3a4152]" aria-hidden="true" />
          </div>
        );
      }
      const hot = t > 0.6;
      return (
        <div
          key={h}
          className="h-3.5 rounded-[1px]"
          style={{
            backgroundColor: magma(t),
            // a quiet bloom on the hottest cells — the only depth cue, per the moodboard
            boxShadow: hot ? `0 0 6px ${magma(t)}` : undefined,
          }}
          title={`${pad2(h)}:00 — ${v} file${v === 1 ? '' : 's'} touched`}
        />
      );
    })}
  </div>
);

// ──────────────────────────────── component ──────────────────────────────────

export const ActivityHeatmapPanel: React.FC = () => {
  const [days, setDays] = useState<(typeof RANGES)[number]>(7);
  const [data, setData] = useState<ActivityHeatmapPayload | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await apiJson<ActivityHeatmapPayload>(`/api/activity/heatmap?days=${days}`);
      setData(d);
      setError('');
    } catch {
      setError('Could not reach the daemon for activity data.');
    } finally {
      setLoaded(true);
    }
  }, [days]);

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 15_000);
    return () => clearInterval(iv);
  }, [load]);

  // ── derived signals ──────────────────────────────────────────────────────

  const hourTotals = useMemo(() => {
    const totals = new Array<number>(24).fill(0);
    for (const row of data?.matrix ?? []) for (let h = 0; h < 24; h++) totals[h] += row.hourly[h] ?? 0;
    return totals;
  }, [data?.matrix]);

  const peakHour = useMemo(() => {
    let best = -1;
    let bestV = 0;
    hourTotals.forEach((v, h) => {
      if (v > bestV) {
        bestV = v;
        best = h;
      }
    });
    return best;
  }, [hourTotals]);

  const maxHourTotal = useMemo(() => Math.max(0, ...hourTotals), [hourTotals]);

  const busiestDay = useMemo(() => {
    let best: { day: string; sum: number } | null = null;
    for (const row of data?.matrix ?? []) {
      const sum = row.hourly.reduce((a, b) => a + b, 0);
      if (!best || sum > best.sum) best = { day: row.day, sum };
    }
    return best && best.sum > 0 ? best : null;
  }, [data?.matrix]);

  const total = data?.total ?? 0;

  // ── verdict / subtitle ────────────────────────────────────────────────────

  const verdictKind: 'critical' | 'warn' | 'healthy' = 'healthy';
  const verdictText =
    total > 0 && peakHour >= 0
      ? `Peak ${pad2(peakHour)}:00 · ${total} touch${total === 1 ? '' : 'es'}`
      : 'No activity';

  const subtitle = (
    <span className="flex items-center gap-2">
      <VerdictBadge verdict={verdictKind}>{verdictText}</VerdictBadge>
    </span>
  );

  const refresh = (
    <button
      onClick={() => void load()}
      className="flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-600 dark:text-gray-300 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
      title="Refresh"
      aria-label="Refresh activity data"
    >
      <RefreshCw className="h-3 w-3" aria-hidden="true" />
    </button>
  );

  return (
    <PanelShell
      icon={<CalendarClock className="h-4 w-4 text-orange-500" aria-hidden="true" />}
      title="Activity rhythm"
      subtitle={subtitle}
      actions={refresh}
    >
      {/* Loading skeleton */}
      {!loaded && !error && (
        <div className="space-y-2 animate-pulse" aria-label="Loading activity data">
          {[1, 2, 3, 4, 5].map((n) => (
            <div key={n} className="h-4 rounded bg-gray-100 dark:bg-gray-800" />
          ))}
        </div>
      )}

      {/* Error */}
      {loaded && error && (
        <div role="alert" className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-4 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {loaded && !error && data && (
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
                      days === r ? 'bg-orange-500 text-white' : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
                    }`}
                    aria-pressed={days === r}
                  >
                    {r}d
                  </button>
                ))}
              </div>
            </div>
            {busiestDay && (
              <span className="text-[11px] text-gray-500 dark:text-gray-400">
                Busiest day <span className="font-semibold text-gray-700 dark:text-gray-200">{dayLabel(busiestDay.day).weekday}</span> · {busiestDay.sum} touches
              </span>
            )}
          </div>

          {/* ── THE MATRIX (dark viz canvas) ─────────────────────────────── */}
          {total > 0 ? (
            <div className="overflow-x-auto rounded-xl border border-[#1e2430] bg-[#05060a] p-4">
              <div className="min-w-[560px]">
                {/* hour axis header */}
                <div className="mb-2 flex items-end">
                  <div className="w-24 flex-shrink-0" aria-hidden="true" />
                  <div className="grid flex-1 gap-px" style={GRID_24}>
                    {Array.from({ length: 24 }, (_, h) => (
                      <div key={h} className="text-center text-[8px] font-medium tabular-nums text-[#5a6270]">
                        {pad2(h)}
                      </div>
                    ))}
                  </div>
                </div>

                {/* day rows */}
                <div className="space-y-px">
                  {data.matrix.map((row) => {
                    const { weekday, date } = dayLabel(row.day);
                    return (
                      <div key={row.day} className="flex items-center">
                        <div className="w-24 flex-shrink-0 pr-3 text-right leading-tight">
                          <div className="truncate text-[11px] font-semibold text-[#c4c9d2]" title={row.day}>{weekday}</div>
                          <div className="truncate text-[9px] tabular-nums text-[#6d7480]">{date}</div>
                        </div>
                        <HeatRow hourly={row.hourly} max={data.max} />
                      </div>
                    );
                  })}
                </div>

                {/* hour-of-day totals (the "when, across all days" marginal) */}
                <div className="mt-2 flex items-center border-t border-[#141922] pt-2">
                  <div className="w-24 flex-shrink-0 pr-3 text-right text-[9px] font-semibold uppercase tracking-widest text-[#5a6270]">By hour</div>
                  <div className="grid flex-1 gap-px" style={GRID_24}>
                    {hourTotals.map((v, h) => (
                      <div
                        key={h}
                        className="h-1.5 rounded-[1px]"
                        style={{ backgroundColor: v > 0 ? magma(maxHourTotal > 0 ? v / maxHourTotal : 0) : '#0c0f17' }}
                        title={`${pad2(h)}:00 — ${v} touch${v === 1 ? '' : 'es'} across the window`}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* ── CALM EMPTY STATE ───────────────────────────────────────── */
            <div className="flex flex-col items-center gap-2 rounded-lg border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/20 px-6 py-8 text-center">
              <Sparkles className="h-7 w-7 text-emerald-400" aria-hidden="true" />
              <div className="text-sm font-semibold text-gray-600 dark:text-gray-300">No activity in the last {days} days</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">No receipt-backed file writes to chart yet.</div>
            </div>
          )}

          {/* ── LEGEND ───────────────────────────────────────────────────── */}
          {total > 0 && (
            <div className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-2.5">
              <span className="text-xs text-gray-500 dark:text-gray-400">Quiet</span>
              <div className="h-2.5 flex-1 rounded-full" style={{ background: MAGMA_GRADIENT }} />
              <span className="text-xs text-gray-500 dark:text-gray-400">Busy</span>
              <span className="ml-2 text-[11px] tabular-nums text-gray-400">files touched / hour · local time</span>
            </div>
          )}
        </>
      )}
    </PanelShell>
  );
};
