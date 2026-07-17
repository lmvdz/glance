/**
 * FrictionInbox — browse the dogfood friction ledger (GET /api/friction) in the UI.
 *
 * The ledger is the daily-driver loop's captured-gripe substrate — annoyances typed via `glance grr`
 * plus (once daily-driver-w15 concern 02 lands) friction the daemon auto-captures from real incidents.
 * Until now it could only be read on the CLI; this turns the invisible ledger into something a human
 * can triage in-UI: newest-first, source-labelled (human vs auto), filterable, with a local
 * acknowledge so a triaged gripe stops cluttering the inbox.
 *
 * `FrictionInboxView` is the pure presentational half (renderToStaticMarkup-testable — every state,
 * no fetch/timers/storage); `FrictionInbox` is the thin polling container the shell routes to.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, Check, MessageSquareWarning, RefreshCw, RotateCcw, User } from 'lucide-react';
import { apiJson } from '../lib/api';
import { relativeAge } from './ui/time';
import { PanelShell, SectionCard } from './ui';
import { toneClasses } from './ui/tokens';
import {
  contextLabel,
  filterFriction,
  frictionSource,
  normalizeFrictionResponse,
  repoLabel,
  sourceCounts,
  type FrictionEntry,
  type FrictionFilter,
} from '../lib/friction';

const ACK_STORAGE_KEY = 'omp.friction.acked';

// ── source badge ──────────────────────────────────────────────────────────────

const SourceBadge: React.FC<{ source: 'human' | 'auto' }> = ({ source }) => {
  const auto = source === 'auto';
  const t = toneClasses(auto ? 'warn' : 'info');
  const Icon = auto ? Bot : User;
  return (
    <span
      className={`inline-flex flex-shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${t.pillBg} ${t.pillText}`}
      title={auto ? 'Auto-captured by the daemon from a real incident' : 'Typed by you (glance grr)'}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {auto ? 'auto' : 'you'}
    </span>
  );
};

const Chip: React.FC<{ children: React.ReactNode; title?: string }> = ({ children, title }) => (
  <span
    className="inline-flex max-w-[14rem] items-center truncate rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono text-[10px] text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400"
    title={title}
  >
    {children}
  </span>
);

// ── one row ─────────────────────────────────────────────────────────────────

export interface FrictionRowProps {
  entry: FrictionEntry;
  acked: boolean;
  onAck: (id: string) => void;
  onUnack: (id: string) => void;
  now?: number;
}

export const FrictionRow: React.FC<FrictionRowProps> = ({ entry, acked, onAck, onUnack, now }) => {
  const source = frictionSource(entry);
  const ctx = contextLabel(entry);
  const age = relativeAge(entry.ts, now);
  return (
    <li className={`group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/40 ${acked ? 'opacity-55' : ''}`}>
      <div className="flex-shrink-0 pt-0.5">
        <SourceBadge source={source} />
      </div>
      <div className="min-w-0 flex-1">
        <p className={`whitespace-pre-wrap break-words text-sm text-gray-800 dark:text-gray-100 ${acked ? 'line-through' : ''}`}>{entry.gripe}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
          {ctx && <Chip title="Capture context / subtype">{ctx}</Chip>}
          <Chip title={entry.repo || 'unknown repo'}>{repoLabel(entry.repo)}</Chip>
          {entry.agentId && <Chip title={`Agent ${entry.agentId}`}>{entry.agentId}</Chip>}
          <span className="text-gray-400 dark:text-gray-500" title={new Date(entry.ts).toLocaleString()}>
            {age ? `${age} ago` : 'just now'}
          </span>
        </div>
      </div>
      {acked ? (
        <button
          onClick={() => onUnack(entry.id)}
          className="flex-shrink-0 self-center rounded-md p-1.5 text-gray-400 opacity-0 transition-colors hover:bg-gray-100 hover:text-gray-600 focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 group-hover:opacity-100 dark:hover:bg-gray-700 dark:hover:text-gray-200"
          title="Restore to inbox"
          aria-label="Restore this gripe to the inbox"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : (
        <button
          onClick={() => onAck(entry.id)}
          className="flex-shrink-0 self-center rounded-md p-1.5 text-gray-400 opacity-0 transition-colors hover:bg-emerald-50 hover:text-emerald-600 focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 group-hover:opacity-100 dark:hover:bg-emerald-950/40 dark:hover:text-emerald-400"
          title="Acknowledge (hides locally from your inbox)"
          aria-label="Acknowledge this gripe"
        >
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </li>
  );
};

// ── filter tabs ─────────────────────────────────────────────────────────────

const FILTERS: { key: FrictionFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'human', label: 'You' },
  { key: 'auto', label: 'Auto' },
];

const FilterTabs: React.FC<{ filter: FrictionFilter; onFilter: (f: FrictionFilter) => void; counts: { all: number; human: number; auto: number } }> = ({
  filter,
  onFilter,
  counts,
}) => (
  <div className="flex overflow-hidden rounded-md border border-gray-200 dark:border-gray-700" role="tablist" aria-label="Filter friction by source">
    {FILTERS.map((f) => {
      const n = f.key === 'all' ? counts.all : f.key === 'human' ? counts.human : counts.auto;
      const active = filter === f.key;
      return (
        <button
          key={f.key}
          role="tab"
          aria-selected={active}
          onClick={() => onFilter(f.key)}
          className={`px-2.5 py-1 text-xs font-medium tabular-nums transition-colors ${
            active
              ? 'bg-orange-500 text-white'
              : 'bg-white text-gray-600 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800'
          }`}
        >
          {f.label} <span className={active ? 'text-orange-100' : 'text-gray-400'}>{n}</span>
        </button>
      );
    })}
  </div>
);

// ── the pure view ─────────────────────────────────────────────────────────────

export interface FrictionInboxViewProps {
  /** Full normalized ledger (newest-first). */
  entries: FrictionEntry[];
  loading: boolean;
  error: boolean;
  filter: FrictionFilter;
  onFilter: (f: FrictionFilter) => void;
  /** Ids the operator has locally acknowledged. */
  acked: Set<string>;
  onAck: (id: string) => void;
  onUnack: (id: string) => void;
  showAcked: boolean;
  onToggleShowAcked: () => void;
  onRefresh: () => void;
  now?: number;
}

const SkeletonRows: React.FC = () => (
  <ul aria-hidden="true">
    {[0, 1, 2, 3].map((i) => (
      <li key={i} className="flex items-start gap-3 border-b border-gray-100 px-4 py-3 last:border-b-0 dark:border-gray-800">
        <div className="h-4 w-10 flex-shrink-0 animate-pulse rounded-full bg-gray-100 dark:bg-gray-800" />
        <div className="flex-1 space-y-2">
          <div className="h-3.5 w-3/4 animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
          <div className="h-2.5 w-1/3 animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
        </div>
      </li>
    ))}
  </ul>
);

export const FrictionInboxView: React.FC<FrictionInboxViewProps> = ({
  entries,
  loading,
  error,
  filter,
  onFilter,
  acked,
  onAck,
  onUnack,
  showAcked,
  onToggleShowAcked,
  onRefresh,
  now,
}) => {
  const counts = sourceCounts(entries);
  const filtered = filterFriction(entries, filter);
  const active = filtered.filter((e) => !acked.has(e.id));
  const ackedInView = filtered.filter((e) => acked.has(e.id));

  const refreshBtn = (
    <button
      onClick={onRefresh}
      className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-600 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
      title="Reload the ledger"
      aria-label="Refresh friction ledger"
    >
      <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
    </button>
  );

  // PanelShell owns the whole <main>; we branch the body here and slot it in as the shell's children,
  // so there is exactly one shell for every state.
  let body: React.ReactNode;
  if (loading && entries.length === 0) {
    body = (
      <SectionCard title="Gripes">
        <SkeletonRows />
      </SectionCard>
    );
  } else if (error && entries.length === 0) {
    body = (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-gray-200 bg-white px-6 py-12 text-center dark:border-gray-800 dark:bg-gray-900">
        <p className="text-sm text-gray-500 dark:text-gray-400">Couldn't reach the daemon for the friction ledger.</p>
        {refreshBtn}
      </div>
    );
  } else if (active.length === 0 && ackedInView.length === 0) {
    body = (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-gray-200 bg-white px-6 py-12 text-center dark:border-gray-800 dark:bg-gray-900">
        <MessageSquareWarning className="h-6 w-6 text-gray-300 dark:text-gray-600" aria-hidden="true" />
        <p className="text-sm font-medium text-gray-600 dark:text-gray-300">
          {filter === 'all' ? 'No friction logged yet' : `No ${filter === 'human' ? 'human' : 'auto-captured'} gripes`}
        </p>
        <p className="max-w-sm text-xs text-gray-500 dark:text-gray-400">
          Capture an annoyance with <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[11px] dark:bg-gray-800">glance grr "…"</code> and it shows up here — the daemon also auto-captures friction from real incidents.
        </p>
      </div>
    );
  } else {
    body = (
      <>
        <SectionCard title="Gripes" right={`${active.length} open`}>
          {active.length > 0 ? (
            <ul className="divide-y divide-gray-100 dark:divide-gray-800">
              {active.map((e) => (
                <FrictionRow key={e.id} entry={e} acked={false} onAck={onAck} onUnack={onUnack} now={now} />
              ))}
            </ul>
          ) : (
            <p className="px-4 py-6 text-center text-xs text-gray-500 dark:text-gray-400">
              Inbox zero for this filter — every gripe acknowledged.
            </p>
          )}
        </SectionCard>

        {ackedInView.length > 0 && (
          <div>
            <button
              onClick={onToggleShowAcked}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-gray-500 transition-colors hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-gray-400 dark:hover:text-gray-200"
              aria-expanded={showAcked}
            >
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              {showAcked ? 'Hide' : 'Show'} {ackedInView.length} acknowledged
            </button>
            {showAcked && (
              <div className="mt-2">
                <SectionCard title="Acknowledged">
                  <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                    {ackedInView.map((e) => (
                      <FrictionRow key={e.id} entry={e} acked onAck={onAck} onUnack={onUnack} now={now} />
                    ))}
                  </ul>
                </SectionCard>
              </div>
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <PanelShell
      icon={<MessageSquareWarning className="h-4 w-4 text-orange-500" />}
      title="Friction"
      subtitle={
        error && entries.length === 0
          ? 'Ledger unreachable'
          : `${counts.all} gripe${counts.all === 1 ? '' : 's'} · newest first · from glance grr and auto-capture`
      }
      actions={
        <div className="flex items-center gap-2">
          <FilterTabs filter={filter} onFilter={onFilter} counts={counts} />
          {refreshBtn}
        </div>
      }
    >
      {body}
    </PanelShell>
  );
};

// ── container ─────────────────────────────────────────────────────────────────

function readAcked(): Set<string> {
  try {
    const raw = window.localStorage.getItem(ACK_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function writeAcked(ids: Set<string>): void {
  try {
    window.localStorage.setItem(ACK_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    /* storage blocked (private mode) — ack lives only for this page's lifetime. */
  }
}

export const FrictionInbox: React.FC = () => {
  const [entries, setEntries] = useState<FrictionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<FrictionFilter>('all');
  const [acked, setAcked] = useState<Set<string>>(() => readAcked());
  const [showAcked, setShowAcked] = useState(false);

  const load = useCallback(async () => {
    try {
      // apiJson<unknown> then normalize: the server returns `{entries:[...]}`, but normalize also
      // tolerates a bare array / garbage so an old-or-odd daemon never white-screens the view.
      const raw = await apiJson<unknown>('/api/friction?limit=200');
      setEntries(normalizeFrictionResponse(raw));
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 30_000);
    return () => clearInterval(iv);
  }, [load]);

  const onAck = useCallback((id: string) => {
    setAcked((prev) => {
      const next = new Set(prev).add(id);
      writeAcked(next);
      return next;
    });
  }, []);
  const onUnack = useCallback((id: string) => {
    setAcked((prev) => {
      const next = new Set(prev);
      next.delete(id);
      writeAcked(next);
      return next;
    });
  }, []);

  return (
    <FrictionInboxView
      entries={entries}
      loading={loading}
      error={error}
      filter={filter}
      onFilter={setFilter}
      acked={acked}
      onAck={onAck}
      onUnack={onUnack}
      showAcked={showAcked}
      onToggleShowAcked={() => setShowAcked((v) => !v)}
      onRefresh={() => void load()}
    />
  );
};
