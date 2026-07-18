import { expect, test, describe } from 'bun:test';
import { bootstrapViewFromQuery, coerceView, isAppView, VIEW_ALIAS_MAP, VIEW_STORAGE_KEY } from './viewAlias';

describe('isAppView', () => {
  test('true for every current AppView key', () => {
    for (const v of ['fleet', 'tasks', 'omp-graph', 'fog', 'daily', 'capabilities', 'org', 'intervene', 'review', 'plan-reality']) {
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
  for (const v of ['fleet', 'tasks', 'omp-graph', 'fog', 'daily', 'capabilities', 'org', 'intervene', 'review', 'plan-reality'] as const) {
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

// =================================================================================================
// bootstrapViewFromQuery (D0, glance-desktop dashboard embedding prerequisite): the desktop shell
// seeds the initial screen via `?view=<name>`, since it can't reach across origins into
// localStorage the way a same-origin script can. Bun's runtime has no DOM, so — same as
// push-tap.test.ts's `stubBrowserEnv` — location/history/localStorage are stubbed by hand.
// =================================================================================================

function stubViewBrowserEnv(href: string) {
  const state = { href };
  const store = new Map<string, string>();
  const restore = {
    location: (globalThis as { location?: unknown }).location,
    localStorage: (globalThis as { localStorage?: unknown }).localStorage,
    history: (globalThis as { history?: unknown }).history,
  };
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: {
      get href() {
        return state.href;
      },
    },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    },
  });
  Object.defineProperty(globalThis, 'history', {
    configurable: true,
    value: {
      replaceState: (_s: unknown, _t: string, url: string) => {
        state.href = url;
      },
    },
  });
  return {
    store,
    getHref: () => state.href,
    restore: () => {
      Object.defineProperty(globalThis, 'location', { configurable: true, value: restore.location });
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: restore.localStorage });
      Object.defineProperty(globalThis, 'history', { configurable: true, value: restore.history });
    },
  };
}

describe('bootstrapViewFromQuery', () => {
  test('a live view key seeds localStorage under VIEW_STORAGE_KEY and strips the param', () => {
    const env = stubViewBrowserEnv('http://localhost/?view=omp-graph');
    try {
      bootstrapViewFromQuery();
      expect(env.store.get(VIEW_STORAGE_KEY)).toBe('omp-graph');
      expect(env.getHref()).toBe('http://localhost/');
    } finally {
      env.restore();
    }
  });

  test('supports every desktop-embed-required view (fleet, tasks, omp-graph, fog, daily, plan-reality, capabilities)', () => {
    for (const v of ['fleet', 'tasks', 'omp-graph', 'fog', 'daily', 'plan-reality', 'capabilities']) {
      const env = stubViewBrowserEnv(`http://localhost/?view=${v}`);
      try {
        bootstrapViewFromQuery();
        expect(env.store.get(VIEW_STORAGE_KEY)).toBe(v);
      } finally {
        env.restore();
      }
    }
  });

  test('a whitespace-wrapped live view persists the trimmed view, not the fleet fallback', () => {
    const env = stubViewBrowserEnv('http://localhost/?view=%20tasks%20');
    try {
      bootstrapViewFromQuery();
      expect(env.store.get(VIEW_STORAGE_KEY)).toBe('tasks');
    } finally {
      env.restore();
    }
  });

  test('a dead GRAPH-FOLD key still aliases through coerceView (e.g. heat -> omp-graph)', () => {
    const env = stubViewBrowserEnv('http://localhost/?view=heat');
    try {
      bootstrapViewFromQuery();
      expect(env.store.get(VIEW_STORAGE_KEY)).toBe('omp-graph');
    } finally {
      env.restore();
    }
  });

  test('garbage is stripped but NEVER written — the persisted nav is not overwritten', () => {
    const env = stubViewBrowserEnv('http://localhost/?view=not-a-real-view');
    try {
      bootstrapViewFromQuery();
      expect(env.store.has(VIEW_STORAGE_KEY)).toBe(false); // no sticky `fleet` overwrite
      expect(env.getHref()).toBe('http://localhost/'); // param still stripped
    } finally {
      env.restore();
    }
  });

  test('an inherited Object key (toString/constructor) is treated as garbage, never written', () => {
    for (const evil of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      const env = stubViewBrowserEnv(`http://localhost/?view=${evil}`);
      try {
        bootstrapViewFromQuery();
        expect(env.store.has(VIEW_STORAGE_KEY)).toBe(false);
      } finally {
        env.restore();
      }
    }
  });

  test('no ?view= param at all: no-op — localStorage untouched, URL untouched', () => {
    const env = stubViewBrowserEnv('http://localhost/?token=abc');
    try {
      bootstrapViewFromQuery();
      expect(env.store.has(VIEW_STORAGE_KEY)).toBe(false);
      expect(env.getHref()).toBe('http://localhost/?token=abc');
    } finally {
      env.restore();
    }
  });

  test('other params and the hash survive the strip — only ?view= is removed', () => {
    const env = stubViewBrowserEnv('http://localhost/?token=abc&view=daily#/agent/x1');
    try {
      bootstrapViewFromQuery();
      expect(env.store.get(VIEW_STORAGE_KEY)).toBe('daily');
      expect(env.getHref()).toBe('http://localhost/?token=abc#/agent/x1');
    } finally {
      env.restore();
    }
  });

  test('an empty ?view= value is stripped but NEVER written (no sticky fleet overwrite)', () => {
    const env = stubViewBrowserEnv('http://localhost/?view=');
    try {
      bootstrapViewFromQuery();
      expect(env.store.has(VIEW_STORAGE_KEY)).toBe(false);
      expect(env.getHref()).toBe('http://localhost/');
    } finally {
      env.restore();
    }
  });
});
