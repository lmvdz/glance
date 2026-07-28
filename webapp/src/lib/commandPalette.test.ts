import { expect, test, describe } from 'bun:test';
import { staticRows, fabricRows, buildRows, moveSelection, NAV_ROWS, currentNavRow, paletteNavigationHref, SEARCH_TASKS_ROW, type FabricSearchResult } from './commandPalette';
import { canonicalHubHash, hubHref, parseHubHash } from './router';

describe('staticRows', () => {
  test('blank query returns the nav rows + Org + Search tasks, in order', () => {
    const rows = staticRows('');
    expect(rows.map((r) => r.id)).toEqual([
      'nav-fleet', 'nav-tasks', 'nav-daily', 'nav-fog', 'nav-plan-reality', 'nav-plans', 'nav-economics', 'nav-capabilities', 'nav-org', 'action-search-tasks',
    ]);
  });

  test('filters case-insensitively by label substring', () => {
    expect(staticRows('econ').map((r) => r.id)).toEqual(['nav-economics']);
    expect(staticRows('ECONOMICS').map((r) => r.id)).toEqual(['nav-economics']);
  });

  test('"search" query surfaces the Search tasks row', () => {
    expect(staticRows('search').map((r) => r.id)).toEqual(['action-search-tasks']);
  });

  test('a query matching nothing returns an empty list', () => {
    expect(staticRows('zzz-nomatch')).toEqual([]);
  });

  test('NAV_ROWS covers exactly the real surfaces — no "Graph" (dead-doors audit: it dissolved into the same room "Fleet" already opens, with no graph content behind the label)', () => {
    expect(NAV_ROWS.map((r) => r.view)).toEqual(['fleet', 'tasks', 'daily', 'fog', 'plan-reality', 'plan-brief', 'economics', 'capabilities', 'org']);
    expect(NAV_ROWS.some((r) => r.label === 'Graph')).toBe(false);
  });

  test('dead-doors audit: daily, plan briefs and economics — previously orphaned, no click path anywhere — are now real nav rows', () => {
    const byView = new Map(NAV_ROWS.map((r) => [r.view, r]));
    expect(byView.get('daily')?.label).toBe('Daily');
    expect(byView.get('plan-brief')?.label).toBe('Plan briefs');
    expect(byView.get('economics')?.label).toBe('Economics');
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
    { type: 'answer', id: 'a1', title: 'why is dispatch slow?', snippet: 'the spawn loop is serial', score: 0.6, repo: 'glance', ref: 'u1' },
    { type: 'mystery-type', id: 'm1', title: 'unknown kind', snippet: '...', score: 0.1 },
  ];

  test('maps type → human label via TYPE_LABELS, falling back to the raw type for unknowns', () => {
    const rows = fabricRows(raw);
    expect(rows[0].typeLabel).toBe('Decision');
    expect(rows[1].typeLabel).toBe('Hot file');
    expect(rows[2].typeLabel).toBe('Known symptom'); // comprehension concern 07
    expect(rows[3].typeLabel).toBe('Answered question'); // comprehension concern 10
    expect(rows[4].typeLabel).toBe('mystery-type');
  });

  test('namespaces ids as fabric:<type>:<id> so they can never collide with nav-row ids', () => {
    expect(fabricRows(raw).map((r) => r.id)).toEqual([
      'fabric:decision:d1', 'fabric:hot-area:h1', 'fabric:symptom:s1', 'fabric:answer:a1', 'fabric:mystery-type:m1',
    ]);
  });

  test('carries repo through when present, undefined when absent', () => {
    const rows = fabricRows(raw);
    expect(rows[0].repo).toBeUndefined();
    expect(rows[1].repo).toBe('glance');
  });

  /** Comprehension concern 10: the raw `type` and backend `ref` (the answer id) survive onto the
   *  row — CommandPalette.tsx's row-selection handler needs both to fire `reportAnswerRead`. */
  test('carries the raw type and ref through so a selection handler can branch on fact type', () => {
    const rows = fabricRows(raw);
    expect(rows[3].type).toBe('answer');
    expect(rows[3].ref).toBe('u1');
    expect(rows[0].type).toBe('decision');
    expect(rows[0].ref).toBeUndefined();
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
    const results: FabricSearchResult[] = [{ type: 'decision', id: 'd1', title: 'fog collision decision', snippet: 'x', score: 1 }];
    const rows = buildRows('fog', results);
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

describe('palette navigation destinations', () => {
  test('keeps setup-only capabilities reachable through a shareable room route', () => {
    expect(paletteNavigationHref('capabilities')).toBe('#/workbench/capabilities');
  });

  // Dead-doors audit finding 1: "Fleet" used to point at `#/workbench/fleet`, a spelling
  // `parseHubHash` immediately redirects back to the room — a real destination, reached through a
  // hash that only exists to bounce off of it. Fleet IS the room now, so it should say so directly.
  test('"Fleet" points straight at the room, not through the retired workbench spelling', () => {
    expect(paletteNavigationHref('fleet')).toBe(hubHref());
    expect(paletteNavigationHref('fleet')).not.toBe('#/workbench/fleet');
  });

  // Dead-doors audit finding 2: daily/plans/economics had no click path anywhere. These are their
  // hrefs; the "every entry actually renders" test below is what proves they're not new dead ends.
  test('the previously-orphaned surfaces resolve to their real workbench hashes', () => {
    expect(paletteNavigationHref('daily')).toBe('#/workbench/daily');
    expect(paletteNavigationHref('plan-brief')).toBe('#/plans');
    expect(paletteNavigationHref('economics')).toBe('#/workbench/economics');
  });

  // The regression guard for finding 1 as a class of bug, not just the one instance: every row the
  // palette currently offers must resolve to a hash that is ALREADY canonical — i.e. `parseHubHash`
  // does not turn around and redirect it somewhere else. A row whose href round-trips to a
  // DIFFERENT canonical hash is exactly the "Fleet"/"Graph" bug (a labeled destination that quietly
  // isn't one) — this test fails the moment anyone reintroduces it.
  test('every palette nav row resolves to a real, already-canonical surface — no entry whose route redirects away', () => {
    for (const row of NAV_ROWS) {
      const href = paletteNavigationHref(row.view);
      expect(href).toBeDefined();
      const route = parseHubHash(href!);
      expect(canonicalHubHash(route)).toBe(href);
    }
  });

  // Directly proves "reachable from the palette": each of the three surfaces the dead-doors audit
  // found orphaned lands on a `workbench` route naming ITSELF, not a redirect back to the room —
  // App.tsx's WorkbenchRoute switches on exactly this `view` to render MondaySurface/PlanSurface/
  // CostSurface.
  test('daily, plan briefs and economics resolve to a workbench route for themselves, not a bounce back to the room', () => {
    const cases: Array<{ appView: Parameters<typeof paletteNavigationHref>[0]; workbenchView: string }> = [
      { appView: 'daily', workbenchView: 'daily' },
      { appView: 'plan-brief', workbenchView: 'plans' },
      { appView: 'economics', workbenchView: 'economics' },
    ];
    for (const { appView, workbenchView } of cases) {
      const route = parseHubHash(paletteNavigationHref(appView)!);
      expect(route.kind).toBe('workbench');
      expect(route.kind === 'workbench' && route.view).toBe(workbenchView);
    }
  });
});

// The workbench nav strip's "you are here" mark (WorkbenchNavStrip.tsx) is built on this: which
// NAV_ROWS entry (if any) a workbench route is standing on, and whether it's the row's own list
// surface ('exact', renders unclickable) or a child of it ('ancestor', must stay a live link back
// to the list — see the WorkbenchNavStrip.tsx doc comment for the regression this distinction
// fixes: collapsing both into "current" left a task's detail page with no way back to Tasks).
describe('currentNavRow', () => {
  test('a route with no id, on a row whose surface has no child detail, is an exact match', () => {
    const cases: Array<{ view: Parameters<typeof currentNavRow>[0]; id: string }> = [
      { view: 'tasks', id: 'nav-tasks' },
      { view: 'daily', id: 'nav-daily' },
      { view: 'fog', id: 'nav-fog' },
      { view: 'economics', id: 'nav-economics' },
      { view: 'capabilities', id: 'nav-capabilities' },
      { view: 'org', id: 'nav-org' },
    ];
    for (const { view, id } of cases) expect(currentNavRow(view)).toEqual({ id, match: 'exact' });
  });

  // 'plans' and 'plan-reality' are ONE route view for both the list and a single open item —
  // PlanSurface/RealitySurface branch on the id, not on a different view name — so `id` is what
  // tells the two apart here.
  test('"plans" (Plan briefs) and "plan-reality" with no id are exact matches on their list', () => {
    expect(currentNavRow('plans')).toEqual({ id: 'nav-plans', match: 'exact' });
    expect(currentNavRow('plan-reality')).toEqual({ id: 'nav-plan-reality', match: 'exact' });
  });

  test('"plans" and "plan-reality" WITH an id are ancestor matches — a single item is open, not the list', () => {
    expect(currentNavRow('plans', 'my-plan')).toEqual({ id: 'nav-plans', match: 'ancestor' });
    expect(currentNavRow('plan-reality', 'my-plan')).toEqual({ id: 'nav-plan-reality', match: 'ancestor' });
  });

  // The regression this whole distinction exists for: an operator on a task's detail page reported
  // "Tasks" as unclickable, with no way back to the list it came from.
  test('a task detail is an ancestor match on the Tasks row, not an exact (unclickable) one', () => {
    expect(currentNavRow('task')).toEqual({ id: 'nav-tasks', match: 'ancestor' });
    expect(currentNavRow('task', 'some-task-id')).toEqual({ id: 'nav-tasks', match: 'ancestor' });
  });

  test('routes with no nav-strip destination (review, gate-verdict, dissolved graph/intervene) resolve to no current row', () => {
    expect(currentNavRow('review')).toBeUndefined();
    expect(currentNavRow('gate-verdict')).toBeUndefined();
    expect(currentNavRow('graph')).toBeUndefined();
    expect(currentNavRow('intervene')).toBeUndefined();
  });
});
