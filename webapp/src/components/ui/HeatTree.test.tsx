/**
 * HeatTree.test.tsx — static-render tests for the "Context Heat Graph" (comprehension concern 04's
 * fog overlay). Like this repo's other component tests, we don't mount with a DOM/testing-library —
 * `renderToStaticMarkup` never runs effects, so `fogData`/`initialFogMode` (props specifically for
 * this) let a test render the "fog on, data already loaded" branch in one static pass, exercising
 * exactly what a parent that already fetched `/api/fog` (or this component's own self-fetch, once
 * resolved) would show. All the underlying DECISIONS (join, aggregation, cold-start, ranking) have
 * their own exhaustive tests in `heatmap.test.ts`; this file only checks the renderer wires them up
 * and draws the three tri-states as visually distinct.
 */

import { expect, test, describe } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { HeatTree } from './HeatTree';
import { buildHeatTree, magma } from '../../lib/heatmap';
import type { HeatNode } from '../../lib/insights';
import type { FogPayload } from '../../lib/api';

const REPO = '/home/lars/sui/demo-repo';
const DAYS = ['2026-07-14', '2026-07-15'];

const NODES: HeatNode[] = [
  { id: 'src/a.ts', heat: [1, 2], repo: REPO },
  { id: 'src/b.ts', heat: [0, 1], repo: REPO },
  { id: 'src/c.ts', heat: [3, 0], repo: REPO },
];

function tree() {
  return buildHeatTree(NODES, DAYS.length);
}

const MIXED_FOG: FogPayload = {
  entries: [
    { repo: REPO, file: 'src/a.ts', changesSinceSeen: 5, lastChangedAt: 2000, debt: 0.7, state: 'never-seen' },
    { repo: REPO, file: 'src/b.ts', changesSinceSeen: 0, lastChangedAt: 1000, lastSeenAt: 1_000_000, debt: 0.1, state: 'seen-current' },
    { repo: REPO, file: 'src/c.ts', changesSinceSeen: 9, lastChangedAt: 3000, lastSeenAt: 500, debt: 0.9, state: 'stale' },
  ],
  repoHasHistory: { [REPO]: true },
};

describe('HeatTree — heat mode (default, no fog props)', () => {
  test('renders the base heat grid untouched, with the Fog toggle off', () => {
    const html = renderToStaticMarkup(
      <HeatTree days={DAYS} tree={tree()} showPatterns={false} defaultExpanded={['src']} />,
    );
    expect(html).toContain('Context heat graph');
    expect(html).toContain('Heat over time');
    expect(html).toContain('Heat = files touched per day, from agent receipts.');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('>Fog<'); // no ": on" suffix while off
    // no fog-only surfaces leak into heat mode
    expect(html).not.toContain('Comprehension debt');
    expect(html).not.toContain('view activity is recorded');
  });

  test('empty tree still shows the plain empty-state box, fog props notwithstanding', () => {
    const html = renderToStaticMarkup(
      <HeatTree days={DAYS} tree={buildHeatTree([], DAYS.length)} showPatterns={false} fogData={MIXED_FOG} initialFogMode />,
    );
    expect(html).toContain('No receipt-backed file writes in this window.');
    expect(html).not.toContain('Fog');
  });
});

describe('HeatTree — fog mode (initialFogMode + preloaded fogData)', () => {
  test('toggle reads on, disclosure line and comprehension-debt header render', () => {
    const html = renderToStaticMarkup(
      <HeatTree days={DAYS} tree={tree()} showPatterns={false} defaultExpanded={['src']} fogData={MIXED_FOG} initialFogMode />,
    );
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Fog: on');
    expect(html).toContain('view activity is recorded to compute this overlay');
    expect(html).toContain('team-level, renames reset history');
    expect(html).toContain('Comprehension debt');
    expect(html).toContain('Fog = comprehension debt since you last looked');
  });

  test('renders the top debt shortlist headline with file, debt %, and last-seen text', () => {
    const html = renderToStaticMarkup(
      <HeatTree days={DAYS} tree={tree()} showPatterns={false} defaultExpanded={['src']} fogData={MIXED_FOG} initialFogMode />,
    );
    expect(html).toContain('Comprehension debt — top 3');
    expect(html).toContain('src/c.ts'); // debt 0.9 — the shortlist headline
    expect(html).toContain('90%');
    expect(html).toContain('never'); // src/a.ts has no lastSeenAt at all
  });

  test('never-seen, seen-current, and stale render three visually DISTINCT cell treatments', () => {
    const html = renderToStaticMarkup(
      <HeatTree days={DAYS} tree={tree()} showPatterns={false} defaultExpanded={['src']} fogData={MIXED_FOG} initialFogMode />,
    );
    // never-seen: a hatched pattern, never a plain magma color
    expect(html).toContain('repeating-linear-gradient');
    expect(html).toContain('never seen');
    // seen-current: the fixed clear/dimmed fill
    expect(html).toContain('rgba(255,255,255,0.045)');
    expect(html).toContain('caught up');
    // stale: the SAME magma ramp heat mode uses, keyed by debt (0.9), not a hatch and not the dim fill
    expect(html).toContain(magma(0.9));
    expect(html).toContain('stale since last seen');
  });

  test('cold-start repo (repoHasHistory: false) shows the empty state, never the ramp', () => {
    const coldFog: FogPayload = { entries: MIXED_FOG.entries, repoHasHistory: { [REPO]: false } };
    const html = renderToStaticMarkup(
      <HeatTree days={DAYS} tree={tree()} showPatterns={false} defaultExpanded={['src']} fogData={coldFog} initialFogMode />,
    );
    expect(html).toContain('No view history yet');
    expect(html).not.toContain('repeating-linear-gradient');
    expect(html).not.toContain('Comprehension debt — top');
  });

  test('disabled attention substrate shows its own honest message, not an empty ramp', () => {
    const disabledFog: FogPayload = { entries: [], repoHasHistory: {}, disabled: true };
    const html = renderToStaticMarkup(
      <HeatTree days={DAYS} tree={tree()} showPatterns={false} defaultExpanded={['src']} fogData={disabledFog} initialFogMode />,
    );
    expect(html).toContain('Comprehension fog is disabled for this daemon.');
  });

  /** Batch-3 review regression (concern 04 minor): `repoHasHistory`'s key and the tree node's raw
   *  `repo` (both ultimately from the SAME `/home/lars/sui/demo-repo`) differ only by a trailing
   *  slash on the `repoHasHistory` side here — `attachFog`'s join treats them as the same repo, so
   *  the cold-start empty state must render too, never the real ramp underneath a formatting quirk. */
  test('cold-start repo whose repoHasHistory key has a trailing slash the tree node repo lacks still shows the empty state', () => {
    const slashFog: FogPayload = { entries: MIXED_FOG.entries, repoHasHistory: { [`${REPO}/`]: false } };
    const html = renderToStaticMarkup(
      <HeatTree days={DAYS} tree={tree()} showPatterns={false} defaultExpanded={['src']} fogData={slashFog} initialFogMode />,
    );
    expect(html).toContain('No view history yet');
    expect(html).not.toContain('repeating-linear-gradient');
    expect(html).not.toContain('Comprehension debt — top');
  });

  test('a file with no matching fog entry at all renders the neutral "no data" fill, not a fabricated zero', () => {
    const partialFog: FogPayload = {
      entries: [{ repo: REPO, file: 'src/a.ts', changesSinceSeen: 1, lastChangedAt: 1000, debt: 0.4, state: 'stale' }],
      repoHasHistory: { [REPO]: true },
    };
    const html = renderToStaticMarkup(
      <HeatTree days={DAYS} tree={tree()} showPatterns={false} defaultExpanded={['src']} fogData={partialFog} initialFogMode />,
    );
    // src/b.ts and src/c.ts have no fog entry — honest "no data", distinguishable from both the
    // hatch and the real magma ramp.
    expect(html).toContain('no fog data for this node');
  });
});
