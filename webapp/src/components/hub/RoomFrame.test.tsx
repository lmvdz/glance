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
