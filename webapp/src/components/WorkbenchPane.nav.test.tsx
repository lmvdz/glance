import { expect, test } from 'bun:test';
import { NAV_ITEMS } from './WorkbenchPane';

// GRAPH-FOLD.md §6e's four-item shell (Fleet · Tasks · Graph · Capabilities), joined by
// comprehension batch-3's Fog (mounts HeatTree's fog overlay — see FogView.tsx), daily-driver
// w1.5's Daily (adoption counters + friction ledger), OMPSQ-448's Plan reality
// (PlanRealityView.tsx), and Plan briefs (styled human explainers generated from plans/<name>).
// Org is deliberately NOT here (it moved to the gear at the bottom of the rail), and none of the
// eight GRAPH-FOLD-folded pages may ever creep back in as nav items.
test('the nav is exactly Fleet · Tasks · Graph · Fog · Daily · Plan reality · Plan briefs · Capabilities, in that order', () => {
  expect(NAV_ITEMS.map((i) => i.view)).toEqual(['fleet', 'tasks', 'omp-graph', 'fog', 'daily', 'plan-reality', 'plan-brief', 'capabilities']);
  expect(NAV_ITEMS.map((i) => i.label)).toEqual(['Fleet', 'Tasks', 'Graph', 'Fog', 'Daily', 'Plan reality', 'Plan briefs', 'Capabilities']);
});

test('every nav item has an icon and a title (the collapsed rail tooltips depend on them)', () => {
  for (const item of NAV_ITEMS) {
    expect(item.icon).toBeTruthy();
    expect(item.title.length).toBeGreaterThan(0);
  }
});
