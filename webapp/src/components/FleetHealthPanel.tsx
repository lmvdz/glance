/**
 * FleetHealthPanel — operator decision panel: "Can I throw more work at this,
 * or is it about to choke?"
 *
 * LEADS WITH A VERDICT: healthy → quiet, one-line reassurance; warn → amber
 * banner with the next approaching limit; critical → loud red callout with the
 * binding constraint named explicitly. The capacity hero (slot bar) answers the
 * spawn-gate question in one glance. Resource trends (memory + load) add the
 * time dimension. Everything secondary collapses into a disclosure.
 *
 * Data: GET /api/governance every 10 s → computeCapacity() → the whole panel.
 * No mutation buttons. Raising OMP_SQUAD_WIP_CAP is surfaced as a guidance
 * toast, mirroring AttentionPanel's raise-cap action.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import { apiJson } from '../lib/api';
import { useTaskContext } from '../context/TaskContext';
import {
  computeCapacity,
  useRollingHistory,
  type GovernancePayload,
} from '../lib/insights';
import {
  PanelShell,
  VerdictBadge,
  Sparkline,
  StatTile,
  Callout,
  SectionCard,
  relativeAge,
} from './ui';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Classify a 0-100 percentage into a tone bucket. */
function pctTone(pct: number): 'success' | 'warn' | 'critical' {
  if (pct >= 90) return 'critical';
  if (pct >= 70) return 'warn';
  return 'success';
}

/** ▲ / ▼ / → based on delta between first and last of series. */
function trendArrow(history: number[]): string {
  if (history.length < 2) return '→';
  const delta = history[history.length - 1] - history[history.length - 2];
  if (delta > 0.5) return '▲';
  if (delta < -0.5) return '▼';
  return '→';
}

/** Pretty-print a percentage, clamping to 0–999% for display. */
function fmtPct(n: number): string {
  return `${Math.min(999, Math.max(0, Math.round(n)))}%`;
}

// ── capacity bar ─────────────────────────────────────────────────────────────

interface CapacityBarProps {
  used: number;
  cap: number;
  roomFor: number;
  verdict: 'healthy' | 'warn' | 'critical';
}

/**
 * Segmented capacity bar: green slots = used, empty slots = free, gray = over
 * the cap. Each slot is a rounded square so the bar reads like discrete agent
 * slots, not a continuous fill. Screenreader gets the numbers as text.
 */
const CapacityBar: React.FC<CapacityBarProps> = ({ used, cap, roomFor, verdict }) => {
  const total = Math.max(cap, used, 1);
  const slots = Array.from({ length: total });

  const usedColor =
    verdict === 'critical'
      ? 'bg-red-500 dark:bg-red-500'
      : verdict === 'warn'
        ? 'bg-amber-400 dark:bg-amber-400'
        : 'bg-emerald-500 dark:bg-emerald-500';

  return (
    <div
      className="flex flex-wrap gap-1"
      role="meter"
      aria-label={`Agent slots: ${used} used of ${cap}, ${roomFor} free`}
      aria-valuenow={used}
      aria-valuemin={0}
      aria-valuemax={cap}
    >
      {slots.map((_, i) => {
        const isUsed = i < used;
        const isOverCap = i >= cap;
        return (
          <span
            key={i}
            className={[
              'h-4 w-4 flex-shrink-0 rounded-sm transition-colors',
              isUsed && !isOverCap ? usedColor : '',
              isUsed && isOverCap ? 'bg-red-500 dark:bg-red-500' : '',
              !isUsed ? 'bg-gray-200 dark:bg-gray-700' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            aria-hidden="true"
            title={isUsed ? (isOverCap ? 'Over cap' : 'Agent slot in use') : 'Free slot'}
          />
        );
      })}
    </div>
  );
};

// ── resource row ─────────────────────────────────────────────────────────────

interface ResourceRowProps {
  label: string;
  pct: number;
  history: number[];
  ariaLabel: string;
}

const ResourceRow: React.FC<ResourceRowProps> = ({ label, pct, history, ariaLabel }) => {
  const tone = pctTone(pct);
  const arrow = trendArrow(history);
  const arrowColor =
    arrow === '▲' ? 'text-red-500 dark:text-red-400' : arrow === '▼' ? 'text-emerald-500 dark:text-emerald-400' : 'text-gray-400';
  return (
    <div className="flex items-center gap-3 py-0.5">
      <div className="w-16 flex-shrink-0 text-[10px] font-semibold uppercase tracking-widest text-gray-400">
        {label}
      </div>
      <div className="flex-1">
        <div
          className="h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800"
          role="progressbar"
          aria-label={ariaLabel}
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={[
              'h-full rounded-full transition-all duration-500',
              tone === 'critical' ? 'bg-red-500' : tone === 'warn' ? 'bg-amber-400' : 'bg-emerald-500',
            ].join(' ')}
            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
          />
        </div>
      </div>
      <div className={`w-7 flex-shrink-0 text-right text-[11px] font-medium ${arrowColor}`} aria-hidden="true">
        {arrow}
      </div>
      <div className="w-8 flex-shrink-0 text-right text-[11px] font-semibold text-gray-700 dark:text-gray-200">
        {fmtPct(pct)}
      </div>
      <div className="flex-shrink-0">
        <Sparkline values={history} tone={tone === 'success' ? 'success' : tone === 'warn' ? 'warn' : 'critical'} label={`${label} trend`} />
      </div>
    </div>
  );
};

// ── raw detail disclosure ─────────────────────────────────────────────────────

interface RawDetailProps {
  gov: GovernancePayload;
}

const RawDetail: React.FC<RawDetailProps> = ({ gov }) => {
  const [open, setOpen] = useState(false);
  const s = gov.health.sample;
  const rows: [string, string][] = [
    ['rssMb', `${s.rssMb.toFixed(1)} MB`],
    ['load1', s.load1.toFixed(2)],
    ['ncpu', String(s.ncpu)],
    ['freeRatio', s.freeRatio.toFixed(3)],
    ['agents', String(s.agents)],
    ['hosts', String(s.hosts)],
    ['wipCap', String(gov.wipCap)],
    ['maxAgents', String(gov.maxAgents)],
    ['sample age', relativeAge(gov.health.at)],
  ];
  if (gov.federation) {
    rows.push(['federation.coordinator', String(gov.federation.coordinator)]);
    rows.push(['federation.dbRegistry', String(gov.federation.dbRegistry)]);
  }

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800"
    >
      <summary
        className="flex cursor-pointer select-none items-center justify-between gap-2 bg-white dark:bg-gray-900 px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors"
        aria-label="Toggle raw daemon details"
      >
        <span className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">
          Raw daemon details
        </span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-gray-400" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-gray-400" aria-hidden="true" />
        )}
      </summary>
      {open && (
        <div className="divide-y divide-gray-100 dark:divide-gray-800 bg-white dark:bg-gray-900">
          {rows.map(([key, val]) => (
            <div key={key} className="flex items-center justify-between px-4 py-2 text-xs">
              <span className="font-mono text-gray-500 dark:text-gray-400">{key}</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">{val}</span>
            </div>
          ))}
        </div>
      )}
    </details>
  );
};

// ── main panel ────────────────────────────────────────────────────────────────

export const FleetHealthPanel: React.FC = () => {
  const { connected, showToast } = useTaskContext();

  const [gov, setGov] = useState<GovernancePayload | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const g = await apiJson<GovernancePayload>('/api/governance');
      setGov(g);
      setError('');
    } catch {
      setError('Could not reach the daemon for fleet status.');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), 10_000);
    return () => clearInterval(interval);
  }, [load]);

  // capacity is re-derived on every gov update
  const cap = useMemo(() => computeCapacity(gov), [gov]);

  // rolling histories — appended every poll
  const memHistory = useRollingHistory(cap.memPct);
  const loadHistory = useRollingHistory(cap.loadPct);

  // spawn-gate status from warnings + freeRatio
  const warnings = gov?.health?.warnings ?? [];
  const freeRatio = gov?.health?.sample?.freeRatio ?? 1;
  const spawnGateOpen = cap.verdict !== 'critical' && warnings.length === 0 && freeRatio >= 0.1;
  const spawnGateReason = !spawnGateOpen
    ? warnings[0] ?? (freeRatio < 0.1 ? `low host free memory (${Math.round(freeRatio * 100)}%)` : 'resource pressure')
    : null;

  const handleRaiseCap = useCallback(() => {
    showToast(
      'WIP cap is controlled by OMP_SQUAD_WIP_CAP — raise it and restart the daemon to allow more concurrent agents.',
      'info',
    );
  }, [showToast]);

  // ── subtitle: verdict badge + headline ──
  const subtitle = (
    <span className="flex items-center gap-2">
      <VerdictBadge verdict={cap.verdict}>{cap.verdict === 'healthy' ? 'Healthy' : cap.verdict === 'warn' ? 'Warning' : 'Critical'}</VerdictBadge>
      <span className="text-gray-400">·</span>
      <span>{cap.headline}</span>
      {!connected && <span className="text-red-500 dark:text-red-400">· daemon offline</span>}
    </span>
  );

  const refresh = (
    <button
      onClick={() => void load()}
      className="flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-600 dark:text-gray-300 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      title="Refresh"
      aria-label="Refresh fleet capacity"
    >
      <RefreshCw className="h-3 w-3" aria-hidden="true" />
    </button>
  );

  return (
    <PanelShell icon={<Activity className="h-4 w-4 text-blue-500" aria-hidden="true" />} title="Fleet capacity" subtitle={subtitle} actions={refresh}>
      {/* ── Loading skeleton ── */}
      {!loaded && !error && (
        <div className="space-y-3 animate-pulse" aria-busy="true" aria-label="Loading fleet capacity">
          <div className="h-16 rounded-lg bg-gray-100 dark:bg-gray-800" />
          <div className="flex gap-3">
            <div className="h-20 flex-1 rounded-lg bg-gray-100 dark:bg-gray-800" />
            <div className="h-20 flex-1 rounded-lg bg-gray-100 dark:bg-gray-800" />
          </div>
          <div className="h-12 rounded-lg bg-gray-100 dark:bg-gray-800" />
        </div>
      )}

      {/* ── Error state ── */}
      {loaded && error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-4 text-sm text-red-700 dark:text-red-300"
        >
          {error}
        </div>
      )}

      {/* ── Loaded ── */}
      {loaded && !error && gov && (
        <>
          {/* Warnings callout — prominent and first when present */}
          {warnings.length > 0 && (
            <Callout
              tone={cap.verdict === 'critical' ? 'critical' : 'warn'}
              title={warnings.length === 1 ? warnings[0] : `${warnings.length} resource warnings`}
            >
              {warnings.length > 1 && (
                <ul className="mt-1 list-inside list-disc space-y-0.5">
                  {warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
            </Callout>
          )}

          {/* ── Capacity hero ── */}
          <SectionCard
            title="Agent slots"
            right={
              <span className="text-xs font-semibold text-gray-600 dark:text-gray-300">
                {cap.used} / {cap.cap} used
                {cap.roomFor > 0 ? (
                  <span className="ml-1 text-emerald-600 dark:text-emerald-400">· room for {cap.roomFor} more</span>
                ) : (
                  <span className="ml-1 text-amber-600 dark:text-amber-400">· at cap</span>
                )}
              </span>
            }
          >
            <div className="px-4 py-3 space-y-3">
              <CapacityBar used={cap.used} cap={cap.cap} roomFor={cap.roomFor} verdict={cap.verdict} />

              {/* Spawn-gate status */}
              <div className="flex items-center gap-2">
                <span
                  className={[
                    'h-2 w-2 flex-shrink-0 rounded-full',
                    spawnGateOpen ? 'bg-emerald-500' : 'bg-red-500',
                  ].join(' ')}
                  aria-hidden="true"
                />
                <span className="text-xs text-gray-700 dark:text-gray-300">
                  {spawnGateOpen ? (
                    <strong className="font-semibold text-emerald-600 dark:text-emerald-400">Spawns flowing</strong>
                  ) : (
                    <>
                      <strong className="font-semibold text-red-600 dark:text-red-400">Spawns throttled</strong>
                      {spawnGateReason && (
                        <span className="text-gray-500 dark:text-gray-400"> — {spawnGateReason}</span>
                      )}
                    </>
                  )}
                </span>
              </div>
            </div>
          </SectionCard>

          {/* ── Resource stat tiles ── */}
          <div className="flex flex-wrap gap-3">
            <StatTile
              label="Memory"
              value={fmtPct(cap.memPct)}
              sub={`${trendArrow(memHistory)} of 1024 MB ceiling`}
              spark={memHistory}
              tone={pctTone(cap.memPct)}
            />
            <StatTile
              label="Load"
              value={fmtPct(cap.loadPct)}
              sub={`${trendArrow(loadHistory)} of 2×/CPU ceiling`}
              spark={loadHistory}
              tone={pctTone(cap.loadPct)}
            />
            <StatTile
              label="Free mem"
              value={fmtPct(freeRatio * 100)}
              sub={freeRatio < 0.1 ? 'below safe floor' : 'host free'}
              tone={freeRatio < 0.1 ? 'critical' : freeRatio < 0.2 ? 'warn' : 'success'}
            />
          </div>

          {/* ── Resource resource trend section ── */}
          {(memHistory.length > 1 || loadHistory.length > 1) && (
            <SectionCard title="Resource trends">
              <div className="px-4 py-3 space-y-2">
                <ResourceRow
                  label="Memory"
                  pct={cap.memPct}
                  history={memHistory}
                  ariaLabel={`Daemon memory at ${Math.round(cap.memPct)}% of 1024 MB ceiling`}
                />
                <ResourceRow
                  label="Load"
                  pct={cap.loadPct}
                  history={loadHistory}
                  ariaLabel={`Host load at ${Math.round(cap.loadPct)}% of 2× per CPU ceiling`}
                />
              </div>
            </SectionCard>
          )}

          {/* ── Next limit prediction ── */}
          {cap.nextLimit && cap.verdict !== 'critical' && (
            <Callout tone="info" title={`Next limit: ${cap.nextLimit}`}>
              {cap.roomFor > 0
                ? `You have room for ${cap.roomFor} more agent${cap.roomFor === 1 ? '' : 's'}. This resource will gate new spawns first.`
                : 'No additional agents can start until this limit eases.'}
              {cap.nextLimit.includes('WIP cap') && (
                <span>
                  {' '}
                  To raise it, set <code className="rounded bg-gray-100 dark:bg-gray-800 px-1 py-0.5 font-mono text-[11px]">OMP_SQUAD_WIP_CAP</code> and
                  restart the daemon.{' '}
                  <button
                    onClick={handleRaiseCap}
                    className="underline text-blue-600 dark:text-blue-400 hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  >
                    More info
                  </button>
                </span>
              )}
            </Callout>
          )}

          {/* ── Healthy calm state ── */}
          {cap.verdict === 'healthy' && warnings.length === 0 && (
            <Callout tone="success" title={cap.headline} />
          )}

          {/* ── Raw daemon details disclosure ── */}
          <RawDetail gov={gov} />
        </>
      )}

      {/* ── Loaded but gov was null (edge case) ── */}
      {loaded && !error && !gov && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 p-4 text-sm text-gray-500 dark:text-gray-400">
          No governance data available yet.
        </div>
      )}
    </PanelShell>
  );
};
