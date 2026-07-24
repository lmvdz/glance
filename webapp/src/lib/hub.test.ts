import { describe, expect, test } from 'bun:test';
import { entryAuthorLabel, groupActiveWork, latestSeq, presenceCount, reduceChannelEntries } from './hub';
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

  test('active work groups render server status without client ranking beyond buckets', () => {
    const groups = groupActiveWork([agent('blocked', 'awaiting-input'), agent('run', 'running'), agent('sleep', 'idle'), agent('landed', 'completed')]);
    expect(groups.map((group) => [group.key, group.agents.map((item) => item.id)])).toEqual([
      ['needs-you', ['blocked']],
      ['working', ['run']],
      ['idle', ['sleep']],
      ['done', ['landed']],
    ]);
  });

  test('presence count counts humans, not sockets', () => {
    expect(presenceCount({ users: [{ id: 'u1', displayName: 'Lars', socketCount: 5 }] })).toBe(1);
  });

  test('author labels keep human messages distinct from manager cards', () => {
    expect(entryAuthorLabel(entry({ id: 'u', seq: 1, authorActor: 'user:lars', kind: 'user' }))).toBe('You');
    expect(entryAuthorLabel(entry({ id: 'm', seq: 1, authorActor: 'manager' }))).toBe('glance');
  });
});
