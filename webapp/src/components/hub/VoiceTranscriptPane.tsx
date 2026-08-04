import React from 'react';
import { AlertCircle } from 'lucide-react';
import { registerPresentation } from '../../lib/voice/roomCall';
import { transcriptEmptyCopy, transcriptGapCopy, transcriptTurnBody, transcriptTurnRegister, transcriptTurnSpeakerLabel, transcriptTurnStartsNewGroup } from '../../lib/voice/transcript';
import { channelScrollAfterRowsChange, channelScrollAfterUserScroll, initialChannelScrollState, type ChannelScrollState } from '../../lib/channelScroll';
import type { VoiceCallBindingDTO, VoiceCallTranscriptEntryDTO } from '../../lib/api';

/**
 * VoiceTranscriptPane — the call's conversation pane (concern 11, plans/voice-orchestrated-room-
 * integration/11-voice-transcript-in-thread.md).
 *
 * Product decision recorded in the concern doc: this is a CALL-SCOPED pane, opened from the
 * voice-call card's door (or the HUD) — never a second copy of the main channel timeline, and never
 * rendered INTO it. `#fleet`'s own timeline gets no turns.
 *
 * Three disciplines carried over from the rest of this workspace, on purpose:
 *  - Scroll discipline via the SAME `channelScroll.ts` primitives `ChannelTimeline` already uses —
 *    a turn arriving never yanks a reader who has scrolled up to read an earlier one.
 *  - Streaming replace-in-place: a non-final turn for `(role, turn)` becomes final turn for the SAME
 *    key later, in the SAME row — `useVoiceCallTranscript`/`mergeLiveTurn` guarantee this array
 *    already reflects that; this component only renders what it is given.
 *  - Agent speech renders in the `claim` register (the SAME primitive `VoiceDecisionDoor`/the
 *    timeline's own voice cards use) — the room recorded that it was said, not that it is true. A
 *    caller's own turn carries no register: it is attributed human content, not a claim about it.
 */

const MONO = "'JetBrains Mono',ui-monospace,monospace";

export interface VoiceTranscriptPaneProps {
  turns: VoiceCallTranscriptEntryDTO[];
  loading: boolean;
  error: string;
  binding: VoiceCallBindingDTO | null;
  onClose: () => void;
}

export function VoiceTranscriptPane({ turns, loading, error, binding, onClose }: VoiceTranscriptPaneProps) {
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  const scrollStateRef = React.useRef<ChannelScrollState>(initialChannelScrollState());

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Scroll discipline: a new turn only pulls the reader to the bottom while they were already
  // there — the SAME `channelScrollAfterRowsChange`/`channelScrollAfterUserScroll` pair
  // `ChannelTimeline` uses for the main conversation, so a reader scrolled up to re-read an earlier
  // exchange never gets yanked back down by a live turn landing.
  React.useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || loading) return;
    const result = channelScrollAfterRowsChange(scrollStateRef.current, { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight });
    scrollStateRef.current = result.state;
    if (result.scrollTop !== undefined) scroller.scrollTop = result.scrollTop;
  }, [turns, loading]);

  const onScroll = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scrollStateRef.current = channelScrollAfterUserScroll(scrollStateRef.current, { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight });
  };

  const empty = !loading && !error && turns.length === 0;

  return (
    <aside
      className="flex w-full flex-none flex-col overflow-hidden md:w-[520px]"
      data-room-workspace=""
      style={{ background: '#0C0C0D', borderLeft: '1px solid #1F1F22' }}
      aria-label="The call's conversation"
    >
      <div className="flex-none px-4 pb-2.5 pt-3.5" style={{ borderBottom: '1px solid #1F1F22' }}>
        <div className="flex items-baseline gap-2.5">
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.16em', color: '#5A5A61' }}>THE CALL'S CONVERSATION</div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-10 items-center rounded-[3px] px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
            style={{ fontFamily: MONO, fontSize: 10, color: '#5A5A61' }}
          >
            esc closes
          </button>
        </div>
        {binding?.callId ? (
          <p className="mt-1 truncate" style={{ fontFamily: MONO, fontSize: 10, color: '#4A4A52' }} title={`call ${binding.callId}`}>
            call {binding.callId.slice(0, 8)}
          </p>
        ) : null}
      </div>

      <div ref={scrollerRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-3" data-scroll-mode={scrollStateRef.current.mode}>
        {loading ? (
          <div className="space-y-2" aria-label="Loading the conversation">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="h-10 rounded-[3px] skeleton" style={{ border: '1px solid #1C1C20', background: '#101012' }} />
            ))}
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 px-3 py-2.5 text-[12.5px]" style={{ border: '1px solid #241A17', borderLeft: '2px solid #B4553A', background: '#100D0C', color: '#DEDEE2' }} role="alert">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-none" style={{ color: '#C2704A' }} aria-hidden />
            <span style={{ textWrap: 'pretty' }}>{error}</span>
          </div>
        ) : empty ? (
          <p className="text-[12.5px] leading-[1.5]" style={{ color: '#7A7A82', textWrap: 'pretty' }}>
            {transcriptEmptyCopy({ hasBinding: binding !== null, retentionOff: binding?.retention === 'off', loading: false })}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {turns.map((turn, index) => {
              const register = registerPresentation(transcriptTurnRegister(turn.role));
              const startsGroup = transcriptTurnStartsNewGroup(turns, index);
              const key = `${turn.role}:${turn.turn}`;
              return (
                <li key={key} data-entry-id={key}>
                  {turn.gapBefore ? (
                    <p className="mb-1.5 text-[11px]" style={{ fontFamily: MONO, color: '#B98A55', letterSpacing: '.04em' }} role="status">
                      {transcriptGapCopy(turn.gapBefore)}
                    </p>
                  ) : null}
                  {startsGroup ? (
                    <div className="mb-0.5" style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.12em', color: turn.role === 'assistant' ? '#8AA6C2' : '#8A8A91' }}>
                      {transcriptTurnSpeakerLabel(turn.role)}
                      {!turn.final ? <span className="ml-1.5" style={{ color: '#5A5A61' }}>…</span> : null}
                    </div>
                  ) : null}
                  {register ? (
                    <div role="note" aria-label={register.ariaLabel} title={register.title} className="text-[13px] leading-[1.55]" style={{ textWrap: 'pretty', ...register.style }}>
                      {transcriptTurnBody(turn)}
                    </div>
                  ) : (
                    <div className="text-[13px] leading-[1.55]" style={{ color: '#DEDEE2', textWrap: 'pretty' }}>
                      {transcriptTurnBody(turn)}
                    </div>
                  )}
                  {!startsGroup && !turn.final ? <span style={{ color: '#5A5A61' }}>…</span> : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
