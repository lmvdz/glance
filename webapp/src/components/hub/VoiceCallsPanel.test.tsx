import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { VoiceCallsPanel } from './VoiceCallsPanel';
import type { VoiceCallBindingDTO, VoiceCallOrphanDTO } from '../../lib/api';

/**
 * VoiceCallsPanel — concern 10 (call-management-ui). Markup assertions via `renderToStaticMarkup`,
 * matching this package's own convention; the row-building/urgency judgements are tested
 * exhaustively in `lib/voice/roomCall.test.ts` — this checks what actually reaches the DOM: real
 * End/Reattach buttons, an urgent marker, and the empty/loading/error states.
 */

const noop = () => {};
const noop1 = (_: string) => {};

function binding(over: Partial<VoiceCallBindingDTO> = {}): VoiceCallBindingDTO {
  return { channelId: 'room-1', callId: 'call-1', sessionRoot: '/repo', ownerActorId: 'web:lars', retention: 'full', startedAt: 1_000, updatedAt: 1_000, state: 'live', controlsAvailable: true, ...over };
}

function orphan(over: Partial<VoiceCallOrphanDTO> = {}): VoiceCallOrphanDTO {
  return { callId: 'call-orphan-1', startedAt: 1_000, ...over };
}

const baseProps = {
  bindings: [] as VoiceCallBindingDTO[],
  orphans: [] as VoiceCallOrphanDTO[],
  loading: false,
  error: '',
  endingCallIds: new Set<string>(),
  endingChannelIds: new Set<string>(),
  reattachingChannelIds: new Set<string>(),
  onEndOrphan: noop1,
  onEndBinding: noop1,
  onReattachBinding: noop1,
  onClose: noop,
};

describe('VoiceCallsPanel', () => {
  test('no calls anywhere: an honest empty state, not a blank pane', () => {
    const html = renderToStaticMarkup(<VoiceCallsPanel {...baseProps} />);
    expect(html).toContain('No calls anywhere');
  });

  test('loading renders a skeleton', () => {
    const html = renderToStaticMarkup(<VoiceCallsPanel {...baseProps} loading />);
    expect(html).toContain('aria-label="Loading calls"');
  });

  test('an error renders as an alert', () => {
    const html = renderToStaticMarkup(<VoiceCallsPanel {...baseProps} error="the daemon is unreachable" />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('the daemon is unreachable');
  });

  test('a live binding shows its channel, phase, and a checked mic badge — End offered, Reattach not', () => {
    const html = renderToStaticMarkup(<VoiceCallsPanel {...baseProps} bindings={[binding({ channelId: 'room-1', state: 'live', controlsAvailable: true })]} />);
    expect(html).toContain('#room-1');
    expect(html).toContain('mic checked');
    expect(html).toContain('aria-label="End the call in room-1"');
    expect(html).not.toContain('aria-label="Reattach to the call in room-1"');
  });

  test('a degraded binding is urgent, unverified, and offers BOTH End and Reattach', () => {
    const html = renderToStaticMarkup(<VoiceCallsPanel {...baseProps} bindings={[binding({ channelId: 'room-2', state: 'degraded', controlsAvailable: false })]} />);
    expect(html).toContain('mic unverified');
    expect(html).toContain('role="alert"'); // the "urgent" marker
    expect(html).toContain('aria-label="End the call in room-2"');
    expect(html).toContain('aria-label="Reattach to the call in room-2"');
  });

  test('an ended binding offers neither End nor Reattach', () => {
    const html = renderToStaticMarkup(<VoiceCallsPanel {...baseProps} bindings={[binding({ channelId: 'room-3', state: 'ended', controlsAvailable: false })]} />);
    expect(html).not.toContain('aria-label="End the call in room-3"');
    expect(html).not.toContain('aria-label="Reattach to the call in room-3"');
  });

  test('an orphan has no room name, is unverified and urgent, and offers End only — never Reattach (there is no channel)', () => {
    const html = renderToStaticMarkup(<VoiceCallsPanel {...baseProps} orphans={[orphan({ callId: 'call-ghost' })]} />);
    expect(html).toContain('orphan (no room)');
    expect(html).toContain('mic unverified');
    expect(html).toContain(`aria-label="End orphan call call-ghost"`);
    expect(html).not.toContain('Reattach');
    expect(html).toContain('broker still lists this process running');
  });

  test('busy End/Reattach disable their own button, single-flight per row', () => {
    const html = renderToStaticMarkup(
      <VoiceCallsPanel
        {...baseProps}
        bindings={[binding({ channelId: 'room-4', state: 'degraded', controlsAvailable: false })]}
        endingChannelIds={new Set(['room-4'])}
        reattachingChannelIds={new Set(['room-4'])}
      />,
    );
    expect(html).toContain('disabled');
  });

  test('esc closes', () => {
    const html = renderToStaticMarkup(<VoiceCallsPanel {...baseProps} />);
    expect(html).toContain('esc closes');
  });
});
