import React, { useEffect, useRef } from 'react';
import { registerPresentation, type DecisionDoorModel } from '../../lib/voice/roomCall';

/**
 * VoiceDecisionDoor — answering an agent's question from inside the room.
 *
 * Built on `DecisionPanel`'s shape (beside the conversation, never over it; every option carries
 * its consequence; a recommendation is visible and never pre-selected) but driven by
 * daemon-projected decision state rather than a fleet `PendingRequest`, which changes four things:
 *
 * 1. **The question is the AGENT'S CLAIM, and says so.** `register: 'claim'` renders it italic in a
 *    contrast-checked ink token, with a `role="note"` wrapper whose accessible name announces the
 *    register — so the distinction survives for a reader who cannot see italics. Everything around
 *    it — the state line, the confirmation chrome, the resolution — is daemon-OBSERVED and rendered
 *    as chrome, in the room's own voice.
 * 2. **Confirmation is a server-side state, not a client one.** A `requiresConfirmation` decision
 *    goes open → awaiting-confirmation → answered through the arbiter. This panel renders whichever
 *    state the daemon reports and never advances it locally.
 * 3. **A refusal reports its ACTUAL reason.** A competing resolution says it was already answered;
 *    a label mismatch says the options changed. Never "try again".
 * 4. **A resolved decision is inspect-only.** The options stay readable, with the chosen one marked
 *    — the record of what was decided — but nothing is clickable, because there is nothing left to
 *    decide.
 */

const MONO = "'JetBrains Mono',ui-monospace,monospace";

export interface VoiceDecisionDoorProps {
  model: DecisionDoorModel;
  /** Provenance, so the question is never a floating sentence: which call, and who is asking. */
  callId?: string;
  agentLabel?: string;
  /** 1-of-N across the thread's waiting decisions. */
  index?: number;
  total?: number;
  /** The option currently being sent, so exactly one control shows the in-flight state. */
  pendingOptionIndex?: number;
  /** The arbiter's own refusal, already turned into a sentence by `resolveOutcomeCopy`. */
  refusal?: string;
  onChoose: (optionIndex: number, label: string) => void;
  /** The confirming second act, when the daemon has moved the decision to awaiting-confirmation. */
  onConfirm: () => void;
  onCancelConfirm: () => void;
  onClose: () => void;
}

export function VoiceDecisionDoor({
  model,
  callId,
  agentLabel,
  index,
  total,
  pendingOptionIndex,
  refusal,
  onChoose,
  onConfirm,
  onCancelConfirm,
  onClose,
}: VoiceDecisionDoorProps) {
  const headingRef = useRef<HTMLDivElement | null>(null);
  const register = registerPresentation(model.register);

  useEffect(() => {
    // Escape returns to the room, exactly as the panel's own chrome promises — but never while
    // someone is typing, because Escape in a field means "abandon what I am writing".
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    // The panel is OPENED by a deliberate act, so moving focus into it is expected rather than
    // stolen — and it lands on the heading, not on an option. A caret sitting on "Merge and
    // publish" is a pre-selection by another name, and one stray Enter away from being a decision
    // nobody made. (An ARRIVING decision does not open this panel at all; it announces itself in
    // the polite live region — see `decisionAnnouncement`.)
    headingRef.current?.focus();
  }, [model.id]);

  const inspectOnly = model.resolved;

  return (
    <aside
      className="flex w-full flex-none flex-col overflow-hidden md:w-[560px]"
      // Reduced-motion opt-in for the whole panel — see index.css.
      data-room-workspace=""
      style={{ background: '#0C0B0B', borderLeft: '1px solid #1F1F22' }}
      aria-label={`Answering a question from the call${agentLabel ? ` — ${agentLabel}` : ''}`}
    >
      <div className="flex-none px-5 pb-3 pt-3.5" style={{ borderBottom: '1px solid #1F1F22', borderLeft: `2px solid ${inspectOnly ? '#3E7D57' : '#D9A03C'}` }}>
        <div className="flex items-baseline gap-2.5">
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.16em', color: inspectOnly ? '#5A8A6E' : '#D9A03C' }}>
            {inspectOnly ? 'DECIDED' : 'ANSWER THE QUESTION'}
            {total && total > 1 ? ` · ${index ?? 1} OF ${total}` : ''}
          </div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-10 items-center rounded-[3px] px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
            style={{ fontFamily: MONO, fontSize: 10, color: '#5A5A61' }}
          >
            esc closes · nothing is lost
          </button>
        </div>

        {/* Provenance: which call, and which agent. A question with no origin is a question you
            cannot weigh. */}
        <div className="mt-2.5 flex flex-wrap items-baseline gap-2.5" style={{ fontFamily: MONO, fontSize: 10, color: '#6A6A72' }}>
          <span>{agentLabel ?? 'the call'}</span>
          {callId ? <span title={`Call ${callId}`}>call {callId.slice(0, 8)}</span> : null}
        </div>

        {/* THE QUESTION — the agent's own account, and the room says so out loud. `role="note"`
            with an accessible name gives the register to a screen reader; the italic gives it to a
            sighted reader; the contrast-checked token means neither pays for it in legibility. */}
        <div
          ref={headingRef}
          tabIndex={-1}
          role="note"
          aria-label={register?.ariaLabel}
          title={register?.title}
          className="mt-2.5 max-w-[480px] text-[17px] leading-[1.45] focus-visible:outline-none"
          style={{ textWrap: 'pretty', ...(register?.style ?? { color: '#F2F2F4' }) }}
        >
          {model.question}
        </div>
        {register?.marker ? (
          <div className="mt-1" style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', color: '#7A7A82' }} aria-hidden>
            {register.marker}
          </div>
        ) : null}

        {/* Daemon-observed state is CHROME, deliberately in a different voice from the claim above. */}
        <div className="mt-2 text-[12px] leading-[1.5]" style={{ color: '#8A8A91' }}>{model.stateLine}</div>

        {model.uiOnly && !inspectOnly ? (
          <div className="mt-2 text-[11.5px] leading-[1.5]" style={{ color: '#C2704A', textWrap: 'pretty' }}>
            This one is answered here, by hand. Merging, publishing, spending and deleting are never resolved by voice.
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3.5">
        {refusal ? (
          <div className="mb-3.5 px-3.5 py-2.5" style={{ border: '1px solid #241A17', borderLeft: '2px solid #B4553A', background: '#100D0C' }} role="alert">
            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#C2704A' }}>THE ANSWER WAS NOT RECORDED</div>
            <div className="mt-1.5 text-[12.5px] leading-[1.5]" style={{ color: '#DEDEE2', textWrap: 'pretty' }}>{refusal}</div>
          </div>
        ) : null}

        {model.awaitingConfirmation ? (
          <div className="mb-3.5 px-3.5 py-3" style={{ border: '1px solid #2A2216', borderLeft: '2px solid #D9A03C', background: '#12100C' }}>
            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#D9A03C' }}>CONFIRM IT</div>
            <p className="mt-1.5 text-[12.5px] leading-[1.5]" style={{ color: '#DEDEE2', textWrap: 'pretty' }}>
              The session is holding your answer and waiting for you to confirm. Saying it out loud does the same thing — this
              is the same confirmation state either way, so whichever you use, it only counts once.
            </p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onConfirm}
                className="inline-flex min-h-10 items-center rounded-[3px] px-3 text-[12.5px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 active:scale-[0.99]"
                style={{ background: '#F0A35A', color: '#140D06' }}
              >
                Confirm
              </button>
              <button
                type="button"
                onClick={onCancelConfirm}
                className="inline-flex min-h-10 items-center rounded-[3px] px-3 text-[12.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2"
                style={{ border: '1px solid #26262B', color: '#C9C9CF' }}
              >
                Not yet
              </button>
            </div>
          </div>
        ) : null}

        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>
          {inspectOnly ? 'WHAT THE OPTIONS WERE' : 'THE OPTIONS, AND WHAT EACH ONE DOES'}
        </div>

        {model.options.length === 0 ? (
          <p className="mt-2.5 text-[12.5px] leading-[1.5]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>
            The agent asked without offering options. Answer it in the call, out loud — there is nothing here to click, and the
            room will not invent choices it was not given.
          </p>
        ) : (
          // A plain list of real buttons: Tab reaches each one, Enter and Space activate it, and
          // NOTHING is checked, defaulted, or autofocused. There is no radio group here on purpose —
          // a radio group has a selected member the moment you arrow into it, which is exactly the
          // pre-selection the reference forbids.
          <ul className="mt-2.5 flex flex-col gap-2.5">
            {model.options.map((option) => {
              const chosen = model.resolution?.label === option.label;
              const pending = pendingOptionIndex === option.index;
              return (
                <li key={option.index}>
                  {inspectOnly ? (
                    <div
                      className="flex items-start gap-3 rounded-[3px] px-3 py-2.5"
                      style={{ border: `1px solid ${chosen ? '#274434' : '#1C1C20'}`, background: chosen ? '#0C110E' : 'transparent' }}
                    >
                      <div className="flex-1">
                        <div className="text-[13px]" style={{ color: chosen ? '#DEEBE2' : '#8A8A91' }}>{option.label}</div>
                        <div className="mt-1 text-[11.5px] leading-[1.45]" style={{ color: '#6A6A72' }}>{option.consequence}</div>
                      </div>
                      {chosen ? <div className="flex-none" style={{ fontFamily: MONO, fontSize: 10, color: '#5A8A6E' }}>chosen</div> : null}
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onChoose(option.index, option.label)}
                      disabled={pendingOptionIndex !== undefined}
                      className="flex w-full items-start gap-3 rounded-[3px] px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                      style={{ border: '1px solid #26262B', minHeight: 44 }}
                    >
                      <div className="flex-1">
                        <div className="text-[13px]" style={{ color: '#E8E8EA' }}>{option.label}</div>
                        {/* No control acts without saying what it does. */}
                        <div className="mt-1 text-[11.5px] leading-[1.45]" style={{ color: '#7A7A82' }}>{option.consequence}</div>
                      </div>
                      {option.recommended ? (
                        // Visible advice, never a selection. It is also the AGENT'S recommendation,
                        // which is why it is worded as something it said rather than something the
                        // room knows.
                        <div className="flex-none" style={{ fontFamily: MONO, fontSize: 10, color: '#7A7A82' }}>it recommends this</div>
                      ) : null}
                      {pending ? <div className="flex-none" style={{ fontFamily: MONO, fontSize: 10, color: '#D9A03C' }}>sending…</div> : null}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {model.resolution ? (
          <p className="mt-3.5 text-[12px] leading-[1.5]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>
            Recorded as “{model.resolution.label}”, answered {model.resolution.source === 'voice' ? 'out loud' : 'here'}. The agent
            was given the words you chose, not anything it wrote for you.
          </p>
        ) : null}
      </div>
    </aside>
  );
}
