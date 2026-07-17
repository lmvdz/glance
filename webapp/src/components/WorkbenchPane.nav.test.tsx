import { expect, test } from 'bun:test';
import { NAV_ITEMS } from './WorkbenchPane';

// GRAPH-FOLD.md §6e's four-item shell (Fleet · Tasks · Graph · Capabilities), joined by
// comprehension batch-3's Fog (mounts HeatTree's fog overlay — see FogView.tsx) and daily-driver-w15
// concern 04's Friction (the dogfood gripe ledger — see FrictionInbox.tsx). Org is deliberately NOT
// here (it moved to the gear at the bottom of the rail), and none of the eight GRAPH-FOLD-folded
// pages may ever creep back in as nav items.
test('the nav is exactly Fleet · Tasks · Graph · Fog · Friction · Capabilities, in that order', () => {
  expect(NAV_ITEMS.map((i) => i.view)).toEqual(['fleet', 'tasks', 'omp-graph', 'fog', 'friction', 'capabilities']);
  expect(NAV_ITEMS.map((i) => i.label)).toEqual(['Fleet', 'Tasks', 'Graph', 'Fog', 'Friction', 'Capabilities']);
});

test('every nav item has an icon and a title (the collapsed rail tooltips depend on them)', () => {
  for (const item of NAV_ITEMS) {
    expect(item.icon).toBeTruthy();
    expect(item.title.length).toBeGreaterThan(0);
  }
});
