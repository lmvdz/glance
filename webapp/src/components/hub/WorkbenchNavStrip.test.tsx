import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { NAV_ROWS, paletteNavigationHref } from '../../lib/commandPalette';
import { WorkbenchNavStrip } from './WorkbenchNavStrip';

// Drift-proof: this asserts against the imported NAV_ROWS list rather than a hard-coded copy of the
// nine labels, so a destination added to commandPalette.ts later cannot silently miss the strip.
test('every NAV_ROWS destination appears in the workbench strip', () => {
  const html = renderToStaticMarkup(<WorkbenchNavStrip view="tasks" />);
  for (const row of NAV_ROWS) expect(html).toContain(row.label);
});

test('standing on the Tasks LIST: the Tasks entry is marked current and is not a link', () => {
  const html = renderToStaticMarkup(<WorkbenchNavStrip view="tasks" />);
  const currentMatch = html.match(/<span aria-current="page"[^>]*>([^<]*)<\/span>/);
  expect(currentMatch?.[1]).toBe('Tasks');
  expect(html).not.toMatch(/<a[^>]*>Tasks<\/a>/);
});

test('the current surface is marked current and is not a self-link (Economics)', () => {
  const html = renderToStaticMarkup(<WorkbenchNavStrip view="economics" />);
  expect(html).toContain('aria-current="page"');
  const currentMatch = html.match(/<span aria-current="page"[^>]*>([^<]*)<\/span>/);
  expect(currentMatch?.[1]).toBe('Economics');
  expect(html).not.toMatch(/<a[^>]*>Economics<\/a>/);
});

// The full matrix, not a sample: on a route matching none of the nine rows (a doc review has no
// nav-strip destination of its own), every single row must be a real link resolving to exactly
// what paletteNavigationHref computes for it — the same NAV_ROWS/paletteNavigationHref the ⌘K
// palette itself uses, so there is no second, silently-divergent copy of the hrefs.
test('every row resolves to exactly its paletteNavigationHref — the full nine-row matrix, not a sample', () => {
  const html = renderToStaticMarkup(<WorkbenchNavStrip view="review" />);
  expect(html).not.toContain('aria-current');
  for (const row of NAV_ROWS) {
    const href = paletteNavigationHref(row.view);
    expect(href).toBeDefined();
    expect(html).toContain(`<a href="${href}"`);
  }
});

// The regression this test guards: an operator reported "Tasks" as unclickable from a task's
// detail page, with no on-screen way back to the Tasks list. Standing on a task's DETAIL is a
// different case from standing on the list itself — the parent row must stay a live link.
// Asserting only "it's a link" OR only "it's still marked current" would each pass a broken
// implementation (an unmarked link looks like every other sibling; a marked non-link reproduces
// the exact bug) — both halves are checked together.
test('standing on a TASK DETAIL: the Tasks entry IS a link to the Tasks list AND is still marked as the current section', () => {
  const html = renderToStaticMarkup(<WorkbenchNavStrip view="task" id="some-task-id" />);
  const tasksHref = paletteNavigationHref('tasks');
  expect(html).toContain(`<a href="${tasksHref}" aria-current="true"`);
  expect(html).toContain('>Tasks<');
  // No row is falsely rendered as the (unclickable) exact match.
  expect(html).not.toContain('aria-current="page"');
});

// Same list->detail shape for the other two rows the strip covers, where list vs. detail is the
// SAME WorkbenchRouteView — told apart only by whether an id is present ('plans' for Plan briefs,
// 'plan-reality' for Plan reality). PlanSurface/RealitySurface both branch on the id rather than on
// a distinct view name, so `currentNavRow` must too.
test('standing on the Plan briefs LIST (no id): Plan briefs is marked current and is not a link', () => {
  const html = renderToStaticMarkup(<WorkbenchNavStrip view="plans" />);
  const currentMatch = html.match(/<span aria-current="page"[^>]*>([^<]*)<\/span>/);
  expect(currentMatch?.[1]).toBe('Plan briefs');
  expect(html).not.toMatch(/<a[^>]*>Plan briefs<\/a>/);
});

test('standing on an OPEN plan brief (id set): Plan briefs IS a link back to the list AND still marked current', () => {
  const html = renderToStaticMarkup(<WorkbenchNavStrip view="plans" id="my-plan" />);
  const planBriefsHref = paletteNavigationHref('plan-brief');
  expect(html).toContain(`<a href="${planBriefsHref}" aria-current="true"`);
  expect(html).toContain('>Plan briefs<');
  expect(html).not.toContain('aria-current="page"');
});

test('standing on the Plan reality LIST (no id): Plan reality is marked current and is not a link', () => {
  const html = renderToStaticMarkup(<WorkbenchNavStrip view="plan-reality" />);
  const currentMatch = html.match(/<span aria-current="page"[^>]*>([^<]*)<\/span>/);
  expect(currentMatch?.[1]).toBe('Plan reality');
  expect(html).not.toMatch(/<a[^>]*>Plan reality<\/a>/);
});

test('standing on an OPEN plan-reality doc (id set): Plan reality IS a link back to the list AND still marked current', () => {
  const html = renderToStaticMarkup(<WorkbenchNavStrip view="plan-reality" id="my-plan" />);
  const planRealityHref = paletteNavigationHref('plan-reality');
  expect(html).toContain(`<a href="${planRealityHref}" aria-current="true"`);
  expect(html).toContain('>Plan reality<');
  expect(html).not.toContain('aria-current="page"');
});

test('a route with no matching nav row (e.g. a doc review) marks nothing current — every entry stays a link', () => {
  const html = renderToStaticMarkup(<WorkbenchNavStrip view="review" />);
  expect(html).not.toContain('aria-current="page"');
  expect(html).not.toContain('aria-current="true"');
  for (const row of NAV_ROWS) expect(html).toMatch(new RegExp(`<a[^>]*>${row.label}</a>`));
});

test('the strip names itself for assistive tech without adding a visible heading', () => {
  const html = renderToStaticMarkup(<WorkbenchNavStrip view="tasks" />);
  expect(html).toContain('aria-label="Workbench surfaces"');
});
