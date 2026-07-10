import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { VoiceCallPillView } from './VoiceCallPill';

const baseProps = {
  bindingBanner: 'voice → Fix the flaky test',
  stateLabel: 'Listening — hold to talk',
  captionSpeaker: null as 'assistant' | 'user' | null,
  captionText: '',
  elapsedLabel: '0:07',
  costLabel: '~$0.02',
  reconnectNotice: null as string | null,
  pttEngaged: false,
  panelOpen: false,
  onPttDown: () => {},
  onPttUp: () => {},
  onPttLeave: () => {},
  onEndCall: () => {},
};

describe('VoiceCallPillView', () => {
  test('shows the pinned-session banner and elapsed/cost meter', () => {
    const html = renderToStaticMarkup(<VoiceCallPillView {...baseProps} />);
    expect(html).toContain('voice → Fix the flaky test');
    expect(html).toContain('0:07');
    expect(html).toContain('~$0.02');
    expect(html).toContain('End voice call');
  });

  test('per-state indicator renders the state label passed in', () => {
    for (const stateLabel of ['Recording…', 'Thinking…', 'Speaking…', 'Working…', 'Connecting…']) {
      const html = renderToStaticMarkup(<VoiceCallPillView {...baseProps} stateLabel={stateLabel} />);
      expect(html).toContain(stateLabel);
    }
  });

  test('renders the live caption line, tagged by speaker', () => {
    const assistantHtml = renderToStaticMarkup(<VoiceCallPillView {...baseProps} captionSpeaker="assistant" captionText="On it." />);
    expect(assistantHtml).toContain('Agent:');
    expect(assistantHtml).toContain('On it.');

    const userHtml = renderToStaticMarkup(<VoiceCallPillView {...baseProps} captionSpeaker="user" captionText="Stop the deploy" />);
    expect(userHtml).toContain('You:');
    expect(userHtml).toContain('Stop the deploy');
  });

  test('omits the caption line entirely when there is nothing to show', () => {
    const html = renderToStaticMarkup(<VoiceCallPillView {...baseProps} captionText="" />);
    expect(html).not.toContain('You:');
    expect(html).not.toContain('Agent:');
  });

  test('shows the reconnect notice banner when present, omits it otherwise', () => {
    const withNotice = renderToStaticMarkup(<VoiceCallPillView {...baseProps} reconnectNotice="Reconnected — recapping context." />);
    expect(withNotice).toContain('Reconnected — recapping context.');

    const without = renderToStaticMarkup(<VoiceCallPillView {...baseProps} reconnectNotice={null} />);
    expect(without).not.toContain('Reconnected');
  });

  test('the PTT button reflects its engaged/idle visual state via distinct classes', () => {
    const idleHtml = renderToStaticMarkup(<VoiceCallPillView {...baseProps} pttEngaged={false} />);
    const engagedHtml = renderToStaticMarkup(<VoiceCallPillView {...baseProps} pttEngaged />);
    expect(idleHtml).not.toBe(engagedHtml);
  });

  // MAJOR-1: the pill's own fixed anchor must clear both the Agent FAB (App.tsx: `fixed bottom-4
  // right-4 z-40`, shown when the chat panel is closed) and the Composer (docked at the bottom of
  // the chat panel, which itself occupies the same bottom-right screen rectangle when open).
  describe('MAJOR-1: fixed-position anchor clears the FAB (closed) and the composer (open)', () => {
    test('panel closed: anchors above the bottom-right corner (clear of the Agent FAB at bottom-4 right-4)', () => {
      const html = renderToStaticMarkup(<VoiceCallPillView {...baseProps} panelOpen={false} />);
      expect(html).toContain('bottom-16');
      expect(html).toContain('right-4');
      expect(html).not.toContain('top-16');
    });

    test('panel open: anchors near the top instead, unconditionally clear of the composer at the bottom', () => {
      const html = renderToStaticMarkup(<VoiceCallPillView {...baseProps} panelOpen={true} />);
      expect(html).toContain('top-16');
      expect(html).toContain('right-4');
      expect(html).not.toContain('bottom-16');
    });
  });
});
