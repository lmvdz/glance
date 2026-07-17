/**
 * DailyPanel.test.tsx — static-render coverage of the Daily driver view (plans/daily-driver-w15/04).
 *
 * `renderToStaticMarkup` runs no effects (the /api/adoption + /api/friction self-fetch never fires),
 * so the container test only asserts the panel chrome + loading skeleton mount (never blank) — the
 * FogView.test.tsx pattern. The data/empty/error renders are proven directly against the exported
 * presentational sub-blocks with fixtures, which is where the Verify section's cases live: counters
 * with data, honest-empty counters, a friction list mixing auto + human + LEGACY SOURCELESS rows,
 * the zero-friction empty state, and the poll-error state.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdoptionCounters, DailyPanel, FrictionLedger, FrictionRow } from './DailyPanel';
import { buildAdoptionView, type FrictionEntryWire } from '../lib/adoption-view';

const NOW = Date.UTC(2026, 6, 17, 12, 0, 0);

describe('AdoptionCounters', () => {
  test('with activity: three labeled tiles, today values, and a "this week" sub — real 0-today data shows', () => {
    const view = buildAdoptionView(
      { casualSessionsByDay: { '2026-07-17': 3 }, promptsByDay: { '2026-07-17': 5 }, pushTapsByDay: { '2026-07-16': 2 } },
      NOW,
    );
    const html = renderToStaticMarkup(<AdoptionCounters view={view} />);
    expect(html).toContain('Casual sessions');
    expect(html).toContain('Prompts');
    expect(html).toContain('Push taps');
    expect(html).toContain('3 this week'); // sessions
    expect(html).toContain('2 this week'); // push taps: 0 today, 2 this week (honest, not fake-zero)
    expect(html).not.toContain('No activity recorded yet');
  });

  test('no activity: an honest empty state, never zeros dressed up as data', () => {
    const view = buildAdoptionView({ casualSessionsByDay: {}, promptsByDay: {}, pushTapsByDay: {} }, NOW);
    const html = renderToStaticMarkup(<AdoptionCounters view={view} />);
    expect(html).toContain('No activity recorded yet');
    expect(html).toContain('glance here');
  });
});

const autoRow: FrictionEntryWire = { id: 'a', ts: NOW - 60_000, repo: '/home/u/glance', gripe: 'ACP prompt timed out', source: 'auto', context: 'auto:acp-timeout', agentId: 'chat-1' };
const humanRow: FrictionEntryWire = { id: 'h', ts: NOW - 3_600_000, repo: '/home/u/glance', gripe: 'the diff view scrolls to top', source: 'human', context: 'webapp-composer' };
const legacyRow: FrictionEntryWire = { id: 'l', ts: NOW - 7_200_000, repo: '/home/u/glance', gripe: 'old gripe from before the source field' }; // sourceless

describe('FrictionLedger', () => {
  test('mixed rows render: auto AND human AND legacy-sourceless (legacy reads as you, never crashes)', () => {
    const html = renderToStaticMarkup(<FrictionLedger entries={[autoRow, humanRow, legacyRow]} loaded now={NOW} />);
    expect(html).toContain('ACP prompt timed out');
    expect(html).toContain('the diff view scrolls to top');
    expect(html).toContain('old gripe from before the source field');
    // auto/human distinction is visible in the rendered markup
    expect(html).toContain('auto');
    expect(html).toContain('you');
    expect(html).toContain('ACP timeout'); // prettified context, not the raw auto: token
    expect(html).toContain('glance'); // repo basename, not the full path in the visible label
    expect(html).toContain('3 · 1 auto · 2 yours'); // header count line
  });

  test('legacy sourceless row is tagged as human (you), not auto', () => {
    const html = renderToStaticMarkup(<FrictionLedger entries={[legacyRow]} loaded now={NOW} />);
    expect(html).toContain('you');
    expect(html).not.toContain('>auto<');
  });

  test('zero friction: an honest empty state with a next action', () => {
    const html = renderToStaticMarkup(<FrictionLedger entries={[]} loaded now={NOW} />);
    expect(html).toContain('Nothing filed');
    expect(html).toContain('grr');
  });

  test('poll error: an alert, not a blank card', () => {
    const html = renderToStaticMarkup(<FrictionLedger entries={[]} loaded error="Could not reach the daemon for the friction ledger." now={NOW} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('Could not reach the daemon');
  });

  test('not loaded: a skeleton, never blank', () => {
    const html = renderToStaticMarkup(<FrictionLedger entries={[]} loaded={false} now={NOW} />);
    expect(html).toContain('Loading friction ledger');
  });
});

describe('FrictionRow', () => {
  test('auto row carries the AUTO tag and its prettified cause', () => {
    const html = renderToStaticMarkup(<FrictionRow entry={autoRow} now={NOW} />);
    expect(html).toContain('auto');
    expect(html).toContain('ACP timeout');
    expect(html).toContain('1m ago');
  });
  test('human row carries the YOU tag and passes its capture surface through', () => {
    const html = renderToStaticMarkup(<FrictionRow entry={humanRow} now={NOW} />);
    expect(html).toContain('you');
    expect(html).toContain('webapp-composer');
  });
});

describe('DailyPanel — initial render (before the self-fetch resolves)', () => {
  test('mounts the panel chrome and a loading skeleton, never blank', () => {
    const html = renderToStaticMarkup(<DailyPanel />);
    expect(html).toContain('Daily driver');
    expect(html).toContain('Loading friction ledger'); // skeleton path
    expect(html).toContain('Refresh daily driver signals'); // the refresh control's aria-label
  });
});
