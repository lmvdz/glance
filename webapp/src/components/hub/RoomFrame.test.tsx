import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoomFrame } from './RoomFrame';

/**
 * RoomFrame layout — markup assertions only, matching this package's convention: RoomFrame is a
 * plain function of its props, so what actually needs pinning is what ends up in the DOM, not a
 * decision table (that lives in `lib/roomFrame.ts` / `lib/roomState.ts` already).
 */

const noop = () => {};

const baseProps = {
  repo: 'omp-squad',
  rooms: [],
  activeRoomId: 'fleet',
  onOpenRoom: noop,
  nodes: [],
  plans: 0,
  now: 0,
  onSelect: noop,
  onEnter: noop,
};

describe('RoomFrame — one side panel at a time', () => {
  test('a fleet decision and the call workspace panel never render side by side', () => {
    // Both requested at once — the shape a `needs-you` answer arriving mid-call actually produces.
    const html = renderToStaticMarkup(
      <RoomFrame {...baseProps} decision={<div>FLEET DECISION MARKER</div>} voicePanel={<div>VOICE PANEL MARKER</div>}>
        <div>the conversation</div>
      </RoomFrame>,
    );
    expect(html).toContain('VOICE PANEL MARKER');
    // Exactly one renders: the call workspace panel takes the rail's slot, same precedence autonomy
    // and unit panels already give it, so wide screens never squeeze the conversation between two
    // side-by-side panels.
    expect(html).not.toContain('FLEET DECISION MARKER');
  });

  test('with no call workspace panel open, the fleet decision panel renders as before', () => {
    const html = renderToStaticMarkup(
      <RoomFrame {...baseProps} decision={<div>FLEET DECISION MARKER</div>}>
        <div>the conversation</div>
      </RoomFrame>,
    );
    expect(html).toContain('FLEET DECISION MARKER');
  });

  test('the call workspace panel alone still renders with nothing to suppress it', () => {
    const html = renderToStaticMarkup(
      <RoomFrame {...baseProps} voicePanel={<div>VOICE PANEL MARKER</div>}>
        <div>the conversation</div>
      </RoomFrame>,
    );
    expect(html).toContain('VOICE PANEL MARKER');
  });
});

describe('RoomFrame — the standing tree folds settled units and never grows unbounded', () => {
  const rooms = [
    { id: 'fleet', name: '#fleet', unread: 0, kind: 'room' as const, settled: false },
    { id: 'node:live', name: '#ompsq-461', unread: 2, kind: 'node' as const, settled: false },
    { id: 'node:done', name: '#ompsq-463', unread: 0, kind: 'node' as const, settled: true },
  ];

  test('#fleet and every active unit render unconditionally', () => {
    const html = renderToStaticMarkup(
      <RoomFrame {...baseProps} rooms={rooms}>
        <div>the conversation</div>
      </RoomFrame>,
    );
    expect(html).toContain('#fleet');
    expect(html).toContain('#ompsq-461');
  });

  test('a settled unit’s channel is folded away by default, behind a count rather than a row', () => {
    const html = renderToStaticMarkup(
      <RoomFrame {...baseProps} rooms={rooms}>
        <div>the conversation</div>
      </RoomFrame>,
    );
    expect(html).not.toContain('#ompsq-463');
    expect(html).toContain('1 settled');
  });

  test('the rail is a bounded, scrollable region — the ink idiom other panels already use — not an unbounded list', () => {
    const html = renderToStaticMarkup(
      <RoomFrame {...baseProps} rooms={rooms}>
        <div>the conversation</div>
      </RoomFrame>,
    );
    expect(html).toContain('max-h-64');
    expect(html).toContain('overflow-y-auto');
    expect(html).toContain('scrollbar-custom');
  });

  test('with nothing settled, no fold control renders at all', () => {
    const html = renderToStaticMarkup(
      <RoomFrame {...baseProps} rooms={rooms.filter((room) => !room.settled)}>
        <div>the conversation</div>
      </RoomFrame>,
    );
    expect(html).not.toContain('settled');
  });
});

describe('RoomFrame — the status dot cannot contradict the count', () => {
  // `idle` had no branch of its own and fell through to the ember reserved for running work, so the
  // rail painted a unit as executing while the top bar (correctly) refused to count it as working.
  // A colour channel that disagrees with the number is worse than either being wrong alone, because
  // the operator has no way to tell which one to believe.
  test('an idle unit is not painted with the ember reserved for running work', () => {
    const node = { id: 'a', address: '1', title: 'the parser', state: 'idle' as const };
    const html = renderToStaticMarkup(<RoomFrame {...baseProps} nodes={[node]} />);
    expect(html).toContain('the parser');
    expect(html).toContain('#4A4A52');
    // The ember must not appear as this row's dot fill.
    expect(html).not.toMatch(/rounded-full[^>]*background:#F0A35A/);
  });

  test('a genuinely in-flight unit keeps the ember', () => {
    const node = { id: 'a', address: '1', title: 'the migration', state: 'in-flight' as const };
    const html = renderToStaticMarkup(<RoomFrame {...baseProps} nodes={[node]} />);
    expect(html).toMatch(/rounded-full[^>]*background:#F0A35A/);
  });
});
