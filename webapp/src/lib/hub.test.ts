import { describe, expect, test } from 'bun:test';
import { entryAuthorLabel, groupActiveWork, latestSeq, mergeChannelEntry, presenceCount, reduceChannelEntries } from './hub';
import type { AgentDTO, ChannelEntry } from './dto';

const entry = (overrides: Partial<ChannelEntry> & Pick<ChannelEntry, 'id' | 'seq'>): ChannelEntry => ({
  channelId: 'fleet',
  authorActor: 'manager',
  kind: 'assistant',
  text: 'x',
  ts: 1,
  ...overrides,
});

const agent = (id: string, status: string): AgentDTO => ({
  id,
  name: id,
  status,
  task: '',
  repo: '',
  branch: '',
  createdAt: 0,
  updatedAt: 0,
  messageCount: 0,
} as AgentDTO);

describe('Hub reductions', () => {
  test('channel entries merge by id and stay seq ordered for one channel', () => {
    const next = reduceChannelEntries([entry({ id: 'a', seq: 2, text: 'old' })], [entry({ id: 'a', seq: 2, text: 'new' }), entry({ id: 'b', seq: 1 }), entry({ id: 'x', seq: 3, channelId: 'other' })], 'fleet');
    expect(next.map((item) => `${item.id}:${item.text}`)).toEqual(['b:x', 'a:new']);
    expect(latestSeq(next)).toBe(2);
  });

  test('live channel-entry dispatch upserts instead of duplicating replayed seq frames', () => {
    const previous = [entry({ id: 'a', seq: 1, text: 'old' }), entry({ id: 'b', seq: 2, text: 'second' })];
    const replay = entry({ id: 'a', seq: 1, text: 'updated' });
    const next = mergeChannelEntry(previous, replay);
    expect(next.map((item) => `${item.id}:${item.text}`)).toEqual(['a:updated', 'b:second']);
  });

  test('active work groups render server status without client ranking beyond buckets', () => {
    const groups = groupActiveWork([agent('blocked', 'awaiting-input'), agent('run', 'running'), agent('sleep', 'idle'), agent('landed', 'completed')]);
    expect(groups.map((group) => [group.key, group.agents.map((item) => item.id)])).toEqual([
      ['needs-you', ['blocked']],
      ['working', ['run']],
      ['idle', ['sleep']],
      ['done', ['landed']],
    ]);
  });

  test('presence count sums sockets with at least one visible avatar per user', () => {
    expect(presenceCount({ users: [{ id: 'u1', displayName: 'Lars', socketCount: 2 }, { id: 'u2', displayName: 'A', socketCount: 0 }] })).toBe(3);
  });

  test('author labels keep human messages distinct from manager cards', () => {
    expect(entryAuthorLabel(entry({ id: 'u', seq: 1, authorActor: 'user:lars', kind: 'user' }))).toBe('You');
    expect(entryAuthorLabel(entry({ id: 'm', seq: 1, authorActor: 'manager' }))).toBe('glance');
  });
});
