/**
 * HeatGrid — a GitHub-contribution-style matrix: one labeled row per file/area,
 * one colored cell per day. Turns the raw `heat:[0,0,0,0,0,0,2,0]` arrays into a
 * scannable picture of WHERE and WHEN work concentrated.
 */

import React from 'react';

export interface HeatGridRow {
  label: string;
  /** per-day counts, aligned to `days`. */
  daily: number[];
  /** optional trailing note, e.g. "3 agents". */
  note?: React.ReactNode;
}

export interface HeatGridProps {
  days: string[];
  rows: HeatGridRow[];
  /** optional empty-state message. */
  emptyLabel?: string;
}

/** Five-step intensity ramp keyed to the row's own max (relative heat). */
function cellClass(value: number, rowMax: number): string {
  if (!value || value <= 0) return 'bg-gray-100 dark:bg-gray-800/60';
  const r = value / (rowMax || 1);
  if (r > 0.75) return 'bg-orange-600 dark:bg-orange-500';
  if (r > 0.5) return 'bg-orange-500 dark:bg-orange-500/80';
  if (r > 0.25) return 'bg-amber-400 dark:bg-amber-500/70';
  return 'bg-amber-300/80 dark:bg-amber-600/40';
}

function shortDay(iso: string): string {
  // "2026-06-27" → "06-27"
  return iso.length >= 10 ? iso.slice(5) : iso;
}

export const HeatGrid: React.FC<HeatGridProps> = ({ days, rows, emptyLabel = 'No activity in this window.' }) => {
  if (rows.length === 0) {
    return <div className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400">{emptyLabel}</div>;
  }

  return (
    <div className="overflow-x-auto px-4 py-3">
      <table className="w-full border-separate border-spacing-x-0.5 border-spacing-y-1">
        <thead>
          <tr>
            <th className="w-0" />
            {days.map((d) => (
              <th key={d} className="px-0 text-center text-[9px] font-medium tabular-nums text-gray-400" title={d}>
                {shortDay(d)}
              </th>
            ))}
            <th className="w-0" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const rowMax = Math.max(0, ...row.daily);
            return (
              <tr key={row.label} className="group">
                <td className="max-w-[14rem] truncate pr-3 text-xs font-medium text-gray-700 dark:text-gray-300" title={row.label}>
                  {row.label}
                </td>
                {days.map((d, i) => {
                  const v = row.daily[i] ?? 0;
                  return (
                    <td key={d} className="p-0">
                      <div
                        className={`mx-auto h-3.5 w-3.5 rounded-sm transition-colors ${cellClass(v, rowMax)}`}
                        title={`${row.label} · ${d}: ${v} touch${v === 1 ? '' : 'es'}`}
                        aria-label={`${row.label}, ${d}: ${v} touches`}
                      />
                    </td>
                  );
                })}
                {row.note != null && <td className="whitespace-nowrap pl-3 text-right text-[11px] text-gray-400">{row.note}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
