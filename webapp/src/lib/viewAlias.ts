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
  'plan-reality',
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
  // hasOwnProperty, not bracket access alone: a bracket lookup on an inherited key like
  // `toString`/`constructor` would return an Object.prototype function (truthy) and put it into
  // `view` state — so only own keys of the alias map count.
  const aliased = Object.prototype.hasOwnProperty.call(VIEW_ALIAS_MAP, trimmed) ? VIEW_ALIAS_MAP[trimmed] : undefined;
  if (aliased) return { view: aliased, openPalette: trimmed === 'knowledge' };
  return { view: 'fleet', openPalette: false };
}

/** True iff `raw` is a recognized view source — a live AppView key or a known dead-key alias
 *  (own keys only). Garbage/empty/unrecognized values are NOT recognized, so the boot bootstrap
 *  can strip them from the URL without overwriting the user's persisted nav. */
function isRecognizedView(raw: string): boolean {
  const trimmed = raw.trim();
  return isAppView(trimmed) || Object.prototype.hasOwnProperty.call(VIEW_ALIAS_MAP, trimmed);
}

/**
 * `?view=<name>` boot bootstrap (D0, glance-desktop dashboard embedding prerequisite): the
 * desktop shell embeds this SPA in a native webview and needs to pick the initial screen from
 * OUTSIDE the page (it can't pre-seed localStorage across origins/profiles the way a same-origin
 * script can) — a URL query param is the one channel it can always drive. Funnels through the
 * SAME `coerceView` funnel every other view source uses (a dead GRAPH-FOLD key still aliases, a
 * typo/garbage value still lands on `fleet` rather than a white screen), persists the COERCED
 * value under `VIEW_STORAGE_KEY` — the same key TaskContext's lazy `useState` initializer reads
 * on first render via `readStoredView()` — then strips the param from the visible URL. Mirrors
 * `captureToken`'s `?token=` handling in ./api.ts: same "read once, persist, strip" shape, so a
 * bookmarked or shared `?view=` link doesn't keep re-pinning the view on every subsequent load,
 * and a reload after navigating elsewhere in-app doesn't snap back to the seeded value.
 *
 * MUST run before the first React render (call it from main.tsx, like `installPushTapBeacon`) so
 * `readStoredView()` observes the seeded value on its very first read — this function itself
 * never touches React state.
 */
export function bootstrapViewFromQuery(): void {
  try {
    const url = new URL(location.href);
    const raw = url.searchParams.get('view');
    if (raw === null) return; // no param: nothing to seed, nothing to strip
    // Persist ONLY a genuinely recognized view. An empty or garbage `?view=` used to coerce to
    // `fleet` and overwrite the user's persisted nav — sticky across reloads, and a crafted link
    // could force a sensitive first-paint screen. Now such values are stripped from the URL but
    // never written; only a live key or known alias seeds localStorage.
    if (isRecognizedView(raw)) {
      // Trim before coercing: isRecognizedView() trims, so a whitespace-wrapped live key like
      // " tasks " is accepted here — but coerceView()'s isAppView() check is exact and would miss
      // the untrimmed value and fall back to 'fleet'. Pass the trimmed form so the recognized view
      // is the one persisted.
      const { view } = coerceView(raw.trim());
      localStorage.setItem(VIEW_STORAGE_KEY, view);
    }
    url.searchParams.delete('view');
    history.replaceState(null, '', url.toString());
  } catch {
    // ponytail: storage/location can be blocked (private mode, non-browser test harness, an
    // embed edge case) — the app still boots, just without the seeded view; never let a boot
    // bootstrap take the whole page down.
  }
}
