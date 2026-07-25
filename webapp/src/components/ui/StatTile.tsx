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
    <div className="flex min-w-[140px] flex-1 flex-col gap-1 rounded-lg border border-ink-border bg-panel p-3 transition-colors">
      <div className="text-caption font-semibold uppercase tracking-widest text-ink-text-subtle">{label}</div>
      <div className="flex items-end justify-between gap-2">
        <div className="min-w-0">
          <div className={`text-2xl font-semibold leading-tight tabular-nums ${tone === 'neutral' ? 'text-ink-text' : t.text}`}>{value}</div>
          {sub != null && <div className="mt-0.5 text-caption text-ink-text-muted">{sub}</div>}
        </div>
        {spark && spark.length > 0 && (
          <div className="flex-shrink-0 pb-0.5">
            <Sparkline values={spark} tone={tone === 'neutral' ? 'neutral' : tone} label={`${label} trend`} />
          </div>
        )}
      </div>
    </div>
  );
};
