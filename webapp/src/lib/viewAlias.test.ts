import { expect, test, describe } from 'bun:test';
import { coerceView, isAppView, VIEW_ALIAS_MAP, VIEW_STORAGE_KEY } from './viewAlias';

describe('isAppView', () => {
  test('true for every current AppView key', () => {
    for (const v of ['fleet', 'tasks', 'omp-graph', 'fog', 'daily', 'capabilities', 'org', 'intervene', 'review']) {
      expect(isAppView(v)).toBe(true);
    }
  });

  test('false for null/undefined/empty/unknown', () => {
    expect(isAppView(null)).toBe(false);
    expect(isAppView(undefined)).toBe(false);
    expect(isAppView('')).toBe(false);
    expect(isAppView('not-a-view')).toBe(false);
  });

  test('false for every retired GRAPH-FOLD.md key', () => {
    for (const v of Object.keys(VIEW_ALIAS_MAP)) {
      expect(isAppView(v)).toBe(false);
    }
  });
});

describe('coerceView — live keys pass through unchanged', () => {
  for (const v of ['fleet', 'tasks', 'omp-graph', 'fog', 'daily', 'capabilities', 'org', 'intervene', 'review'] as const) {
    test(`"${v}" passes through with no palette auto-open`, () => {
      expect(coerceView(v)).toEqual({ view: v, openPalette: false });
    });
  }
});

describe('coerceView — the fold aliases (GRAPH-FOLD.md §3)', () => {
  test('automation | activity-heatmap | scoreboard | heat | topology fold into the Graph', () => {
    for (const dead of ['automation', 'activity-heatmap', 'scoreboard', 'heat', 'topology']) {
      expect(coerceView(dead)).toEqual({ view: 'omp-graph', openPalette: false });
    }
  });

  test('knowledge folds into the Graph AND auto-opens the ⌘K palette — its search was the KB lookup', () => {
    expect(coerceView('knowledge')).toEqual({ view: 'omp-graph', openPalette: true });
  });

  test('fleet-health | attention | active | cockpit dissolve into the unified Fleet view (§6f)', () => {
    for (const dead of ['fleet-health', 'attention', 'active', 'cockpit']) {
      expect(coerceView(dead)).toEqual({ view: 'fleet', openPalette: false });
    }
  });

  test('federation parks in Org settings', () => {
    expect(coerceView('federation')).toEqual({ view: 'org', openPalette: false });
  });
});

describe('coerceView — never a white screen', () => {
  test('null/undefined/empty default to fleet', () => {
    expect(coerceView(null)).toEqual({ view: 'fleet', openPalette: false });
    expect(coerceView(undefined)).toEqual({ view: 'fleet', openPalette: false });
    expect(coerceView('')).toEqual({ view: 'fleet', openPalette: false });
  });

  test('a totally unknown/garbage key defaults to fleet rather than rendering nothing', () => {
    expect(coerceView('this-was-never-a-view')).toEqual({ view: 'fleet', openPalette: false });
  });

  test('whitespace-padded dead keys still alias (defensive — a stray localStorage write)', () => {
    expect(coerceView('  heat  ')).toEqual({ view: 'omp-graph', openPalette: false });
  });
});

test('VIEW_STORAGE_KEY is a stable, namespaced localStorage key', () => {
  expect(VIEW_STORAGE_KEY).toBe('omp.view');
});
