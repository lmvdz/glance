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

// The regression these two guard is NOT "the strip is missing" — every test above already passes on
// a strip nobody can find. The first cut shipped at 28px, 11px #7A7A82 text on the page's own
// #0A0A0B ground, and the operator it was built for reported it as absent. Present-but-invisible is
// the same outcome as unshipped, so the chrome contract is pinned here: its own lighter ground, a
// bottom rule that separates it from the surface below, and a row tall enough to read as a bar.
test('the strip reads as chrome: its own ground, a bottom rule, and a bar-height row', () => {
  const html = renderToStaticMarkup(<WorkbenchNavStrip view="tasks" />);
  expect(html).toContain('background:#17171A');
  expect(html).toContain('border-bottom:1px solid #26262B');
  expect(html).toMatch(/class="[^"]*\bh-9\b/);
});

// Colour alone is both the weakest signal for a sighted operator scanning a nine-item row and
// invisible to anyone with a colour-vision deficiency. The current entry carries a shape cue (an
// underline rule drawn as an inset shadow) on top of the ember, and the ancestor entry carries a
// dimmer one — so "where am I" survives the colour channel being unavailable.
// Both halves pin the EXACT paint, not merely the presence of an underline. An assertion of
// `toContain('inset 0 -2px 0')` alone passes on `transparent` — i.e. on a strip whose shape cue has
// been dimmed back out of existence, which is the regression the test exists to catch. The ancestor
// alpha specifically has a floor: it is the only non-colour carrier of "you are in this section",
// so it must clear WCAG 1.4.11's 3:1 non-text contrast against the bar's #17171A ground. 0.55
// composites to ~3.44:1; the 0.45 this shipped with first composites to ~2.72:1 and fails.
test('current and ancestor entries are marked by shape, at a paint that clears non-text contrast', () => {
  const onList = renderToStaticMarkup(<WorkbenchNavStrip view="tasks" />);
  expect(onList.match(/<span aria-current="page"[^>]*>/)?.[0]).toContain('inset 0 -2px 0 #F0A35A');

  const onDetail = renderToStaticMarkup(<WorkbenchNavStrip view="task" id="some-task-id" />);
  expect(onDetail.match(/<a[^>]*aria-current="true"[^>]*>/)?.[0]).toContain(
    'inset 0 -2px 0 rgba(240,163,90,0.55)',
  );
});

test('the strip names itself for assistive tech without adding a visible heading', () => {
  const html = renderToStaticMarkup(<WorkbenchNavStrip view="tasks" />);
  expect(html).toContain('aria-label="Workbench surfaces"');
});
