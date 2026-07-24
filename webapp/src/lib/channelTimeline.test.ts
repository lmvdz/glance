import { describe, expect, test } from 'bun:test';
import { dispatchChannelCard, latestChannelSeq, reduceChannelEntryWindow } from './channelTimeline';
import type { ChannelEntry } from './dto';

const entry = (overrides: Partial<ChannelEntry> & Pick<ChannelEntry, 'id' | 'seq'>): ChannelEntry => ({
  id: overrides.id,
  seq: overrides.seq,
  channelId: 'fleet',
  authorActor: 'manager',
  kind: 'assistant',
  text: 'fallback text',
  ts: overrides.seq,
  ...overrides,
});

describe('channel timeline dispatch', () => {
  test('renders pointer cards from pinned face payload fields', () => {
    const card = dispatchChannelCard(entry({
      id: 'n1',
      seq: 1,
      event: { kind: 'needs-you', payload: { face: { title: 'Review gate', eyebrow: 'Needs you', body: 'Approve the run', detail: 'Waiting at validation.', tone: 'warning', pinned: { agent: 'room-08', verdict: 'held' } } } },
    }));
    expect(card.kind).toBe('needs-you');
    expect(card.title).toBe('Review gate');
    expect(card.body).toBe('Approve the run');
    expect(card.pinned).toEqual([{ label: 'Agent', value: 'room-08' }, { label: 'Verdict', value: 'held' }]);
  });

  test('unknown event kinds become neutral fallback cards', () => {
    const card = dispatchChannelCard(entry({ id: 'future', seq: 2, event: { kind: 'future-proof', payload: { face: { title: 'Ignored' } } } }));
    expect(card.kind).toBe('unknown-event');
    expect(card.tone).toBe('neutral');
    expect(card.title).toBe('Future Proof');
    expect(card.body).toBe('fallback text');
  });
});

describe('channel entry reduction', () => {
  test('merges reconnect resync batches without gaps or dupes', () => {
    const current = [entry({ id: 'a', seq: 1 }), entry({ id: 'b', seq: 2 })];
    const resync = [entry({ id: 'b', seq: 2, text: 'updated' }), entry({ id: 'c', seq: 3 }), entry({ id: 'x', seq: 4, channelId: 'other' })];
    const next = reduceChannelEntryWindow(current, resync, 'fleet');
    expect(next.map((item) => `${item.seq}:${item.id}:${item.text}`)).toEqual(['1:a:fallback text', '2:b:updated', '3:c:fallback text']);
    expect(latestChannelSeq(next)).toBe(3);
  });
});
