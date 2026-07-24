import { describe, expect, test } from 'bun:test';
import { entryAuthorLabel, groupActiveWork, latestSeq, presenceCount, reduceChannelEntries } from './hub';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { ChannelRail } from '../components/hub/ChannelRail';
import type { AgentDTO, ChannelEntry } from './dto';

const entry = (overrides: Partial<ChannelEntry> & Pick<ChannelEntry, 'id' | 'seq'>): ChannelEntry => ({
  channelId: 'fleet',
  authorActor: 'manager',
  kind: 'assistant',
  text: 'x',
  ts: 1,
  ...overrides,
});

const agent = (id: string, status: string, over: Partial<AgentDTO> = {}): AgentDTO => ({
  id,
  name: id,
  status,
  task: '',
  repo: '',
  branch: '',
  createdAt: 0,
  updatedAt: 0,
  ...over,
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

  test('room rail active work shows console/casual unit channel routing with #fleet fallback', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChannelRail, {
        channels: [{ id: 'fleet', name: '#fleet', kind: 'default', createdAt: 1 }, { id: 'ops', name: 'ops', kind: 'user', createdAt: 2 }],
        activeChannelId: 'fleet',
        agents: [agent('chat-1', 'input', { name: 'chat', channelId: 'ops' }), agent('chat-2', 'working', { name: 'chat' })],
        selectedAgentId: undefined,
        onSelectAgent: () => {},
        workbenchActive: false,
      }),
    );
    expect(html).toContain('Active work');
    expect(html).toContain('#ops');
    expect(html).toContain('#fleet');
  });

  test('presence count counts humans, not sockets', () => {
    expect(presenceCount({ users: [{ id: 'u1', displayName: 'Lars', socketCount: 5 }] })).toBe(1);
  });

  test('author labels use stamped display names and classify every room entry by origin', () => {
    const cases: Array<{ name: string; entry: ChannelEntry; label: string }> = [
      {
        name: 'local human',
        entry: entry({ id: 'local', seq: 1, kind: 'user', authorActor: 'db:u1', authorDisplayName: 'Lars Operator', authorOrigin: 'local' }),
        label: 'Lars Operator · human',
      },
      {
        name: 'remote human',
        entry: entry({ id: 'remote', seq: 2, kind: 'user', authorActor: 'web:peer', authorOrigin: 'remote' }),
        label: 'peer · human',
      },
      {
        name: 'agent',
        entry: entry({ id: 'agent', seq: 3, authorActor: 'agent:planner', authorDisplayName: 'Planner Bot', authorOrigin: 'agent' }),
        label: 'Planner Bot · agent',
      },
      {
        name: 'manager system with a display name',
        entry: entry({ id: 'manager-named', seq: 4, kind: 'system', authorActor: 'manager', authorDisplayName: 'Room Manager' }),
        label: 'Room Manager · system',
      },
      {
        name: 'manager system fallback',
        entry: entry({ id: 'manager', seq: 5, kind: 'system', authorActor: 'manager' }),
        label: 'glance · system',
      },
      {
        name: 'other system',
        entry: entry({ id: 'system', seq: 6, kind: 'system', authorActor: 'daemon:watch', authorDisplayName: 'Watchdog' }),
        label: 'Watchdog · system',
      },
    ];

    expect(cases.map(({ name, entry }) => [name, entryAuthorLabel(entry)])).toEqual(cases.map(({ name, label }) => [name, label]));
  });
});
