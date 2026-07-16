/**
 * HeatTree — the "Context Heat Graph": a collapsible folder tree on the left, a
 * magma heat matrix (one cell per file/folder per day) on the right. Replaces a
 * flat top-N list with the actual codebase structure, so you can see WHICH
 * MODULE is hot, fold cold subtrees away, and read intensity at a glance.
 *
 * Rendered on a FIXED DARK CANVAS in both light and dark app themes: the magma
 * ramp is a color space of its own (like any scientific heatmap) and only reads
 * correctly against a dark background.
 *
 * Two parallel columns (tree labels, heat cells) iterate the SAME flattened,
 * fixed-row-height list, so rows stay pixel-aligned as folders expand/collapse.
 *
 * Comprehension-fog overlay (concern 04): a "Fog" toggle next to the heat mode
 * swaps the same grid's cells to a tri-state comprehension-debt read instead of
 * touch-count heat. Every DECISION — the join, folder aggregation, cold-start
 * gating, shortlist ranking — lives in `heatmap.ts`'s pure helpers; this file
 * only renders whatever they return, plus the small amount of local UI state
 * (toggle on/off, which node is focused/expanded) any renderer owns.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen, FileCode2, FileText, Users } from 'lucide-react';
import {
  magma,
  flattenTree,
  attachFog,
  coldStartRepos,
  topFogDebt,
  fogLastSeenLabel,
  fogEntryKey,
  nodeFogKey,
  ancestorFolderIds,
  allFilesColdStart,
  type HeatTree as HeatTreeData,
  type HeatTreeNode,
} from '../../lib/heatmap';
import { fetchFog, type FogPayload } from '../../lib/api';

export interface HeatTreeProps {
  days: string[];
  tree: HeatTreeData;
  /** draw a glowing dot on each file's peak day. */
  showPatterns: boolean;
  /** folder ids expanded on first render. */
  defaultExpanded?: Iterable<string>;
  emptyLabel?: string;
  /** Comprehension-fog overlay data (concern 04). Omit to let the component self-fetch
   *  `GET /api/fog` the first time the operator toggles "Fog" on; pass it when a parent already
   *  has the data (e.g. a future dashboard that fetches heat+fog together) to skip the redundant
   *  network call — and for tests, since this repo's convention is a single `renderToStaticMarkup`
   *  pass with no DOM/click simulation. */
  fogData?: FogPayload;
  /** Seed the "Fog" toggle's initial on/off state. Defaults to off; the operator can always flip
   *  it via the toggle afterward. Mainly for `fogData`-preloaded callers and tests. */
  initialFogMode?: boolean;
}

const ROW_H = 'h-8'; // 32px — also the day-label spacer height
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-06-27" → "Jun 27" (locale-free, SSR-safe). */
function fmtDay(iso: string): string {
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  return MONTHS[m - 1] ? `${MONTHS[m - 1]} ${d}` : iso;
}

/** Intensity 0..1 for a cell, normalized per type (folders dimmed). */
function intensity(node: HeatTreeNode, value: number, tree: HeatTreeData): number {
  if (node.type === 'folder') {
    return tree.maxFolderCell > 0 ? (value / tree.maxFolderCell) * 0.85 : 0;
  }
  return tree.maxFileCell > 0 ? value / tree.maxFileCell : 0;
}

function FileIcon({ name }: { name: string }): React.ReactElement {
  const isDoc = /\.(md|txt|json|ya?ml|toml|lock)$/i.test(name);
  const Icon = isDoc ? FileText : FileCode2;
  return <Icon className="ml-[18px] h-3.5 w-3.5 shrink-0 text-white/40" aria-hidden="true" />;
}

/** A never-seen cell's hatch pattern — a fixed slate/blue hue with diagonal stripes, DELIBERATELY
 *  never amber/red (that's the `stale` ramp's color language; DESIGN.md's "Fog UI" row: tri-state
 *  must read as three distinct signals, not "red is bad, redder is worse"). Stripe opacity scales
 *  with `debt` so a heavily-churned never-seen file still reads louder than a barely-touched one,
 *  but the HUE staying fixed is what makes the pattern "distinct from red," not just its texture. */
function neverSeenStyle(debt: number): React.CSSProperties {
  const opacity = 0.18 + Math.min(1, Math.max(0, debt)) * 0.42;
  return {
    backgroundColor: 'rgba(30, 41, 59, 0.92)',
    backgroundImage: `repeating-linear-gradient(135deg, rgba(148,163,184,${opacity}) 0px, rgba(148,163,184,${opacity}) 3px, transparent 3px, transparent 7px)`,
  };
}

/** `seen-current` — clear/dimmed: a barely-there fill, "you're caught up here," never competing
 *  visually with a real debt signal. */
const SEEN_CURRENT_STYLE: React.CSSProperties = { backgroundColor: 'rgba(255,255,255,0.045)' };

/** A node whose repo has no fog signal at all yet for THIS request — either it's cold-start (see
 *  `coldStartRepos`) or genuinely out of the fog endpoint's scope (honest "no data," never "zero
 *  debt"). Visually neutral and flatly distinct from all three real tri-states. */
const NO_FOG_DATA_STYLE: React.CSSProperties = { backgroundColor: 'rgba(255,255,255,0.02)' };

/** Resolve one cell's fog-mode visual + tooltip. Pure presentation only — every INPUT here
 *  (`node.fog`, repo cold-start membership) was already decided by `heatmap.ts`'s pure helpers. */
function fogVisual(node: HeatTreeNode, coldStart: Set<string>): { style: React.CSSProperties; title: string } {
  if (node.repo && coldStart.has(node.repo)) {
    return { style: NO_FOG_DATA_STYLE, title: 'no view history yet for this repo' };
  }
  if (!node.fog) {
    return { style: NO_FOG_DATA_STYLE, title: 'no fog data for this node' };
  }
  const pct = Math.round(node.fog.debt * 100);
  if (node.fog.state === 'never-seen') {
    return { style: neverSeenStyle(node.fog.debt), title: `never seen · debt ${pct}%` };
  }
  if (node.fog.state === 'seen-current') {
    return { style: SEEN_CURRENT_STYLE, title: `seen — caught up · debt ${pct}%` };
  }
  return { style: { backgroundColor: magma(node.fog.debt) }, title: `stale since last seen · debt ${pct}%` };
}

export const HeatTree: React.FC<HeatTreeProps> = ({
  days,
  tree,
  showPatterns,
  defaultExpanded,
  emptyLabel = 'No receipt-backed file writes in this window.',
  fogData,
  initialFogMode,
}) => {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(defaultExpanded ?? []));
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<{ label: string; day: string; value: number } | null>(null);

  const [fogMode, setFogMode] = useState(initialFogMode ?? false);
  const [fetchedFog, setFetchedFog] = useState<FogPayload | null>(null);
  const [fogLoading, setFogLoading] = useState(false);
  const [fogError, setFogError] = useState(false);
  const fogPayload = fogData ?? fetchedFog;

  // Self-fetch GET /api/fog the first time fog mode is toggled on, unless a parent already
  // supplied `fogData` (see the prop's own doc). Never re-fetches while a payload is already held.
  useEffect(() => {
    if (fogData || !fogMode || fetchedFog || fogLoading) return;
    let cancelled = false;
    setFogLoading(true);
    setFogError(false);
    fetchFog()
      .then((payload) => {
        if (!cancelled) setFetchedFog(payload);
      })
      .catch(() => {
        if (!cancelled) setFogError(true);
      })
      .finally(() => {
        if (!cancelled) setFogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fogData, fogMode, fetchedFog, fogLoading]);

  const effectiveTree = useMemo(
    () => (fogMode && fogPayload && !fogPayload.disabled ? attachFog(tree, fogPayload.entries) : tree),
    [fogMode, fogPayload, tree],
  );
  const coldStart = useMemo(() => (fogPayload ? coldStartRepos(fogPayload.repoHasHistory) : new Set<string>()), [fogPayload]);
  const shortlist = useMemo(() => (fogPayload && !fogPayload.disabled ? topFogDebt(fogPayload.entries, fogPayload.repoHasHistory, 10) : []), [fogPayload]);
  const wholeTreeColdStart = useMemo(
    () => (fogPayload && !fogPayload.disabled ? allFilesColdStart(effectiveTree, coldStart) : false),
    [effectiveTree, coldStart, fogPayload],
  );
  const keyToNodeId = useMemo(() => {
    const map = new Map<string, string>();
    const walk = (nodes: HeatTreeNode[]): void => {
      for (const n of nodes) {
        if (n.type === 'file') {
          const k = nodeFogKey(n);
          if (k) map.set(k, n.id);
        } else {
          walk(n.children);
        }
      }
    };
    walk(effectiveTree.roots);
    return map;
  }, [effectiveTree]);

  const rows = useMemo(() => flattenTree(effectiveTree.roots, expanded), [effectiveTree.roots, expanded]);
  const n = days.length;

  if (rows.length === 0 || n === 0) {
    return (
      <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-[#0c0a1e] px-4 py-10 text-center text-sm text-white/50">
        {emptyLabel}
      </div>
    );
  }

  const toggle = (id: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** "Click focuses tree node" (shortlist row → tree row): expand every ancestor folder and select
   *  the node itself — the scroll-into-view effect below fires once that commits, so a node inside
   *  a currently-collapsed folder is both revealed AND scrolled to in one click. */
  const focusNode = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const a of ancestorFolderIds(id)) next.add(a);
      return next;
    });
    setSelected(id);
  };

  // Runs after `expanded`/`selected` commit (including from a plain row click, where it's a
  // harmless no-op — the clicked row is already in view) — the one place actual scrolling happens,
  // so `focusNode` above never has to guess at render timing.
  useEffect(() => {
    if (!selected) return;
    document.getElementById(`heat-row-${selected}`)?.scrollIntoView({ block: 'nearest' });
  }, [selected, expanded]);

  const gridCols = { gridTemplateColumns: `repeat(${n}, minmax(14px, 1fr))` } as React.CSSProperties;

  // Fog is "showing" (grid cells switch to tri-state) only once real, non-disabled data has
  // arrived and the whole visible tree isn't cold-start (that case gets its own empty state below,
  // never a hatched wall — DESIGN.md's "cold-start red wall," RT2-12).
  const showFog = fogMode && !!fogPayload && !fogPayload.disabled && !wholeTreeColdStart;

  const fogGateMessage: string | null = !fogMode
    ? null
    : fogPayload?.disabled
      ? 'Comprehension fog is disabled for this daemon.'
      : fogLoading && !fogPayload
        ? 'Loading fog overlay…'
        : fogError
          ? "Couldn't load the fog overlay."
          : fogPayload && wholeTreeColdStart
            ? 'No view history yet — fog appears once views are recorded.'
            : null;

  return (
    <section className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800 bg-[#0c0a1e] text-white">
      {/* ── mode toggle ── */}
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-white/45">
          {fogMode ? 'Comprehension fog' : 'Context heat graph'}
        </span>
        <button
          type="button"
          onClick={() => setFogMode((v) => !v)}
          aria-pressed={fogMode}
          className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide transition-colors ${
            fogMode ? 'bg-indigo-500/30 text-indigo-200' : 'bg-white/5 text-white/50 hover:bg-white/10'
          }`}
        >
          Fog{fogMode ? ': on' : ''}
        </button>
      </div>

      {/* ── disclosure (persistent while fog mode is active) ── */}
      {fogMode && (
        <p className="border-b border-white/10 px-4 py-1.5 text-[10px] leading-relaxed text-white/40">
          view activity is recorded to compute this overlay · team-level, renames reset history
        </p>
      )}

      {fogGateMessage ? (
        <div className="px-4 py-10 text-center text-sm text-white/50">{fogGateMessage}</div>
      ) : (
        <>
          {/* ── top-10 debt shortlist headline ── */}
          {showFog && shortlist.length > 0 && (
            <div className="border-b border-white/10 px-4 py-3">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-white/45">
                Comprehension debt — top {shortlist.length}
              </div>
              <ul className="space-y-0.5">
                {shortlist.map((entry) => {
                  const key = fogEntryKey(entry.repo, entry.file);
                  const nodeId = keyToNodeId.get(key);
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        onClick={() => nodeId && focusNode(nodeId)}
                        disabled={!nodeId}
                        className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-white/80 transition-colors hover:bg-white/5 disabled:cursor-default disabled:opacity-60"
                      >
                        <span className="min-w-0 flex-1 truncate font-mono">{entry.file}</span>
                        <span className="shrink-0 text-white/50">last seen {fogLastSeenLabel(entry.lastSeenAt, Date.now())}</span>
                        <span
                          className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                          style={{ backgroundColor: magma(entry.debt), color: '#0c0a1e' }}
                        >
                          {Math.round(entry.debt * 100)}%
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div className="overflow-x-auto">
            <div className="grid min-w-[34rem] grid-cols-[minmax(11rem,18rem)_1fr]">
              {/* ── headers ── */}
              <div className="border-b border-r border-white/10 px-4 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-white/45">
                File / module
              </div>
              <div className="border-b border-white/10 px-3 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-white/45">
                {showFog ? 'Comprehension debt' : 'Heat over time'}
              </div>

              {/* ── tree column ── */}
              <div className="border-r border-white/10">
                {/* spacer aligned to the day-label row */}
                <div className={`${ROW_H} border-b border-white/10`} />
                {rows.map((node) => {
                  const isFolder = node.type === 'folder';
                  const open = expanded.has(node.id);
                  const isSelected = node.id === selected;
                  return (
                    <button
                      key={node.id}
                      id={`heat-row-${node.id}`}
                      type="button"
                      onClick={() => (isFolder ? toggle(node.id) : setSelected(isSelected ? null : node.id))}
                      className={`flex w-full items-center gap-1.5 ${ROW_H} px-3 text-left text-xs transition-colors ${
                        isSelected ? 'bg-white/10 text-white' : 'text-white/80 hover:bg-white/5'
                      }`}
                      style={{ paddingLeft: `${12 + node.depth * 16}px` }}
                      title={node.id}
                    >
                      {isFolder ? (
                        <>
                          {open ? (
                            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-white/40" aria-hidden="true" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-white/40" aria-hidden="true" />
                          )}
                          {open ? (
                            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-white/55" aria-hidden="true" />
                          ) : (
                            <Folder className="h-3.5 w-3.5 shrink-0 text-white/55" aria-hidden="true" />
                          )}
                        </>
                      ) : (
                        <FileIcon name={node.name} />
                      )}
                      <span className={`truncate ${isFolder ? 'font-medium text-white/90' : ''}`}>{node.name}</span>
                      {node.agentCount > 1 && (
                        <span className="ml-auto flex shrink-0 items-center gap-0.5 rounded-full bg-white/10 px-1.5 py-0.5 text-[9px] font-semibold text-white/70">
                          <Users className="h-2.5 w-2.5" aria-hidden="true" />
                          {node.agentCount}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* ── heat / fog grid column ── */}
              <div>
                {/* day labels — fog is a per-file debt READ, not a daily series, so its header
                    row replaces the dates with a single label rather than implying day-resolution
                    data that doesn't exist. */}
                {showFog ? (
                  <div className={`${ROW_H} flex items-center justify-end border-b border-white/10 px-3 text-[10px] font-medium tabular-nums text-white/40`}>
                    debt
                  </div>
                ) : (
                  <div className={`grid ${ROW_H} border-b border-white/10`} style={gridCols}>
                    {days.map((d) => (
                      <div key={d} className="flex items-center justify-center text-[10px] font-medium tabular-nums text-white/40" title={d}>
                        {fmtDay(d)}
                      </div>
                    ))}
                  </div>
                )}

                {rows.map((node) => {
                  const isSelected = node.id === selected;
                  const peak = node.daily.indexOf(Math.max(...node.daily, 0));
                  if (showFog) {
                    const { style, title } = fogVisual(node, coldStart);
                    // ONE spanning cell per row — fog is a single per-file/folder debt read, not a
                    // daily series, so it never fakes per-day resolution across the day columns.
                    return (
                      <div key={node.id} className={`${ROW_H} ${isSelected ? 'ring-1 ring-inset ring-white/40' : ''}`}>
                        <div
                          className="relative h-full border-b border-r border-black/30 transition-[filter] hover:brightness-125"
                          style={style}
                          title={`${node.id} · ${title}`}
                          aria-label={`${node.id}, ${title}`}
                        />
                      </div>
                    );
                  }
                  return (
                    <div key={node.id} className={`grid ${ROW_H} ${isSelected ? 'ring-1 ring-inset ring-white/40' : ''}`} style={gridCols}>
                      {days.map((d, i) => {
                        const v = node.daily[i] ?? 0;
                        const t = intensity(node, v, effectiveTree);
                        const isHot = node.type === 'file' && t > 0.45;
                        return (
                          <div
                            key={d}
                            onMouseEnter={() => setHover({ label: node.name, day: d, value: v })}
                            onMouseLeave={() => setHover(null)}
                            className="relative border-b border-r border-black/30 transition-[filter] hover:brightness-125"
                            style={{ backgroundColor: magma(t) }}
                            title={`${node.id} · ${fmtDay(d)}: ${v} touch${v === 1 ? '' : 'es'}`}
                            aria-label={`${node.id}, ${d}: ${v} touches`}
                          >
                            {showPatterns && isHot && i === peak && (
                              <span className="absolute inset-0 m-auto h-1.5 w-1.5 rounded-full bg-white/85 shadow-[0_0_6px_rgba(255,255,255,0.6)]" />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* footer / hover readout */}
          <div className="flex items-center justify-between gap-4 border-t border-white/10 px-4 py-2.5 text-[11px] text-white/45">
            <span>{showFog ? 'Fog = comprehension debt since you last looked, from agent receipts + your view history.' : 'Heat = files touched per day, from agent receipts.'}</span>
            {!showFog && hover && (
              <span className="shrink-0 font-mono text-white/80">
                {hover.label} · {fmtDay(hover.day)} · <span className="text-amber-300">{hover.value}</span>
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
};
