/**
 * HeatPanel — "Activity & hotspots", rebuilt as a Context Heat Graph.
 *
 * LEADS WITH A VERDICT, then shows the codebase heat the way a heat graph should
 * look: a magma folder-tree matrix (HeatTree) you can fold, scan, and read at a
 * glance — not a flat top-N list or raw JSON.
 *
 * Layout, top to bottom:
 *   1. Collision callout — files ≥2 LIVE agents are editing right now (the
 *      omp-squad-specific merge-conflict prediction; nothing else gives you this).
 *   2. Controls         — time range (wired to /api/heat?days=) + pattern toggle.
 *   3. Legend           — the magma cold→hot ramp.
 *   4. HeatTree         — the magma folder-tree heat matrix (the centerpiece).
 *   5. Top hot areas    — ranked files with an honest 0–100 score + trend tag.
 *   6. Raw heat data    — collapsed <details> for power users.
 *
 * Every number traces to real receipt data — see lib/heatmap.ts. No fabricated
 * "complexity"/"coupling" metrics.
 *
 * Shared foundation (imported, not reimplemented):
 *   - detectCollisions / HeatPayload / UsagePayload from insights
 *   - buildHeatTree / rankHotAreas / agentsByFileMap / initialExpanded / magma
 *     / MAGMA_GRADIENT from lib/heatmap
 *   - PanelShell / VerdictBadge / Callout / SectionCard / HeatTree from ./ui
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Flame, RefreshCw, Users, Sparkles } from 'lucide-react';
import { apiJson } from '../lib/api';
import { useTaskContext } from '../context/TaskContext';
import { detectCollisions, type HeatPayload, type UsagePayload } from '../lib/insights';
import {
  buildHeatTree,
  rankHotAreas,
  agentsByFileMap,
  initialExpanded,
  magma,
  MAGMA_GRADIENT,
  type HotArea,
  type HotAreaTag,
} from '../lib/heatmap';
import { PanelShell, VerdictBadge, Callout, SectionCard, HeatTree } from './ui';
import { focusTaskSearch } from '../lib/jump';

// ──────────────────────────────── helpers ────────────────────────────────────

/** Shorten a long path to the last two segments for tight display. */
function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join('/')}`;
}

/** Split "a/b/c.ts" into a muted dir prefix + a highlighted filename. */
function splitPath(p: string): { dir: string; file: string } {
  const idx = p.lastIndexOf('/');
  if (idx === -1) return { dir: '', file: p };
  return { dir: p.slice(0, idx + 1), file: p.slice(idx + 1) };
}

const TAG_CLASS: Record<HotAreaTag, string> = {
  'CORE HOTSPOT': 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
  CONTESTED: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  GROWING: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  STEADY: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
};

const RANGES = [7, 14, 30] as const;

/** A tiny magma strip showing a file's per-day trend, normalized to its own peak. */
const MagmaStrip: React.FC<{ daily: number[] }> = ({ daily }) => {
  const max = Math.max(0, ...daily);
  return (
    <span className="flex h-3 gap-px overflow-hidden rounded-sm" aria-hidden="true">
      {daily.map((v, i) => (
        <span key={i} className="w-1.5" style={{ backgroundColor: magma(max > 0 ? v / max : 0) }} />
      ))}
    </span>
  );
};

const HotAreaCard: React.FC<{ area: HotArea }> = ({ area }) => {
  const { dir, file } = splitPath(area.path);
  return (
    <li className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 text-sm font-semibold tabular-nums text-gray-400">{area.rank}</span>
          <p className="min-w-0 break-all text-sm font-medium leading-snug" title={area.path}>
            <span className="text-gray-400 dark:text-gray-500">{dir}</span>
            <span className="text-orange-600 dark:text-orange-400">{file}</span>
          </p>
        </div>
        <span className="shrink-0 text-base font-semibold tabular-nums text-gray-900 dark:text-gray-100" title={`${area.total} touches`}>
          {area.score}
        </span>
      </div>
      <p className="mt-2 pl-6 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{area.description}</p>
      <div className="mt-2 flex items-center justify-between gap-2 pl-6">
        <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${TAG_CLASS[area.tag]}`}>
          {area.tag}
        </span>
        <MagmaStrip daily={area.daily} />
      </div>
    </li>
  );
};

// ──────────────────────────────── component ──────────────────────────────────

export const HeatPanel: React.FC = () => {
  const { agents } = useTaskContext();

  const [days, setDays] = useState<(typeof RANGES)[number]>(14);
  const [showPatterns, setShowPatterns] = useState(true);
  const [heat, setHeat] = useState<HeatPayload | null>(null);
  const [usage, setUsage] = useState<UsagePayload | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [h, u] = await Promise.all([
        apiJson<HeatPayload>(`/api/heat?days=${days}`).catch((): null => null),
        apiJson<UsagePayload>('/api/usage?limit=200').catch((): null => null),
      ]);
      setHeat(h);
      setUsage(u);
      setError('');
    } catch {
      setError('Could not reach the daemon for heat data.');
    } finally {
      setLoaded(true);
    }
  }, [days]);

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 10_000);
    return () => clearInterval(iv);
  }, [load]);

  // ── derived signals ──────────────────────────────────────────────────────

  const collisions = useMemo(() => detectCollisions(usage?.runs, agents), [usage?.runs, agents]);

  const agentsByFile = useMemo(() => agentsByFileMap(usage?.runs), [usage?.runs]);

  const tree = useMemo(
    () => buildHeatTree(heat?.tree, heat?.days?.length ?? 0, agentsByFile),
    [heat?.tree, heat?.days, agentsByFile],
  );

  const defaultExpanded = useMemo(() => initialExpanded(tree), [tree]);

  const hotAreas = useMemo(() => rankHotAreas(heat?.tree, agentsByFile, 6), [heat?.tree, agentsByFile]);

  const topContested = hotAreas.find((h) => h.agentCount >= 3) ?? null;

  // ── verdict ──────────────────────────────────────────────────────────────

  const hasCollisions = collisions.length > 0;
  const hasContested = topContested !== null;

  const verdictKind: 'critical' | 'warn' | 'healthy' = hasCollisions ? 'critical' : hasContested ? 'warn' : 'healthy';

  const verdictText = hasCollisions
    ? `${collisions.length} collision risk${collisions.length === 1 ? '' : 's'}${hasContested ? ' · 1 contested file' : ''}`
    : hasContested
      ? '1 contested file'
      : tree.fileCount > 0
        ? `${tree.fileCount} file${tree.fileCount === 1 ? '' : 's'} active`
        : 'No contention';

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
      aria-label="Refresh heat data"
    >
      <RefreshCw className="h-3 w-3" aria-hidden="true" />
    </button>
  );

  return (
    <PanelShell
      icon={<Flame className="h-4 w-4 text-orange-500" aria-hidden="true" />}
      title="Activity &amp; hotspots"
      subtitle={subtitle}
      actions={refresh}
    >
      {/* Loading skeleton */}
      {!loaded && !error && (
        <div className="space-y-3 animate-pulse" aria-label="Loading heat data">
          {[1, 2, 3].map((nn) => (
            <div key={nn} className="h-12 rounded-lg bg-gray-100 dark:bg-gray-800" />
          ))}
        </div>
      )}

      {/* Error */}
      {loaded && error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-4 text-sm text-red-700 dark:text-red-300"
        >
          {error}
        </div>
      )}

      {/* Main body */}
      {loaded && !error && (
        <>
          {/* ── COLLISION CALLOUT (headline) ─────────────────────────────── */}
          {hasCollisions && (
            <Callout
              tone="critical"
              title={`${collisions.length} file${collisions.length === 1 ? '' : 's'} being edited by multiple live agents — likely conflict at land`}
            >
              <ul className="mt-2 space-y-2" aria-label="Collision details">
                {collisions.map((c) => (
                  <li
                    key={c.file}
                    className="flex items-start justify-between gap-3 rounded-md border border-red-200/60 dark:border-red-900/40 bg-white/60 dark:bg-gray-950/40 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-xs font-mono font-medium text-gray-800 dark:text-gray-200" title={c.file}>
                        {shortPath(c.file)}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {c.agents.map((a) => (
                          <span
                            key={a.id}
                            className="inline-flex items-center gap-1 rounded-full bg-red-100 dark:bg-red-900/30 px-2 py-0.5 text-[10px] font-semibold text-red-700 dark:text-red-300"
                          >
                            <Users className="h-2.5 w-2.5" aria-hidden="true" />
                            {a.name}
                          </span>
                        ))}
                      </div>
                    </div>
                    <button
                      onClick={() => focusTaskSearch()}
                      className="flex-shrink-0 rounded-md border border-red-200 dark:border-red-800 bg-white/70 dark:bg-gray-900/50 px-2.5 py-1 text-xs font-medium text-red-600 dark:text-red-400 transition-colors hover:bg-white dark:hover:bg-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                      aria-label={`View agents editing ${shortPath(c.file)}`}
                    >
                      View agents
                    </button>
                  </li>
                ))}
              </ul>
            </Callout>
          )}

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
                        ? 'bg-orange-500 text-white'
                        : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
                    }`}
                    aria-pressed={days === r}
                  >
                    {r}d
                  </button>
                ))}
              </div>
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
              <span>Show peaks</span>
              <button
                type="button"
                role="switch"
                aria-checked={showPatterns}
                aria-label="Show peak markers"
                onClick={() => setShowPatterns((v) => !v)}
                className={`relative h-5 w-9 rounded-full border transition-colors ${
                  showPatterns ? 'border-orange-500 bg-orange-500' : 'border-gray-300 dark:border-gray-600 bg-gray-200 dark:bg-gray-700'
                }`}
              >
                <span
                  className={`absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-white shadow transition-all ${
                    showPatterns ? 'left-[18px]' : 'left-0.5'
                  }`}
                />
              </button>
            </label>
          </div>

          {/* ── LEGEND ───────────────────────────────────────────────────── */}
          <div className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-2.5">
            <span className="text-xs text-gray-500 dark:text-gray-400">Cold</span>
            <div className="h-2.5 flex-1 rounded-full" style={{ background: MAGMA_GRADIENT }} />
            <span className="text-xs text-gray-500 dark:text-gray-400">Hot</span>
          </div>

          {/* ── HEAT TREE (centerpiece) ──────────────────────────────────── */}
          <HeatTree
            key={`heat-${days}`}
            days={heat?.days ?? []}
            tree={tree}
            showPatterns={showPatterns}
            defaultExpanded={defaultExpanded}
          />

          {/* ── TOP HOT AREAS ────────────────────────────────────────────── */}
          {hotAreas.length > 0 && (
            <SectionCard
              title={
                <span className="flex items-center gap-1.5">
                  <Flame className="h-3.5 w-3.5 text-orange-500" aria-hidden="true" />
                  Top hot areas
                </span>
              }
              right={`${hotAreas.length} ranked`}
            >
              <ul className="space-y-2.5 p-3">
                {hotAreas.map((a) => (
                  <HotAreaCard key={a.path} area={a} />
                ))}
              </ul>
            </SectionCard>
          )}

          {/* ── CALM EMPTY STATE ─────────────────────────────────────────── */}
          {!hasCollisions && tree.fileCount === 0 && (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/20 px-6 py-8 text-center">
              <Sparkles className="h-7 w-7 text-emerald-400" aria-hidden="true" />
              <div className="text-sm font-semibold text-gray-600 dark:text-gray-300">No hot files in the last {days} days</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">No receipt-backed file writes — all clear.</div>
            </div>
          )}

          {/* ── RAW HEAT DATA (collapsed) ────────────────────────────────── */}
          {heat && (
            <details className="group rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-xs">
              <summary className="flex cursor-pointer select-none items-center gap-2 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-widest text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500 list-none">
                <span className="mr-auto">Raw heat data</span>
                <span className="text-gray-300 dark:text-gray-600 group-open:rotate-180 transition-transform" aria-hidden="true">
                  ▾
                </span>
              </summary>
              <div className="border-t border-gray-100 dark:border-gray-800 px-4 py-3">
                <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[10px] text-gray-600 dark:text-gray-400 leading-relaxed">
                  {JSON.stringify(heat, null, 2)}
                </pre>
              </div>
            </details>
          )}
        </>
      )}
    </PanelShell>
  );
};
