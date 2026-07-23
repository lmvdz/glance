/**
 * LoopMetersCard — "is the learning tech actually on, and is it being used?" (Daily view).
 *
 * Renders GET /api/metrics/learning-loop, which until this card had ZERO readers anywhere (webapp
 * or CLI) — the literal meter for "we have all of this tech that is supposed to help, but it's not
 * being used". Two blocks:
 *   1. Flag chips — each learning flag (failure memory, reflexion, model outcomes, …) as an on/off
 *      chip, so a dormant subsystem is VISIBLY dormant instead of silently absent.
 *   2. Meter rows — the per-metric rollups (first-try-green rate, fixups-to-green, …) with their
 *      sample counts, so a rate over n=2 can't masquerade as a trend.
 *
 * Pure in its props (DailyPanel owns the fetch), exported for fixture tests — the DailyPanel idiom.
 */

import React from 'react';
import { FlaskConical } from 'lucide-react';
import { flagChips, meterRows, type LearningLoopWire } from '../lib/loop-meters';
import { SectionCard } from './ui';

export const LoopMetersCard: React.FC<{
  loop: LearningLoopWire | null;
  loaded: boolean;
  error?: string;
}> = ({ loop, loaded, error }) => {
  const chips = loop ? flagChips(loop.flags) : [];
  const rows = loop ? meterRows(loop.rollup) : [];
  const onCount = chips.filter((c) => c.on).length;
  const right = chips.length > 0 ? <span className="font-mono text-[11px]">{`${onCount}/${chips.length} on`}</span> : undefined;
  return (
    <SectionCard title="Learning loop" right={right}>
      {!loaded ? (
        <div className="space-y-2 p-4" aria-label="Loading learning-loop meters">
          {[1, 2].map((n) => (
            <div key={n} className="h-8 animate-pulse rounded-md bg-gray-100 dark:bg-gray-800" />
          ))}
        </div>
      ) : error ? (
        <div role="alert" className="p-4 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      ) : (
        <div className="space-y-4 p-4">
          <div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-gray-400">Flags</div>
            {chips.length === 0 ? (
              <p className="text-xs text-gray-500 dark:text-gray-400">The daemon reported no learning flags.</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {chips.map((c) => (
                  <li
                    key={c.key}
                    className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                      c.on
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                        : 'bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500'
                    }`}
                    title={`${c.key}: ${c.on ? 'on' : 'off'}`}
                  >
                    {c.label} {c.on ? 'on' : 'off'}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-gray-400">Meters</div>
            {rows.length === 0 ? (
              <div className="flex items-start gap-2 text-xs text-gray-500 dark:text-gray-400">
                <FlaskConical className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-gray-300 dark:text-gray-600" aria-hidden="true" />
                <p>
                  No metric samples in the window — the loop hasn&rsquo;t run any measured units recently, so nothing here is
                  proven either way. An honest blank, not a zero.
                </p>
              </div>
            ) : (
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {rows.map((r) => (
                  <li
                    key={r.name}
                    className="flex items-baseline justify-between gap-2 rounded-md border border-gray-100 px-2.5 py-1.5 dark:border-gray-800"
                  >
                    <span className="truncate text-xs text-gray-600 dark:text-gray-300" title={r.name}>
                      {r.label}
                    </span>
                    <span className="whitespace-nowrap font-mono text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                      {r.value} <span className="text-[10px] font-normal text-gray-400">n={r.n}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
};
