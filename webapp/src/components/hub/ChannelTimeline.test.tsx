import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChannelTimeline } from './ChannelTimeline';
import type { ChannelEntry } from '../../lib/dto';

const channelEntry = (overrides: Partial<ChannelEntry> & Pick<ChannelEntry, 'id' | 'seq'>): ChannelEntry => ({
  id: overrides.id,
  seq: overrides.seq,
  channelId: 'fleet',
  authorActor: 'manager',
  kind: 'assistant',
  text: 'manager reply',
  ts: 1_000 + overrides.seq,
  ...overrides,
});

describe('ChannelTimeline acceptance', () => {
  test('renders human messages, agent replies, and proof cards in channel sequence order', () => {
    const entries: ChannelEntry[] = [
      channelEntry({
        id: 'proof-3',
        seq: 3,
        authorActor: 'manager',
        kind: 'assistant',
        text: 'Proof accepted',
        event: { kind: 'proof-card', payload: { face: { title: 'Done proof', status: 'fresh', summary: 'verify passed' } } },
      }),
      channelEntry({ id: 'human-1', seq: 1, authorActor: 'user:lars', kind: 'user', text: 'Ship concern 08' }),
      channelEntry({ id: 'agent-2', seq: 2, authorActor: 'agent:tester', kind: 'assistant', text: 'Writing the channel timeline' }),
    ];

    const html = renderToStaticMarkup(<ChannelTimeline channelId="fleet" entries={entries} />);

    expect(html).toContain('data-channel-timeline="fleet"');
    expect(html).toContain('data-channel-card="human-message"');
    expect(html).toContain('data-channel-card="agent-reply"');
    expect(html).toContain('data-channel-card="proof-card"');
    expect(html).toContain('Done proof');
    expect(html).toContain('fresh');
    expect(html.indexOf('Ship concern 08')).toBeLessThan(html.indexOf('Writing the channel timeline'));
    expect(html.indexOf('Writing the channel timeline')).toBeLessThan(html.indexOf('Done proof'));
  });

  test('falls back to a neutral text card for unknown event kinds without crashing', () => {
    const entries: ChannelEntry[] = [
      channelEntry({
        id: 'unknown-1',
        seq: 1,
        authorActor: 'manager',
        kind: 'assistant',
        text: 'new-daemon event payload',
        event: { kind: 'future-proof-v99', payload: { face: { title: 'Future card' } } },
      }),
    ];

    const html = renderToStaticMarkup(<ChannelTimeline channelId="fleet" entries={entries} />);

    expect(html).toContain('data-channel-card="event-fallback"');
    expect(html).toContain('new-daemon event payload');
    expect(html).toContain('future-proof-v99');
    expect(html).not.toContain('Future card');
  });
});
