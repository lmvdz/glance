/**
 * CommandPalette — the REAL ⌘K (GRAPH-FOLD.md §1 "Knowledge base" fold + §3 "⌘K palette").
 *
 * ⌘K used to be a single-purpose binding: jump to the Tasks search box (PR #124). The fold
 * upgrades it into a real command palette, open from EVERY view:
 *
 *   · nav jump — the rail's nav items (Fleet · Tasks · Graph · Fog · Capabilities) + Org settings
 *   · "Search tasks…" — the old direct binding, demoted to a row (it still jump-focuses the
 *     Tasks search box; the hotkey itself now always opens this palette)
 *   · Fabric/Knowledge search — the dead Knowledge-base page's GET /api/fabric/search, debounced,
 *     because lookups have no time axis and never belonged in the Graph
 *
 * TODO(Wave 6 — chat work): an "Ask about this page" row that hands the current view/selection to
 * the assistant as context. Deliberately NOT stubbed here — a disabled row would be chrome nobody
 * can act on yet.
 *
 * All row assembly/filter/selection logic is pure in lib/commandPalette.ts (DOM-free tested);
 * this component owns only the fetch, the keyboard wiring, and the chrome.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Boxes, Building2, CloudFog, CornerDownLeft, Inbox, Layers, Library, Search, Waypoints, type LucideIcon } from 'lucide-react';
import { useTaskContext, type AppView } from '../context/TaskContext';
import { apiJson } from '../lib/api';
import { reportAnswerRead } from '../lib/attention';
import { jumpToTaskSearch } from '../lib/jump';
import { buildRows, moveSelection, type FabricSearchResult, type PaletteRow } from '../lib/commandPalette';
import { Kbd } from './kit/Kbd';

/** Icons for the static rows — mirrors the rail's icon grammar so a palette jump and a rail click
 *  read as the same destination. */
const NAV_ICONS: Record<string, LucideIcon> = {
  'nav-fleet': Layers,
  'nav-tasks': Inbox,
  'nav-graph': Waypoints,
  'nav-fog': CloudFog,
  'nav-capabilities': Boxes,
  'nav-org': Building2,
  'action-search-tasks': Search,
};

interface FabricSearchResponse {
  query: string;
  results: FabricSearchResult[];
}

const ROW_ID_PREFIX = 'command-palette-row-';

export const CommandPalette: React.FC = () => {
  const { isCommandPaletteOpen, closeCommandPalette, view, setView } = useTaskContext();
  const [query, setQuery] = useState('');
  const [fabricResults, setFabricResults] = useState<FabricSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const reqRef = useRef(0);

  // Fresh open = fresh palette: clear the previous session's query/results and focus the input.
  useEffect(() => {
    if (!isCommandPaletteOpen) return;
    setQuery('');
    setFabricResults([]);
    setSelectedIndex(0);
    // Focus after this render commits (the input mounts with the overlay).
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [isCommandPaletteOpen]);

  // Debounced fabric search — typing filters the static rows instantly; the KB search fires
  // 250ms after the last keystroke (same debounce the dead KnowledgePanel used). Guarded by a
  // request sequence so a slow older response can never clobber a newer query's results.
  useEffect(() => {
    if (!isCommandPaletteOpen) return;
    const q = query.trim();
    if (!q) {
      setFabricResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const id = ++reqRef.current;
    const t = setTimeout(() => {
      void apiJson<FabricSearchResponse>(`/api/fabric/search?q=${encodeURIComponent(q)}&topK=12`)
        .then((r) => {
          if (id !== reqRef.current) return;
          setFabricResults(Array.isArray(r?.results) ? r.results : []);
        })
        .catch(() => {
          if (id === reqRef.current) setFabricResults([]);
        })
        .finally(() => {
          if (id === reqRef.current) setSearching(false);
        });
    }, 250);
    return () => clearTimeout(t);
  }, [query, isCommandPaletteOpen]);

  const rows = useMemo(() => buildRows(query, fabricResults), [query, fabricResults]);

  // Keep the selection valid as the row list changes under the query.
  useEffect(() => {
    setSelectedIndex((i) => Math.max(0, Math.min(rows.length - 1, i)));
  }, [rows.length]);

  const runRow = useCallback(
    (row: PaletteRow) => {
      closeCommandPalette();
      if (row.kind === 'nav') {
        setView(row.view);
        return;
      }
      if (row.kind === 'action' && row.action === 'search-tasks') {
        // The old ⌘K behavior (PR #124), now one palette row: route to Tasks and focus its
        // search box on the next tick.
        jumpToTaskSearch(view, setView as (v: AppView) => void);
        return;
      }
      // Fabric rows are knowledge-base facts, not routes — the KB's home after the fold is the
      // Graph, so open it; the fact's title/snippet were already read in the palette itself.
      if (row.kind === 'fabric') {
        // Comprehension concern 10: selecting an answer row IS the explicit "displayed to the
        // operator" moment `reportAnswerRead` exists for (DESIGN.md's "client-side explicit acks
        // only" rule) — a client-side ack fired once, here, not a GET/poll hook. `row.repo`/`row.ref`
        // are always present for an answer fact (`FabricAnswerFact.source.repo`/`.id`); the guard is
        // defensive, not expected to trip.
        if (row.type === 'answer' && row.repo && row.ref) reportAnswerRead(row.repo, row.ref);
        setView('omp-graph');
      }
    },
    [closeCommandPalette, setView, view],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeCommandPalette();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => {
          const next = moveSelection(rows.length, i, e.key === 'ArrowDown' ? 1 : -1);
          document.getElementById(`${ROW_ID_PREFIX}${next}`)?.scrollIntoView({ block: 'nearest' });
          return next;
        });
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const row = rows[selectedIndex];
        if (row) runRow(row);
      }
    },
    [rows, selectedIndex, closeCommandPalette, runRow],
  );

  if (!isCommandPaletteOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh] backdrop-blur-[2px]"
      role="presentation"
      onMouseDown={(e) => {
        // Click on the scrim (not the panel) dismisses — standard palette behavior.
        if (e.target === e.currentTarget) closeCommandPalette();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        // Taste-review nit 2: a ~150ms scale+fade entrance (brand.md's micro-interaction beat,
        // GPU transform/opacity only) so the palette settles in instead of appearing instantly.
        // `.palette-rise` is a no-op transition/animation under prefers-reduced-motion.
        className="palette-rise w-full max-w-xl overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-[#2A2A2E] dark:bg-[#0C0C0E]"
        onKeyDown={onKeyDown}
      >
        {/* Search input — the palette's one focal point (brand.md: one ember signal per view). */}
        <div className="relative border-b border-gray-200 dark:border-[#1C1C20]">
          <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-[#5C5C62]" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0); }}
            placeholder="Jump to a view, or search the fleet's memory…"
            aria-label="Command palette search"
            className="w-full bg-transparent py-3.5 pl-11 pr-20 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none dark:text-gray-100 dark:placeholder:text-[#5C5C62]"
          />
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <Kbd keys="esc" label="close" />
          </div>
        </div>

        {/* Rows */}
        <ul ref={listRef} className="max-h-[50vh] overflow-y-auto py-1" role="listbox" aria-label="Commands and results">
          {rows.length === 0 && !searching && (
            <li className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
              Nothing matches. Try a view name, a file path, or a decision.
            </li>
          )}
          {rows.map((row, i) => {
            const active = i === selectedIndex;
            const Icon = row.kind === 'fabric' ? Library : NAV_ICONS[row.id] ?? Search;
            return (
              <li key={row.id} role="option" aria-selected={active} id={`${ROW_ID_PREFIX}${i}`}>
                <button
                  type="button"
                  onClick={() => runRow(row)}
                  onMouseMove={() => setSelectedIndex(i)}
                  className={`flex w-full items-center gap-3 px-4 py-2 text-left transition-colors focus:outline-none ${
                    active
                      ? 'bg-amber-50 dark:bg-[color:var(--wf-accent-soft)]'
                      : 'hover:bg-gray-50 dark:hover:bg-[#151517]'
                  }`}
                >
                  <Icon className={`h-4 w-4 flex-shrink-0 ${active ? 'text-amber-600 dark:text-[color:var(--wf-accent)]' : 'text-gray-400 dark:text-[#5C5C62]'}`} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-sm ${active ? 'font-medium text-gray-900 dark:text-gray-100' : 'text-gray-700 dark:text-gray-300'}`}>
                      {row.label}
                    </span>
                    {row.kind === 'fabric' && (
                      <span className="mt-0.5 block truncate text-xs text-gray-500 dark:text-gray-400">{row.snippet}</span>
                    )}
                  </span>
                  {row.kind === 'fabric' && (
                    <span className="flex-shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-500 dark:bg-[#151517] dark:text-gray-400">
                      {row.typeLabel}
                    </span>
                  )}
                  {row.kind === 'nav' && (
                    <span className="flex-shrink-0 text-[10px] font-medium uppercase tracking-wider text-gray-400 dark:text-[#5C5C62]">
                      {row.view === 'org' ? 'settings' : 'view'}
                    </span>
                  )}
                  {active && <Kbd keys="↵" className="flex-shrink-0" />}
                </button>
              </li>
            );
          })}
          {searching && (
            <li className="flex items-center gap-2 px-4 py-2 text-xs text-gray-400 dark:text-gray-500" aria-live="polite">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" aria-hidden="true" />
              Searching the knowledge base…
            </li>
          )}
        </ul>

        {/* Footer — kbd legend per the reference language (kit/Kbd chips, never bare tooltips). */}
        <div className="flex items-center gap-4 border-t border-gray-200 px-4 py-2 dark:border-[#1C1C20]">
          <Kbd keys="↑↓" label="navigate" />
          <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-gray-400 dark:text-gray-500">
            <kbd className="rounded border border-gray-300 bg-gray-100 px-1 py-0.5 leading-none text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
              <CornerDownLeft className="h-2.5 w-2.5" aria-hidden="true" />
            </kbd>
            open
          </span>
          <Kbd keys="⌘K" label="toggle" className="ml-auto" />
        </div>
      </div>
    </div>
  );
};
