/**
 * FrictionInbox.test.tsx — static-render coverage of the inbox view + row across the states that
 * matter: loading, error, empty (per-filter), a populated ledger with source labels, and the local
 * acknowledge partition. Renders the PURE view/row to static markup (no fetch/timers/storage).
 */
import { describe, expect, test } from 'bun:test';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FrictionInboxView, FrictionRow } from './FrictionInbox';
import type { FrictionEntry } from '../lib/friction';

const NOW = 1_000_000_000_000;
function entry(p: Partial<FrictionEntry> = {}): FrictionEntry {
  return { id: 'f1', ts: NOW - 60_000, repo: '/home/u/omp-squad', gripe: 'the sync hung again', ...p };
}

const noop = () => {};
function view(p: Partial<ComponentProps<typeof FrictionInboxView>> = {}) {
  return renderToStaticMarkup(
    <FrictionInboxView
      entries={[]}
      loading={false}
      error={false}
      filter="all"
      onFilter={noop}
      acked={new Set()}
      onAck={noop}
      onUnack={noop}
      showAcked={false}
      onToggleShowAcked={noop}
      onRefresh={noop}
      now={NOW}
      {...p}
    />,
  );
}

describe('FrictionInboxView — states', () => {
  test('loading (no entries) shows skeletons, not the empty copy', () => {
    const html = view({ loading: true });
    expect(html).toContain('animate-pulse');
    expect(html).not.toContain('No friction logged yet');
  });

  test('error (no entries) surfaces the daemon-unreachable message', () => {
    const html = view({ error: true });
    expect(html).toContain('reach the daemon for the friction ledger');
  });

  test('empty ledger guides to glance grr', () => {
    const html = view();
    expect(html).toContain('No friction logged yet');
    expect(html).toContain('glance grr');
  });

  test('empty under the auto filter says so specifically', () => {
    const html = view({ filter: 'auto' });
    expect(html).toContain('No auto-captured gripes');
  });
});

describe('FrictionInboxView — populated', () => {
  const entries: FrictionEntry[] = [
    entry({ id: 'h1', gripe: 'the composer ate my draft', context: 'webapp-composer' }),
    entry({ id: 'a1', gripe: 'ACP timed out', context: 'auto:acp-timeout' }),
    entry({ id: 'a2', gripe: 'held sync stranded', source: 'auto' }),
  ];

  test('renders every gripe, the source labels, and the repo chip', () => {
    const html = view({ entries });
    expect(html).toContain('the composer ate my draft');
    expect(html).toContain('ACP timed out');
    expect(html).toContain('held sync stranded');
    expect(html).toContain('omp-squad'); // repo basename chip
    expect(html).toContain('acp-timeout'); // auto subtype chip
    expect(html).toContain('you'); // human badge
    expect(html).toContain('auto'); // auto badge
  });

  test('filter tab counts reflect the source split', () => {
    const html = view({ entries });
    // All 3 · You 1 · Auto 2
    expect(html).toContain('All');
    expect(html).toContain('You');
    expect(html).toContain('Auto');
    expect(html).toContain('3 gripe'); // subtitle count
  });

  test('the human filter drops the two auto rows', () => {
    const html = view({ entries, filter: 'human' });
    expect(html).toContain('the composer ate my draft');
    expect(html).not.toContain('ACP timed out');
    expect(html).not.toContain('held sync stranded');
  });
});

describe('FrictionInboxView — acknowledge partition', () => {
  const entries: FrictionEntry[] = [entry({ id: 'keep', gripe: 'still open' }), entry({ id: 'done', gripe: 'triaged already' })];

  test('an acked entry leaves the open list; the reveal toggle names the count', () => {
    const html = view({ entries, acked: new Set(['done']) });
    expect(html).toContain('1 open'); // one active
    expect(html).toContain('Show 1 acknowledged');
    // the acked gripe is hidden until revealed
    expect(html).not.toContain('triaged already');
  });

  test('revealing shows the acked entry struck through', () => {
    const html = view({ entries, acked: new Set(['done']), showAcked: true });
    expect(html).toContain('triaged already');
    expect(html).toContain('line-through');
  });
});

describe('FrictionRow', () => {
  test('an open row offers Acknowledge; an acked row offers Restore', () => {
    const open = renderToStaticMarkup(<FrictionRow entry={entry()} acked={false} onAck={noop} onUnack={noop} now={NOW} />);
    expect(open).toContain('Acknowledge this gripe');
    expect(open).toContain('1m ago');
    const done = renderToStaticMarkup(<FrictionRow entry={entry()} acked onAck={noop} onUnack={noop} now={NOW} />);
    expect(done).toContain('Restore this gripe to the inbox');
    expect(done).toContain('line-through');
  });
});
