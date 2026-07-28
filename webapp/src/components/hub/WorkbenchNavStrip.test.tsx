import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { NAV_ROWS } from '../../lib/commandPalette';
import { WorkbenchNavStrip } from './WorkbenchNavStrip';

// Drift-proof: this asserts against the imported NAV_ROWS list rather than a hard-coded copy of the
// nine labels, so a destination added to commandPalette.ts later cannot silently miss the strip.
test('every NAV_ROWS destination appears in the workbench strip', () => {
  const html = renderToStaticMarkup(<WorkbenchNavStrip view="tasks" />);
  for (const row of NAV_ROWS) expect(html).toContain(row.label);
});

test('the current surface is marked current and is not a self-link', () => {
  const html = renderToStaticMarkup(<WorkbenchNavStrip view="economics" />);
  // Marked: aria-current="page" sits on the Economics entry...
  expect(html).toContain('aria-current="page"');
  const currentMatch = html.match(/<span aria-current="page"[^>]*>([^<]*)<\/span>/);
  expect(currentMatch?.[1]).toBe('Economics');
  // ...and it is not a self-link: there is no <a> anywhere in the markup whose text is "Economics".
  expect(html).not.toMatch(/<a[^>]*>Economics<\/a>/);
});

test('every sibling destination IS a real link, pointing at its own workbench hash', () => {
  const html = renderToStaticMarkup(<WorkbenchNavStrip view="economics" />);
  expect(html).toContain('<a href="#/workbench/daily"');
  expect(html).toContain('>Daily<');
  expect(html).toContain('<a href="#/workbench/capabilities"');
  expect(html).toContain('>Capabilities<');
  // Fleet is the room, not a workbench spelling — its href goes straight to the room hash (mirrors
  // paletteNavigationHref's own "Fleet points straight at the room" behavior).
  expect(html).toContain('<a href="#fleet"');
  expect(html).toContain('>Fleet<');
});

test('landing on a task detail marks Tasks current, the same as the Tasks list surface', () => {
  const html = renderToStaticMarkup(<WorkbenchNavStrip view="task" />);
  const currentMatch = html.match(/<span aria-current="page"[^>]*>([^<]*)<\/span>/);
  expect(currentMatch?.[1]).toBe('Tasks');
});

test('a route with no matching nav row (e.g. a doc review) marks nothing current — every entry stays a link', () => {
  const html = renderToStaticMarkup(<WorkbenchNavStrip view="review" />);
  expect(html).not.toContain('aria-current="page"');
  for (const row of NAV_ROWS) expect(html).toMatch(new RegExp(`<a[^>]*>${row.label}</a>`));
});

test('the strip names itself for assistive tech without adding a visible heading', () => {
  const html = renderToStaticMarkup(<WorkbenchNavStrip view="tasks" />);
  expect(html).toContain('aria-label="Workbench surfaces"');
});
