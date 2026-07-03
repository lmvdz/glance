/**
 * StatTile — a single metric, never a raw number: label + value + optional unit
 * sub-line and an inline sparkline. The atom the health/automation panels build
 * their top strips from.
 */

import React from 'react';
import { Sparkline } from './Sparkline';
import { toneClasses, type ToneLike } from './tokens';

export interface StatTileProps {
  label: string;
  value: React.ReactNode;
  /** small line under the value — a unit, a delta, or context. */
  sub?: React.ReactNode;
  /** sparkline series (drawn at the tile's right). */
  spark?: number[];
  tone?: ToneLike;
}

export const StatTile: React.FC<StatTileProps> = ({ label, value, sub, spark, tone = 'neutral' }) => {
  const t = toneClasses(tone);
  return (
    <div className="flex min-w-[140px] flex-1 flex-col gap-1 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3 transition-colors">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">{label}</div>
      <div className="flex items-end justify-between gap-2">
        <div className="min-w-0">
          <div className={`text-lg font-semibold leading-tight ${tone === 'neutral' ? 'text-gray-900 dark:text-gray-100' : t.text}`}>{value}</div>
          {sub != null && <div className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">{sub}</div>}
        </div>
        {spark && spark.length > 0 && (
          <div className="flex-shrink-0 pb-0.5">
            <Sparkline values={spark} tone={tone === 'neutral' ? 'info' : tone} label={`${label} trend`} />
          </div>
        )}
      </div>
    </div>
  );
};
