/**
 * DailyPanel -- the "Daily driver" view (plans/daily-driver-w15/04-visibility-panels).
 *
 * The dogfood loop has two signals the meta-plan calls its real success metric, and until now both
 * rendered NOWHERE: the adoption counters (casual sessions / prompts / push-taps per day) and the
 * friction ledger (`glance grr` gripes plus the daemon's own auto-captured friction). This one view
 * gives both a face -- counters as the header block, the ledger as the body -- so "signals that
 * render nowhere don't exist" stops being true of the product loop.
 *
 * Self-fetch + poll idiom mirrors OmpGraphPanel/FogView (Promise.allSettled so one dead endpoint
 * never blanks the other); header/tile/card layout mirrors CapabilityPanel. Every transform lives in
 * lib/adoption-view.ts (pure, unit-tested); this file is presentation + wiring only. The counter and
 * ledger sub-blocks are exported so their fixture/empty/error renders are tested without a live fetch.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Gauge, RefreshCw, Zap, MessageSquareText, Inbox } from 'lucide-react';
import { apiJson } from '../lib/api';
import {
  buildAdoptionView,
  coerceAdoptionCounters,
  coerceFrictionEntries,
  frictionContextLabel,
  frictionCounts,
  frictionSource,
  type AdoptionCountersWire,
  type AdoptionView,
  type FrictionEntryWire,
} from '../lib/adoption-view';
import { PanelShell, SectionCard, StatTile, VerdictBadge } from './ui';
import { relativeAge } from './ui/time';

/** `/home/u/glance` -> `glance`; passes through a short/empty value unchanged. Repo is stored as an
 *  absolute path; the row shows the basename with the full path on hover. */
function repoBasename(repo: string): string {
  const trimmed = repo.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** The counters header block: three StatTiles over the trailing 7 UTC days, or an honest
 *  "no activity recorded" empty state -- never zeros dressed up as data. Pure in `view`. */
export const AdoptionCounters: React.FC<{ view: AdoptionView }> = ({ view }) => (
  <section aria-label="Adoption counters">
    <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-amber-700 dark:text-amber-400">
      Adoption &middot; the loop&rsquo;s real success metric
    </div>
    {view.hasActivity ? (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {view.series.map((s) => (
          <StatTile
            key={s.key}
            label={s.label}
            value={s.week.toLocaleString()}
            sub={`${s.today.toLocaleString()} today`}
            spark={s.spark}
          />
        ))}
      </div>
    ) : (
      <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center dark:border-gray-700">
        <div className="text-sm font-medium text-gray-700 dark:text-gray-200">No activity recorded yet</div>
        <p className="mx-auto mt-1 max-w-md text-xs text-gray-500 dark:text-gray-400">
          No casual sessions, prompts, or push taps in the last 7 days. Start one with{' '}
          <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[11px] dark:bg-gray-800">glance here</code>{' '}
          and it lands here.
        </p>
      </div>
    )}
  </section>
);

/** One friction row. Auto (daemon-captured) rows are visually distinct from human gripes: a blue
 *  left rail + Zap glyph + AUTO tag vs an amber rail + speech glyph + YOU tag. A legacy/sourceless
 *  row reads as human (never crashes) via `frictionSource`. */
export const FrictionRow: React.FC<{ entry: FrictionEntryWire; now?: number }> = ({ entry, now }) => {
  const source = frictionSource(entry);
  const auto = source === 'auto';
  const contextLabel = frictionContextLabel(entry);
  const age = relativeAge(entry.ts, now);
  return (
    <li
      className={`flex gap-3 border-b border-gray-100 px-4 py-3 last:border-b-0 dark:border-gray-800/60 ${
        auto ? 'border-l-2 border-l-blue-400 dark:border-l-blue-500' : 'border-l-2 border-l-amber-400 dark:border-l-amber-500'
      }`}
    >
      <span className="mt-0.5 flex-shrink-0" aria-hidden="true">
        {auto ? (
          <Zap className="h-4 w-4 text-blue-500 dark:text-blue-400" />
        ) : (
          <MessageSquareText className="h-4 w-4 text-amber-500 dark:text-amber-400" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-gray-800 dark:text-gray-200">{entry.gripe}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
              auto
                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
            }`}
          >
            {auto ? 'auto' : 'you'}
          </span>
          {age && <span className="font-mono" title={new Date(entry.ts).toISOString()}>{age} ago</span>}
          {entry.repo && (
            <span className="max-w-[10rem] truncate font-mono text-gray-400 dark:text-gray-500" title={entry.repo}>
              {repoBasename(entry.repo)}
            </span>
          )}
          {contextLabel && (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              {contextLabel}
            </span>
          )}
        </div>
      </div>
    </li>
  );
};

/** The friction ledger body: newest-first list, or a loading / empty / error state -- all
 *  first-class. `entries` is already newest-first (the server reverses). Pure in its props. */
export const FrictionLedger: React.FC<{
  entries: FrictionEntryWire[];
  loaded: boolean;
  error?: string;
  now?: number;
}> = ({ entries, loaded, error, now }) => {
  const counts = frictionCounts(entries);
  const right =
    entries.length > 0 ? (
      <span className="font-mono text-[11px]">{`${entries.length} \u00b7 ${counts.auto} auto \u00b7 ${counts.human} yours`}</span>
    ) : undefined;
  return (
    <SectionCard title="Friction ledger" right={right}>
      {!loaded ? (
        <div className="space-y-2 p-4" aria-label="Loading friction ledger">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-10 animate-pulse rounded-md bg-gray-100 dark:bg-gray-800" />
          ))}
        </div>
      ) : error ? (
        <div role="alert" className="p-4 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      ) : entries.length === 0 ? (
        <div className="px-4 py-10 text-center">
          <Inbox className="mx-auto mb-2 h-6 w-6 text-gray-300 dark:text-gray-600" aria-hidden="true" />
          <div className="text-sm font-medium text-gray-600 dark:text-gray-300">Nothing filed</div>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[11px] dark:bg-gray-800">grr</code> something when
            the loop annoys you &mdash; the daemon files its own friction here too.
          </p>
        </div>
      ) : (
        <ul>
          {entries.map((entry) => (
            <FrictionRow key={entry.id} entry={entry} now={now} />
          ))}
        </ul>
      )}
    </SectionCard>
  );
};

/** Verdict sentence under the title -- honest about the empty case, never a fake-zero flex. */
function subtitleFor(view: AdoptionView | null): string {
  if (!view) return "Loading the dogfood loop's signals";
  if (!view.hasActivity) return 'No casual sessions, prompts, or push taps in the last 7 days';
  const [sessions, prompts, taps] = view.series;
  return `${sessions.week} sessions · ${prompts.week} prompts · ${taps.week} push taps in the last 7 days`;
}

export const DailyPanel: React.FC = () => {
  const [counters, setCounters] = useState<AdoptionCountersWire | null>(null);
  const [friction, setFriction] = useState<FrictionEntryWire[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [frictionError, setFrictionError] = useState('');

  const load = useCallback(async () => {
    // Both signals refresh together; one dead endpoint must never blank the other (FogView idiom).
    const [a, f] = await Promise.allSettled([
      apiJson<unknown>('/api/adoption'),
      apiJson<unknown>('/api/friction?limit=50'),
    ]);
    if (a.status === 'fulfilled') {
      setCounters(coerceAdoptionCounters(a.value));
      setError('');
    } else {
      setError('Could not reach the daemon for adoption counters.');
    }
    if (f.status === 'fulfilled') {
      setFriction(coerceFrictionEntries(f.value));
      setFrictionError('');
    } else {
      setFrictionError('Could not reach the daemon for the friction ledger.');
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 20_000);
    return () => clearInterval(iv);
  }, [load]);

  const view = useMemo(() => (counters ? buildAdoptionView(counters) : null), [counters]);

  const refresh = (
    <button
      type="button"
      onClick={() => void load()}
      className="flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-600 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
      title="Refresh"
      aria-label="Refresh daily driver signals"
    >
      <RefreshCw className="h-3 w-3" aria-hidden="true" />
    </button>
  );

  return (
    <PanelShell
      icon={<Gauge className="h-4 w-4 text-amber-500" aria-hidden="true" />}
      title="Daily driver"
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          {view?.hasActivity && <VerdictBadge verdict="healthy">live</VerdictBadge>}
          {subtitleFor(view)}
        </span>
      }
      actions={refresh}
    >
      {!loaded && !view ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" aria-label="Loading adoption counters">
            {[1, 2, 3].map((n) => (
              <div key={n} className="h-20 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
            ))}
          </div>
          <FrictionLedger entries={[]} loaded={false} />
        </div>
      ) : (
        <>
          {error && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
              {error}
            </div>
          )}
          {view && <AdoptionCounters view={view} />}
          <FrictionLedger entries={friction ?? []} loaded={loaded} error={frictionError || undefined} />
        </>
      )}
    </PanelShell>
  );
};
