import { describe, expect, test } from 'bun:test';
import { entryAuthorLabel, entryTimeLabel, groupActiveWork, latestSeq, presenceCount, reduceChannelEntries } from './hub';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { RoomFrame, TopBar } from '../components/hub/RoomFrame';
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

  test('a surface opened from the room keeps the room’s bar and says how to leave', () => {
    // There is no second navigation any more. The rail that used to sit here listed WORKBENCH DOORS —
    // Fleet, Tasks, Graph — which is a menu for a different application, and having one is why opening
    // anything still felt like leaving the room.
    const html = renderToStaticMarkup(
      React.createElement(TopBar, { repo: 'omp-squad', summary: '3 units working', now: 0, back: '#fleet' }),
    );
    expect(html).toContain('glance');
    expect(html).toContain('omp-squad');
    expect(html).toContain('3 units working');
    expect(html).toContain('esc goes back to the room');
    expect(html).not.toContain('WORKBENCH DOORS');
  });

  test('the room’s own bar offers no way back, because there is nowhere behind it', () => {
    const html = renderToStaticMarkup(React.createElement(TopBar, { repo: 'omp-squad', now: 0 }));
    expect(html).not.toContain('esc goes back');
  });

  // Dead-doors audit: there is no nav rail (this file's own header comment) — the palette is the
  // real nav for six of the eight built surfaces, and Ctrl/⌘+K had never once been shown on screen.
  // A first-time operator with no reason to already know the shortcut had no way to find it. The bar
  // is the one element every screen shares, so it is the one place a hint reaches all of them.
  test('the bar carries a clickable ⌘K hint when a palette opener is given — the only on-screen way to discover the palette now that there is no rail', () => {
    const html = renderToStaticMarkup(React.createElement(TopBar, { repo: 'omp-squad', now: 0, onOpenPalette: () => undefined }));
    expect(html).toContain('⌘K');
    expect(html).toContain('<button');
  });

  test('without a palette opener the bar stays exactly as before — no half-wired hint pointing at nothing', () => {
    const html = renderToStaticMarkup(React.createElement(TopBar, { repo: 'omp-squad', now: 0 }));
    expect(html).not.toContain('⌘K');
  });

  // The workbench nav strip (WorkbenchNavStrip.tsx) fixed "I was only able to navigate through ⌘K"
  // for the nine workbench surfaces — but it must not leak into the room. RoomFrame's own header
  // comment is the law here: "no channel column — plans and doors are reached from the tree and the
  // palette." That is about the room staying a narrative home screen with cards as doors, and this
  // proves RoomFrame renders none of the strip's markers when given a normal, unremarkable frame.
  test('the room does not render the workbench nav strip — that law only ever governed the room', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        RoomFrame,
        { repo: 'omp-squad', rooms: [], activeRoomId: 'fleet', onOpenRoom: () => undefined, nodes: [], plans: 0, now: 0, onSelect: () => undefined, onEnter: () => undefined },
        'room content',
      ),
    );
    expect(html).not.toContain('aria-label="Workbench surfaces"');
    // Labels that only the strip would ever print in this exact form (the room's own "WHERE YOU ARE
    // STANDING" tree names channels and units, never these workbench surface names).
    expect(html).not.toContain('Plan briefs');
    expect(html).not.toContain('Organization settings');
    expect(html).not.toContain('Capabilities');
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

describe('entry time labels', () => {
  const now = new Date('2026-07-24T15:30:00Z').getTime();

  test('same-day entries print the clock; older entries carry the date', () => {
    const sameDay = entryTimeLabel(new Date('2026-07-24T09:05:00Z').getTime(), now);
    const older = entryTimeLabel(new Date('2026-07-21T09:05:00Z').getTime(), now);
    expect(sameDay).toMatch(/^\d{2}:\d{2}$/);
    expect(older).not.toMatch(/^\d{2}:\d{2}$/);
    expect(older.length).toBeGreaterThan(sameDay.length);
  });

  test('a missing or nonsense timestamp renders nothing rather than "Invalid Date"', () => {
    expect(entryTimeLabel(0, now)).toBe('');
    expect(entryTimeLabel(Number.NaN, now)).toBe('');
  });
});
