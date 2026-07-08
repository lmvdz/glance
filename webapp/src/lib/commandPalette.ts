/**
 * commandPalette.ts — pure row-building/filtering logic for the real ⌘K palette
 * (GRAPH-FOLD.md §1 "Knowledge base" fold + §3 "⌘K palette").
 *
 * The Knowledge base page died as a standalone lane — lookups have no time axis, so they don't
 * belong in the Graph. Its search (GET /api/fabric/search) moves here instead, alongside a real
 * nav-jump command list. No React, no fetch: like every other panel's logic in this codebase
 * (insights.ts, fleetRoster.ts, ...), the row assembly/filtering is pure and DOM-free-tested; only
 * the fetch + keyboard wiring lives in CommandPalette.tsx.
 *
 * NOTE (scope): an "Ask about this page" row — handing the current view/selection to the assistant
 * chat as context — is deliberately OUT of scope here. That's Wave 6's chat work (context-aware
 * assistant prompts), not the nav/search palette. Leaving this as a comment, not a disabled row —
 * a stub row would be chrome nobody can act on yet.
 */

import type { AppView } from '../context/TaskContext';

export type PaletteRowKind = 'nav' | 'action' | 'fabric';

interface PaletteRowBase {
  kind: PaletteRowKind;
  /** Stable, unique key across the WHOLE assembled list (nav ids never collide with fabric result ids). */
  id: string;
  label: string;
}

/** Jump to one of the 4 shell views, or Org settings (routed-into, not a top-level nav item). */
export interface PaletteNavRow extends PaletteRowBase {
  kind: 'nav';
  view: AppView;
}

/** "Search tasks…" — the old direct ⌘K→jumpToTaskSearch binding (PR #124), now a row instead of
 *  the hotkey itself (the hotkey now always opens this palette). */
export interface PaletteActionRow extends PaletteRowBase {
  kind: 'action';
  action: 'search-tasks';
}

/** One ranked GET /api/fabric/search hit, shaped for the row list. */
export interface PaletteFabricRow extends PaletteRowBase {
  kind: 'fabric';
  typeLabel: string;
  snippet: string;
  repo?: string;
}

export type PaletteRow = PaletteNavRow | PaletteActionRow | PaletteFabricRow;

/** The nav-jump command set — the 4-item shell + Org (reachable from the palette even though it's
 *  gear-only in the rail now, per GRAPH-FOLD.md §6e). Order mirrors the rail. */
export const NAV_ROWS: readonly PaletteNavRow[] = [
  { kind: 'nav', id: 'nav-fleet', label: 'Fleet', view: 'fleet' },
  { kind: 'nav', id: 'nav-tasks', label: 'Tasks', view: 'tasks' },
  { kind: 'nav', id: 'nav-graph', label: 'Graph', view: 'omp-graph' },
  { kind: 'nav', id: 'nav-capabilities', label: 'Capabilities', view: 'capabilities' },
  { kind: 'nav', id: 'nav-org', label: 'Organization settings', view: 'org' },
];

export const SEARCH_TASKS_ROW: PaletteActionRow = {
  kind: 'action',
  id: 'action-search-tasks',
  label: 'Search tasks…',
  action: 'search-tasks',
};

/** Raw shape of one GET /api/fabric/search result (mirrors KnowledgePanel's KbResult). */
export interface FabricSearchResult {
  type: string;
  id: string;
  title: string;
  snippet: string;
  score: number;
  repo?: string;
}

const TYPE_LABELS: Record<string, string> = {
  decision: 'Decision',
  'hot-area': 'Hot file',
  digest: 'Prior session',
  agent: 'Agent',
  scout: 'Latent work',
  lease: 'Being edited',
};

/** A row matches a query if the query is blank, or a case-insensitive substring of the label. */
function matches(label: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return label.toLowerCase().includes(q);
}

/** The static rows (nav jumps + "Search tasks…"), filtered by the current query. Always computed —
 *  cheap, synchronous, no network — unlike the fabric rows which need a debounced fetch. */
export function staticRows(query: string): PaletteRow[] {
  return [...NAV_ROWS, SEARCH_TASKS_ROW].filter((row) => matches(row.label, query));
}

/** Map raw fabric search hits onto palette rows. Namespaced ids (`fabric:${id}`) so a fabric
 *  result can never collide with a nav-row id in the combined list. */
export function fabricRows(results: readonly FabricSearchResult[] | null | undefined): PaletteFabricRow[] {
  return (results ?? []).map((r) => ({
    kind: 'fabric',
    id: `fabric:${r.type}:${r.id}`,
    label: r.title,
    typeLabel: TYPE_LABELS[r.type] ?? r.type,
    snippet: r.snippet,
    repo: r.repo,
  }));
}

/** Assemble the full visible row list for a given query + (already-fetched) fabric results. Fabric
 *  rows only ever appear once there's a real query — an empty query fires no fabric search
 *  (GRAPH-FOLD.md §3: "typing filters nav rows and fires fabric search after a debounce"). */
export function buildRows(query: string, fabricResults: readonly FabricSearchResult[] | null | undefined): PaletteRow[] {
  const rows = staticRows(query);
  if (!query.trim()) return rows;
  return [...rows, ...fabricRows(fabricResults)];
}

/** Move the selection index by `delta` (±1), clamping to the row list bounds (no wraparound —
 *  matches the roster's ArrowUp/ArrowDown convention in WorkspaceCockpit). Returns 0 for an empty
 *  list-relative move so callers never index out of range. */
export function moveSelection(rowCount: number, currentIndex: number, delta: 1 | -1): number {
  if (rowCount === 0) return 0;
  const next = currentIndex + delta;
  return Math.max(0, Math.min(rowCount - 1, next));
}
