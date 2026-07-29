import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { entryAuthorLabel, entryTimeLabel, groupActiveWork, latestSeq, presenceCount, reduceChannelEntries } from './hub';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { RoomFrame, TopBar } from '../components/hub/RoomFrame';
import { NAV_ROWS } from './commandPalette';
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
    // Every NAV_ROWS label, not a sample of three — a name this test doesn't check is exactly the
    // one a future edit could leak into the room unnoticed. ('Fleet' is excluded: the room's own
    // "WHERE YOU ARE STANDING" tree legitimately prints room names, and the default room IS named
    // "fleet" — that word appearing here would not mean the strip leaked in.)
    for (const row of NAV_ROWS) {
      if (row.label === 'Fleet') continue;
      expect(html).not.toContain(row.label);
    }
  });

  // The rendered-output check above proves the room's OUTPUT is clean for one representative set of
  // props; it can't rule out a prop combination that would light the strip up. This proves the
  // actual component boundary instead: RoomFrame.tsx does not import WorkbenchNavStrip at all, so
  // there is no code path — no matter what props RoomFrame is given — that could render it.
  test('RoomFrame does not import the workbench nav strip — the boundary is enforced in the source, not just in one rendered sample', () => {
    const source = readFileSync(join(import.meta.dir, '../components/hub/RoomFrame.tsx'), 'utf8');
    expect(source).not.toContain('WorkbenchNavStrip');
  });

  // Post-ship fix: fleet navbar. A 2026-07-28 user report found the #fleet channel view rendering
  // without its navbar (TopBar) after a heavy merge day (suspected culprits: the rail-dedup commit,
  // the concern 10/11 call-management restructuring, concern 12's registry rows). Diagnosis found
  // no code path that actually drops it — TopBar sits unconditionally at the top of every
  // RoomFrame render, for every room including fleet — but the report is real enough to deserve a
  // permanent guard against exactly this regression, for the fleet room's own shape: an id of
  // 'fleet', no other rooms yet, no nodes yet (a fresh install's first-ever visit).
  test('the fleet room always renders its own TopBar ("the navbar") — it must never be conditional on room content', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        RoomFrame,
        {
          repo: 'omp-squad',
          rooms: [{ id: 'fleet', name: '#fleet', unread: 0, kind: 'room', settled: false }],
          activeRoomId: 'fleet',
          onOpenRoom: () => undefined,
          nodes: [],
          plans: 0,
          now: 0,
          onSelect: () => undefined,
          onEnter: () => undefined,
        },
        'room content',
      ),
    );
    expect(html).toContain('glance'); // TopBar's own wordmark
    expect(html).toContain('#fleet'); // the room itself, in the standing tree beside it
  });

  // The rendered-output check above proves one representative prop set; this proves the fleet
  // room's TopBar survives every panel that can take the standing tree's place (voice pane,
  // decision door, autonomy panel, unit panel) — none of those are allowed to carry the navbar
  // away with them, since RoomFrame renders TopBar before any of that branching even starts.
  test('the fleet room keeps its TopBar even when a decision panel takes the standing tree\'s place', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        RoomFrame,
        {
          repo: 'omp-squad',
          rooms: [{ id: 'fleet', name: '#fleet', unread: 0, kind: 'room', settled: false }],
          activeRoomId: 'fleet',
          onOpenRoom: () => undefined,
          nodes: [],
          plans: 0,
          now: 0,
          onSelect: () => undefined,
          onEnter: () => undefined,
          decision: React.createElement('div', null, 'a decision panel'),
        },
        'room content',
      ),
    );
    expect(html).toContain('glance');
    expect(html).toContain('a decision panel');
  });

  // Post-ship fix: composer call controls. The standing "Call" banner (`VoiceCallHudView`) that
  // used to render above every timeline is gone — its start/mute/end controls moved into the
  // composer's icon row (`RoomCallIconControls`). Same boundary-enforcement idiom as the
  // WorkbenchNavStrip check above: proves the removal in the SOURCE, not just in one rendered
  // sample, so no future prop combination can bring the banner back by accident.
  test('HubShell does not import the old standing call banner — its controls live in the composer now', () => {
    const source = readFileSync(join(import.meta.dir, '../components/hub/HubShell.tsx'), 'utf8');
    expect(source).not.toContain('VoiceCallHudView');
    expect(source).toContain('roomCall={{'); // sanity: the replacement prop is actually wired, not just deleted
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
