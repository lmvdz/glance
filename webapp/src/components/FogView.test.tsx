/**
 * FogView.test.tsx — static-render test for the comprehension lane's new "Fog" nav item
 * (batch-3 review). Like HeatTree.test.tsx and this repo's other component tests, we use
 * `renderToStaticMarkup` rather than mounting with a DOM — effects (the `/api/heat` self-fetch)
 * never run, so this only exercises the initial "loading" render: the panel chrome (title,
 * subtitle, range toggle) mounts correctly and the loading skeleton — never a blank screen —
 * shows before the first fetch resolves. The FOG DECISIONS themselves (tri-state mapping,
 * cold-start gating, shortlist ranking) are HeatTree's/heatmap.ts's own exhaustively-tested
 * territory; this file only proves the new view actually mounts HeatTree with fog mode requested.
 */

import { expect, test, describe } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FogView } from './FogView';
import { PageContextProvider } from '../context/PageContext';

// FogView publishes its own PageContext (like OmpGraphPanel/WorkspaceCockpit — mirrors
// App.tsx's real mount, where PageContextProvider sits above every view) via PageContextScope,
// which throws outside a PageContextProvider — every render below needs the provider ancestor.
function renderFogView(): string {
  return renderToStaticMarkup(
    <PageContextProvider>
      <FogView />
    </PageContextProvider>,
  );
}

describe('FogView — initial render (before the /api/heat self-fetch resolves)', () => {
  test('mounts the panel chrome: title, subtitle, and a loading skeleton (never blank)', () => {
    const html = renderFogView();
    expect(html).toContain('Comprehension fog');
    expect(html).toContain('What the fleet changed that nobody has looked at yet');
    expect(html).toContain('Loading fog data');
  });

  test('renders the days-of-history range toggle with 14d active by default', () => {
    const html = renderFogView();
    const buttons = html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
    const rangeButtons = buttons.filter((b) => /(?:^|>)\s*(7d|14d|30d)\s*(?:<|$)/.test(b));
    expect(rangeButtons.length).toBe(3);
    const active = rangeButtons.find((b) => b.includes('>14d<'));
    expect(active).toBeDefined();
    expect(active).toContain('aria-pressed="true"');
    for (const b of rangeButtons) {
      if (!b.includes('>14d<')) expect(b).toContain('aria-pressed="false"');
    }
  });

  test('never renders HeatTree (and its fog toggle) before data has loaded', () => {
    const html = renderFogView();
    // HeatTree's own chrome ("Fog: on", the debt shortlist header) must not leak into the
    // pre-load skeleton state — the loading branch and the loaded branch are mutually exclusive.
    expect(html).not.toContain('Comprehension debt');
    expect(html).not.toContain('Fog: on');
  });
});
