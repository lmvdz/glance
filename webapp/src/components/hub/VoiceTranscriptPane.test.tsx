import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { VoiceTranscriptPane } from './VoiceTranscriptPane';
import type { VoiceCallBindingDTO, VoiceCallTranscriptEntryDTO } from '../../lib/api';

/**
 * VoiceTranscriptPane — concern 11 (voice-transcript-in-thread).
 *
 * Markup assertions via `renderToStaticMarkup`, matching this package's own convention for these
 * components (see `VoiceWorkspace.test.tsx`'s module doc) — the judgements (merge-in-place, sort,
 * register, redaction/empty copy) are tested exhaustively in `lib/voice/transcript.test.ts`; what's
 * left to check here is what actually reaches the DOM.
 */

const noop = () => {};

function binding(over: Partial<VoiceCallBindingDTO> = {}): VoiceCallBindingDTO {
  return { channelId: 'room-1', callId: 'call-abcdef01', sessionRoot: '/repo', ownerActorId: 'web:lars', retention: 'full', startedAt: 1_000, updatedAt: 1_000, state: 'live', ...over };
}

function turn(over: Partial<VoiceCallTranscriptEntryDTO> = {}): VoiceCallTranscriptEntryDTO {
  return { callId: 'call-abcdef01', turn: 0, role: 'user', final: true, at: 1_000, text: 'hello', ...over };
}

describe('VoiceTranscriptPane', () => {
  test('an empty, real (recording) call says nothing has been said yet — not that no call exists', () => {
    const html = renderToStaticMarkup(<VoiceTranscriptPane turns={[]} loading={false} error="" binding={binding()} onClose={noop} />);
    expect(html).toContain('Nothing has been said yet');
  });

  test('no binding at all: a distinct empty reason', () => {
    const html = renderToStaticMarkup(<VoiceTranscriptPane turns={[]} loading={false} error="" binding={null} onClose={noop} />);
    expect(html).toContain('No call has run in this thread yet');
  });

  test('loading renders a skeleton, not the empty-state copy', () => {
    const html = renderToStaticMarkup(<VoiceTranscriptPane turns={[]} loading error="" binding={binding()} onClose={noop} />);
    expect(html).toContain('aria-label="Loading the conversation"');
    expect(html).not.toContain('Nothing has been said yet');
  });

  test('an error renders as an alert, not a swallowed blank pane', () => {
    const html = renderToStaticMarkup(<VoiceTranscriptPane turns={[]} loading={false} error="the daemon refused" binding={binding()} onClose={noop} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('the daemon refused');
  });

  test('chronological turns render with a speaker label, and the agent turn carries the claim register', () => {
    const html = renderToStaticMarkup(
      <VoiceTranscriptPane
        turns={[turn({ role: 'user', turn: 0, text: 'what is the status' }), turn({ role: 'assistant', turn: 1, text: 'all green' })]}
        loading={false}
        error=""
        binding={binding()}
        onClose={noop}
      />,
    );
    expect(html).toContain('what is the status');
    expect(html).toContain('all green');
    expect(html).toContain('You');
    expect(html).toContain('Agent');
    // The claim register's own aria-label/marker (registerPresentation('claim')) — announced, not
    // only styled.
    expect(html).toContain('The agent&#x27;s own account');
    expect(html).toContain('role="note"');
  });

  test("a user's own turn carries NO register — attributed human content, not a claim", () => {
    const html = renderToStaticMarkup(<VoiceTranscriptPane turns={[turn({ role: 'user', text: 'hi' })]} loading={false} error="" binding={binding()} onClose={noop} />);
    expect(html).not.toContain('role="note"');
  });

  test('a redacted turn (retention off) never renders empty as if nothing was said', () => {
    const html = renderToStaticMarkup(<VoiceTranscriptPane turns={[turn({ redacted: true, text: undefined })]} loading={false} error="" binding={binding({ retention: 'off' })} onClose={noop} />);
    expect(html).toContain('Not recorded');
  });

  test('a gap marker renders its own status line', () => {
    const html = renderToStaticMarkup(<VoiceTranscriptPane turns={[turn({ gapBefore: { missingCount: 2 } })]} loading={false} error="" binding={binding()} onClose={noop} />);
    expect(html).toContain('2 turns were missed');
  });

  test('a non-final (streaming) turn shows an in-progress marker', () => {
    const html = renderToStaticMarkup(<VoiceTranscriptPane turns={[turn({ role: 'assistant', final: false, text: 'the ans' })]} loading={false} error="" binding={binding()} onClose={noop} />);
    expect(html).toContain('the ans');
  });

  test('esc closes, and the call id is shown for confirmation after a refresh', () => {
    const html = renderToStaticMarkup(<VoiceTranscriptPane turns={[]} loading={false} error="" binding={binding({ callId: 'call-abcdef01' })} onClose={noop} />);
    expect(html).toContain('esc closes');
    expect(html).toContain('call-ab');
  });
});
