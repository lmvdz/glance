/**
 * AdoptionPanel.test.tsx — static-render coverage of the strip's four states (loading, error, empty,
 * data). Like the sibling panel tests we render the PURE view (AdoptionStripView) to static markup —
 * no fetch, no timers — and assert on what a human actually reads.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdoptionStripView } from './AdoptionPanel';
import { utcDayKey, type AdoptionCounters } from '../lib/adoption';

const NOW = Date.UTC(2026, 6, 17, 12, 0, 0);
const DAY = 86_400_000;
const day = (back: number) => utcDayKey(NOW - back * DAY);

describe('AdoptionStripView', () => {
  test('loading renders the labelled band with skeletons, no numbers', () => {
    const html = renderToStaticMarkup(<AdoptionStripView counters={null} loading error={false} now={NOW} />);
    expect(html).toContain('Adoption');
    expect(html).toContain('animate-pulse');
  });

  test('error (no data) states the daemon may be down and offers retry', () => {
    const html = renderToStaticMarkup(<AdoptionStripView counters={null} loading={false} error onRefresh={() => {}} now={NOW} />);
    expect(html).toContain('unreachable');
    expect(html).toContain('Retry');
  });

  test('empty counters guide the operator to glance here', () => {
    const empty: AdoptionCounters = { casualSessionsByDay: {}, promptsByDay: {}, pushTapsByDay: {} };
    const html = renderToStaticMarkup(<AdoptionStripView counters={empty} loading={false} error={false} now={NOW} />);
    expect(html).toContain('No casual usage captured yet');
    expect(html).toContain('glance here');
  });

  test('data renders all three metric tiles with today value + window total', () => {
    const counters: AdoptionCounters = {
      casualSessionsByDay: { [day(0)]: 4, [day(1)]: 2 },
      promptsByDay: { [day(0)]: 11 },
      pushTapsByDay: { [day(3)]: 1 },
    };
    const html = renderToStaticMarkup(<AdoptionStripView counters={counters} loading={false} error={false} now={NOW} days={14} />);
    expect(html).toContain('Sessions');
    expect(html).toContain('Prompts');
    expect(html).toContain('Push taps');
    // today's session value + 14-day total
    expect(html).toContain('>4<'); // today sessions
    expect(html).toContain('6 in 14d'); // sessions total (4+2)
    expect(html).toContain('11 in 14d'); // prompts total
    // not the empty state
    expect(html).not.toContain('No casual usage captured yet');
  });

  test('stale data survives a background error (counters present, error true) — shows numbers, not the error', () => {
    const counters: AdoptionCounters = { casualSessionsByDay: { [day(0)]: 2 }, promptsByDay: {}, pushTapsByDay: {} };
    const html = renderToStaticMarkup(<AdoptionStripView counters={counters} loading={false} error now={NOW} days={14} />);
    expect(html).not.toContain('unreachable');
    expect(html).toContain('Sessions');
  });
});
