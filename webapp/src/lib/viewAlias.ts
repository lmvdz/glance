/**
 * viewAlias.ts — the dead-route coercion for the post-GRAPH-FOLD shell (GRAPH-FOLD.md §3/§6f).
 *
 * The nav shrank 8→4 (Fleet · Tasks · Graph · Capabilities, + org/intervene/review as
 * routed-into-only views) and `AppView` no longer HAS the eight retired keys — so TypeScript
 * already refuses any in-app `setView('heat')` call. The one place a dead key can still show up
 * is a value that came from OUTSIDE the type system: the `view` persisted to localStorage across
 * reloads. Without this, a stale bookmark/tab left on `scoreboard` (or any pre-fold key) would
 * restore into `AppView` state holding a string the render switch never matches — a white screen,
 * the exact failure this coercion exists to prevent.
 *
 * `coerceView` is the single funnel: every raw string that becomes `view` state (the localStorage
 * restore in TaskContext, and any future deep-link source) goes through here first, so `view` can
 * never hold anything but a real `AppView`.
 *
 * comprehension batch-3 review: `fog` was added to `AppView` as a genuinely NEW nav item (mounting
 * `HeatTree`'s fog mode, which had no render site since the fold) — it is intentionally NOT a fold
 * destination and has no entry in `VIEW_ALIAS_MAP`; the dead `heat` key keeps aliasing to
 * `omp-graph` exactly as GRAPH-FOLD specified, unchanged by this addition.
 */

import type { AppView } from '../context/TaskContext';

/** localStorage key the current view is persisted under (read on boot, written on every setView). */
export const VIEW_STORAGE_KEY = 'omp.view';

/** Every valid `AppView` key — kept in sync with the union in TaskContext.tsx by `isAppView`'s test. */
const VALID_VIEWS: ReadonlySet<AppView> = new Set<AppView>([
  'fleet',
  'tasks',
  'omp-graph',
  'fog',
  'daily',
  'capabilities',
  'org',
  'intervene',
  'review',
]);

/**
 * Dead key → surviving view, per GRAPH-FOLD.md §3:
 *   automation | activity-heatmap | scoreboard | heat | topology  → omp-graph (folded into the Graph)
 *   knowledge                                                     → omp-graph (⌘K palette is the real KB lookup now)
 *   fleet-health | attention | active | cockpit                   → fleet (dissolved into WorkspaceCockpit, §6f)
 *   federation                                                    → org (peer/remote settings live there now)
 */
export const VIEW_ALIAS_MAP: Readonly<Record<string, AppView>> = {
  automation: 'omp-graph',
  'activity-heatmap': 'omp-graph',
  scoreboard: 'omp-graph',
  heat: 'omp-graph',
  topology: 'omp-graph',
  knowledge: 'omp-graph',
  'fleet-health': 'fleet',
  attention: 'fleet',
  active: 'fleet',
  cockpit: 'fleet',
  federation: 'org',
};

/** True iff `raw` is a still-live AppView key — the identity path, no aliasing needed. */
export function isAppView(raw: string | null | undefined): raw is AppView {
  return !!raw && VALID_VIEWS.has(raw as AppView);
}

export interface ViewCoercion {
  view: AppView;
  /**
   * The `knowledge` key's fold destination is the Graph *plus* the ⌘K palette auto-opening (its
   * search WAS the knowledge-base lookup) — this is the only alias that also wants a side effect,
   * so callers check it once and open the palette themselves.
   */
  openPalette: boolean;
}

/**
 * The single funnel every raw view string passes through before it becomes `AppView` state.
 *   - a live key passes through unchanged
 *   - a known dead key aliases to its fold destination (§3 table above)
 *   - anything else (empty, null, a typo, a key from a future removed further still) lands on the
 *     default `fleet` view rather than rendering nothing
 */
export function coerceView(raw: string | null | undefined): ViewCoercion {
  if (isAppView(raw)) return { view: raw, openPalette: false };
  const trimmed = (raw ?? '').trim();
  const aliased = VIEW_ALIAS_MAP[trimmed];
  if (aliased) return { view: aliased, openPalette: trimmed === 'knowledge' };
  return { view: 'fleet', openPalette: false };
}
