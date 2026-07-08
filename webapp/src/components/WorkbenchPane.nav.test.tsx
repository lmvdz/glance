import { expect, test } from 'bun:test';
import { NAV_ITEMS } from './WorkbenchPane';

// The four-item shell (GRAPH-FOLD.md §6e): Fleet · Tasks · Graph · Capabilities — nothing else.
// Org is deliberately NOT here (it moved to the gear at the bottom of the rail), and none of the
// eight folded pages may ever creep back in as nav items.
test('the nav is exactly Fleet · Tasks · Graph · Capabilities, in that order', () => {
  expect(NAV_ITEMS.map((i) => i.view)).toEqual(['fleet', 'tasks', 'omp-graph', 'capabilities']);
  expect(NAV_ITEMS.map((i) => i.label)).toEqual(['Fleet', 'Tasks', 'Graph', 'Capabilities']);
});

test('every nav item has an icon and a title (the collapsed rail tooltips depend on them)', () => {
  for (const item of NAV_ITEMS) {
    expect(item.icon).toBeTruthy();
    expect(item.title.length).toBeGreaterThan(0);
  }
});
