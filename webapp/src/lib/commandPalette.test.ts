import { expect, test, describe } from 'bun:test';
import { staticRows, fabricRows, buildRows, moveSelection, NAV_ROWS, SEARCH_TASKS_ROW, type FabricSearchResult } from './commandPalette';

describe('staticRows', () => {
  test('blank query returns the nav rows + Org + Search tasks, in order', () => {
    const rows = staticRows('');
    expect(rows.map((r) => r.id)).toEqual([
      'nav-fleet', 'nav-tasks', 'nav-graph', 'nav-fog', 'nav-capabilities', 'nav-org', 'action-search-tasks',
    ]);
  });

  test('filters case-insensitively by label substring', () => {
    expect(staticRows('grap').map((r) => r.id)).toEqual(['nav-graph']);
    expect(staticRows('GRAPH').map((r) => r.id)).toEqual(['nav-graph']);
  });

  test('"search" query surfaces the Search tasks row', () => {
    expect(staticRows('search').map((r) => r.id)).toEqual(['action-search-tasks']);
  });

  test('a query matching nothing returns an empty list', () => {
    expect(staticRows('zzz-nomatch')).toEqual([]);
  });

  test('NAV_ROWS covers exactly the rail nav items + org, no dead views', () => {
    expect(NAV_ROWS.map((r) => r.view)).toEqual(['fleet', 'tasks', 'omp-graph', 'fog', 'capabilities', 'org']);
  });

  test('SEARCH_TASKS_ROW is the search-tasks action', () => {
    expect(SEARCH_TASKS_ROW.action).toBe('search-tasks');
  });
});

describe('fabricRows', () => {
  const raw: FabricSearchResult[] = [
    { type: 'decision', id: 'd1', title: 'Use ember accent', snippet: 'decided in brand.md', score: 0.9 },
    { type: 'hot-area', id: 'h1', title: 'src/auth/token.ts', snippet: 'touched by 3 agents', score: 0.8, repo: 'glance' },
    { type: 'symptom', id: 's1', title: 'daemon healthy but dispatch stalled', snippet: 'src/dispatch.ts', score: 0.7 },
    { type: 'mystery-type', id: 'm1', title: 'unknown kind', snippet: '...', score: 0.1 },
  ];

  test('maps type → human label via TYPE_LABELS, falling back to the raw type for unknowns', () => {
    const rows = fabricRows(raw);
    expect(rows[0].typeLabel).toBe('Decision');
    expect(rows[1].typeLabel).toBe('Hot file');
    expect(rows[2].typeLabel).toBe('Known symptom'); // comprehension concern 07
    expect(rows[3].typeLabel).toBe('mystery-type');
  });

  test('namespaces ids as fabric:<type>:<id> so they can never collide with nav-row ids', () => {
    expect(fabricRows(raw).map((r) => r.id)).toEqual(['fabric:decision:d1', 'fabric:hot-area:h1', 'fabric:symptom:s1', 'fabric:mystery-type:m1']);
  });

  test('carries repo through when present, undefined when absent', () => {
    const rows = fabricRows(raw);
    expect(rows[0].repo).toBeUndefined();
    expect(rows[1].repo).toBe('glance');
  });

  test('null/undefined results → empty array', () => {
    expect(fabricRows(null)).toEqual([]);
    expect(fabricRows(undefined)).toEqual([]);
  });
});

describe('buildRows', () => {
  test('blank query never includes fabric rows, even if some were passed in (stale from a prior query)', () => {
    const stale: FabricSearchResult[] = [{ type: 'decision', id: 'd1', title: 'stale hit', snippet: '', score: 1 }];
    const rows = buildRows('', stale);
    expect(rows.some((r) => r.kind === 'fabric')).toBe(false);
  });

  test('a real query appends fabric rows after the filtered static rows', () => {
    const results: FabricSearchResult[] = [{ type: 'decision', id: 'd1', title: 'token rotation decision', snippet: 'x', score: 1 }];
    const rows = buildRows('token', results);
    expect(rows.map((r) => r.kind)).toEqual(['fabric']); // no static row matches "token"
  });

  test('a query matching both a nav row and fabric results shows both, static first', () => {
    const results: FabricSearchResult[] = [{ type: 'decision', id: 'd1', title: 'graph inspector decision', snippet: 'x', score: 1 }];
    const rows = buildRows('graph', results);
    expect(rows.map((r) => r.kind)).toEqual(['nav', 'fabric']);
  });
});

describe('moveSelection', () => {
  test('clamps at the top (no wraparound going up from 0)', () => {
    expect(moveSelection(5, 0, -1)).toBe(0);
  });

  test('clamps at the bottom (no wraparound going down from the last row)', () => {
    expect(moveSelection(5, 4, 1)).toBe(4);
  });

  test('moves by one in either direction within bounds', () => {
    expect(moveSelection(5, 2, 1)).toBe(3);
    expect(moveSelection(5, 2, -1)).toBe(1);
  });

  test('an empty row list never returns an out-of-range index', () => {
    expect(moveSelection(0, 0, 1)).toBe(0);
    expect(moveSelection(0, 0, -1)).toBe(0);
  });
});
