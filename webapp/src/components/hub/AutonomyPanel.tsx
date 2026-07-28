import React, { useEffect } from 'react';
import { ALL_THREE, CONDITIONS, WHY_REVIEW, calibrationLine, delaySentence, interruptHeadline, leavesSentence, reviewPrompt, unwiredNote, type InterruptState } from '../../lib/interruptSurface';
import { apiJson, jsonInit } from '../../lib/api';

/**
 * AutonomyPanel — the fleet's autonomy as a state you can read.
 *
 * `03-machinery.html` specifies 24 zones and the audit found zero. Concerns 11 and 12 have been built
 * this whole time and entirely invisible: the rule that settles a person's work is stored with their
 * exact sentence and could not be seen anywhere, and the boundary refuses on their behalf without ever
 * saying so.
 *
 * A rule nobody can read is indistinguishable from a setting somebody changed. That is the failure
 * this surface exists to end — and the reference states the principle outright: *"This is the fleet's
 * autonomy as a state you can read — there is no settings page behind it."*
 *
 * Three things it does that a permissions screen does not:
 *
 * 1. **Rules are quoted, not summarised.** The human's sentence, verbatim, with who wrote it and when.
 *    Paraphrasing it into a toggle label is how it stops being theirs.
 * 2. **A proposal shows what it would NOT have caught.** The reference gives that its own bordered
 *    block in the alarm tone, because a rule that oversells its reach is worse than no rule — the
 *    person calibrates on the overselling.
 * 3. **The boundary is shown as policy, with reasons.** Not a disabled switch: a list of what no rule
 *    may ever settle, each with one sentence on why, so it can be argued with rather than toggled.
 */

const MONO = "'JetBrains Mono',ui-monospace,monospace";

export interface AutonomyRule {
  id: string;
  sentence: string;
  authorId: string;
  since: number;
  settles: string[];
  invocations: number;
  wouldNotHaveCaught: string[];
}

export interface AutonomyProposal {
  action: string;
  sentence: string;
  evidence: Array<{ id: string; question: string; chose: string }>;
  wouldNotHaveCaught: Array<{ id: string; question: string }>;
}

export interface AutonomyState {
  rules: AutonomyRule[];
  neverAlone: Array<{ class: string; because: string }>;
  proposals: AutonomyProposal[];
  /** What may reach this person when they are not looking at the room. See `interruptSurface`. */
  interrupt?: InterruptState;
}

/**
 * WHEN THIS IS ALLOWED TO INTERRUPT YOU — `04-beyond`.
 *
 * It belongs beside what the fleet may settle, because they are the same question asked twice: what
 * the product may do without you, and what it may pull you back for. A person reading one wants the
 * other.
 *
 * Its first job is to say that the gate is not wired, when it is not. "0 sent" from an unwired gate
 * and "0 sent" from a gate that considered and declined are the same number meaning opposite things,
 * and only one of them means you can walk away safely.
 */
function Interrupt({ state }: { state: InterruptState }) {
  const [judged, setJudged] = React.useState<Record<string, boolean>>({});
  const pendingReview = (state.awaitingReview ?? []).filter((item) => judged[item.id] === undefined);
  const note = unwiredNote(state);
  const calibration = calibrationLine(state.health);
  return (
    <div className="mt-6">
      <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: state.wired ? '#5A5A61' : '#C2704A' }}>
        WHEN THIS IS ALLOWED TO INTERRUPT YOU
      </div>
      <div className="mt-2.5 text-[12.5px] leading-[1.55]" style={{ color: '#DEDEE2', textWrap: 'pretty' }}>{interruptHeadline(state)}</div>
      {note ? <div className="mt-2 text-[12px] leading-[1.5]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>{note}</div> : null}

      <div className="mt-3.5 flex flex-col">
        {CONDITIONS.map((entry, index) => (
          <div key={entry.condition} className="flex gap-3 py-2" style={{ borderTop: '1px solid #17171A' }}>
            <div className="flex-none pt-[1px]" style={{ fontFamily: MONO, fontSize: 10.5, color: '#5A5A61' }}>{index + 1}</div>
            <div className="flex-1">
              <div className="text-[12.5px]" style={{ color: '#DEDEE2' }}>{entry.condition}</div>
              <div className="mt-[3px] text-[11.5px] leading-[1.45]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>{entry.because}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2.5 text-[11.5px] leading-[1.5]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>{ALL_THREE}</div>
      <div className="mt-2 text-[11.5px] leading-[1.5]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>{delaySentence(state.recoveryDelayMs)}</div>
      <div className="mt-2 text-[11.5px] leading-[1.5]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>{leavesSentence(state.leaves)}</div>
      {/* A gate whose sends are never reviewed has no evidence it is calibrated. */}
      {calibration ? <div className="mt-2 text-[11.5px] leading-[1.5]" style={{ color: '#8A6A45', textWrap: 'pretty' }}>{calibration}</div> : null}

      {pendingReview.length > 0 ? (
        <div className="mt-5">
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#D9A03C' }}>
            WAS INTERRUPTING YOU RIGHT?
          </div>
          <div className="mt-2.5 flex flex-col gap-3">
            {pendingReview.map((item) => (
              <div key={item.id}>
                <div className="text-[12.5px] leading-[1.5]" style={{ color: '#DEDEE2', textWrap: 'pretty' }}>{reviewPrompt(item, Date.now())}</div>
                <div className="mt-1.5 flex gap-2">
                  {[true, false].map((worthIt) => (
                    <button
                      key={String(worthIt)}
                      type="button"
                      onClick={() => {
                        // Optimistic, because the whole point is that answering costs one tap. A
                        // failed write means the question comes back on the next read, which is the
                        // correct outcome — an unrecorded verdict must not read as a recorded one.
                        setJudged((prior) => ({ ...prior, [item.id]: worthIt }));
                        void apiJson('/api/interrupt/review', jsonInit('POST', { id: item.id, worthIt })).catch(() => {
                          setJudged((prior) => { const next = { ...prior }; delete next[item.id]; return next; });
                        });
                      }}
                      className="h-7 rounded-[3px] px-2.5"
                      style={{ border: '1px solid #26262B', fontFamily: MONO, fontSize: 10, color: worthIt ? '#6F9E85' : '#C2704A' }}
                    >
                      {worthIt ? 'yes, worth it' : 'no, it could have waited'}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2.5 text-[11.5px] leading-[1.5]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>{WHY_REVIEW}</div>
        </div>
      ) : null}
    </div>
  );
}

function since(ms: number): string {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days < 1) return 'today';
  if (days === 1) return 'since yesterday';
  if (days < 30) return `since ${days} days ago`;
  return `since ${Math.floor(days / 30)} month${days < 60 ? '' : 's'} ago`;
}

export function AutonomyPanel({ state, onAccept, onClose }: { state: AutonomyState; onAccept?: (proposal: AutonomyProposal, sentence: string) => void; onClose?: () => void }) {
  const { rules, neverAlone, proposals, interrupt } = state;
  useEffect(() => {
    if (!onClose) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto px-5 py-4" style={{ background: '#0A0A0B', color: '#E8E8EA' }}>
      {/* The panel takes the rail's place, so the rail's close button goes with it — a surface you can
          open and not shut is a trap. Escape works too. */}
      <div className="flex items-baseline gap-3">
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>WHAT THE FLEET MAY SETTLE TODAY</div>
        <div className="flex-1" />
        {onClose ? (
          <button type="button" onClick={onClose} style={{ fontFamily: MONO, fontSize: 10, color: '#5A5A61' }} title="Close this and bring the tree back.">
            esc closes
          </button>
        ) : null}
      </div>

      {rules.length === 0 ? (
        <div className="mt-3 text-[12.5px] leading-[1.5]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>
          Nothing yet. The fleet asks you about everything, because it has not been told otherwise — and it will keep asking
          until a pattern in your own answers is worth turning into a sentence. Nothing here was configured; there is no
          settings page behind this.
        </div>
      ) : (
        <>
          <div className="mt-2.5 flex flex-col">
            {rules.map((rule) => (
              <div key={rule.id} className="flex gap-3 py-2.5" style={{ borderTop: '1px solid #17171A' }}>
                <div className="mt-1.5 h-[5px] w-[5px] flex-none rounded-full" style={{ background: '#3E7D57' }} />
                <div className="flex-1">
                  {/* Quoted, never paraphrased: the moment it becomes a toggle label it stops being theirs. */}
                  <div className="text-[12.5px] leading-[1.45]" style={{ color: '#DEDEE2', textWrap: 'pretty' }}>“{rule.sentence}”</div>
                  <div className="mt-[3px]" style={{ fontFamily: MONO, fontSize: 10, color: '#5A5A61' }}>
                    {rule.authorId} · {since(rule.since)} · {rule.invocations === 0 ? 'not used yet' : `used ${rule.invocations}×`}
                  </div>
                  {rule.wouldNotHaveCaught.length > 0 ? (
                    <div className="mt-1" style={{ fontFamily: MONO, fontSize: 10, color: '#4A4A52' }}>
                      does not cover: {rule.wouldNotHaveCaught.join('; ')}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3.5 text-[12px] leading-[1.5]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>
            {rules.length} rule{rules.length === 1 ? '' : 's'}, each one a sentence, each one taken back in one action. This is the
            fleet's autonomy as a state you can read — there is no settings page behind it.
          </div>
        </>
      )}

      {proposals.length > 0 ? (
        <div className="mt-6">
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#D9A03C' }}>THE FLEET WOULD LIKE TO STOP ASKING</div>
          {proposals.map((proposal) => (
            <div key={proposal.action} className="mt-2.5">
              <div className="text-[13px] leading-[1.5]" style={{ color: '#DEDEE2', textWrap: 'pretty' }}>{proposal.sentence}</div>

              <div className="mt-3" style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>
                THE {proposal.evidence.length} THAT WOULD NOT HAVE REACHED YOU
              </div>
              <div className="mt-2 flex flex-col gap-1.5">
                {proposal.evidence.map((decision) => (
                  <div key={decision.id} className="flex gap-2.5">
                    <div className="mt-1.5 h-[5px] w-[5px] flex-none rounded-full" style={{ background: '#3E5C8A' }} />
                    <div className="flex-1 text-[12.5px] leading-[1.45]" style={{ color: '#C9C9CF', textWrap: 'pretty' }}>
                      “{decision.question}” — you said {decision.chose}
                    </div>
                  </div>
                ))}
              </div>

              {/* Its own block, in the alarm tone: a rule that oversells its reach is worse than no
                  rule, because the person calibrates on the overselling. */}
              {proposal.wouldNotHaveCaught.length > 0 ? (
                <div className="mt-4 px-3 py-2.5" style={{ border: '1px solid #241A17', borderLeft: '2px solid #B4553A', background: '#100D0C' }}>
                  <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#C2704A' }}>
                    AND THE {proposal.wouldNotHaveCaught.length === 1 ? 'ONE' : proposal.wouldNotHaveCaught.length} THAT WOULD STILL HAVE REACHED YOU
                  </div>
                  <div className="mt-2 text-[13px] leading-[1.5]" style={{ color: '#DEDEE2', textWrap: 'pretty' }}>
                    {proposal.wouldNotHaveCaught.map((decision) => `“${decision.question}”`).join(' · ')}
                  </div>
                  <div className="mt-1.5" style={{ fontFamily: MONO, fontSize: 10, color: '#4A4A52' }}>
                    this rule would not have touched {proposal.wouldNotHaveCaught.length === 1 ? 'it' : 'those'} — a different rule would be needed, and we are not proposing one
                  </div>
                </div>
              ) : null}

              {onAccept ? (
                <div className="mt-3.5 flex items-start gap-3" style={{ borderTop: '1px solid #1F1F22', paddingTop: 13 }}>
                  <div className="w-[230px] flex-none">
                    <button
                      type="button"
                      onClick={() => onAccept(proposal, proposal.sentence)}
                      className="w-full rounded-[3px] px-3.5 py-2.5 text-[13px] font-semibold"
                      style={{ background: '#F0A35A', color: '#140D06' }}
                    >
                      Stop asking me this
                    </button>
                    <div className="mt-1.5 text-[11.5px] leading-[1.45]" style={{ color: '#6A6A72' }}>
                      On this month's evidence that is {proposal.evidence.length} fewer stops and nothing you would have decided differently.
                    </div>
                  </div>
                  <div className="flex-1">
                    <div className="rounded-[3px] px-3 py-2.5 text-[12.5px]" style={{ border: '1px solid #26262B', background: '#0A0A0B', color: '#4A4A52' }}>
                      Or narrow it in words — “only inside a plan, never on main”…
                    </div>
                    <div className="mt-1.5 text-[11.5px] leading-[1.45]" style={{ color: '#6A6A72' }}>
                      The rule is stored as your sentence and quoted wherever it takes effect.
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-6">
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>THE ONES IT WILL NOT DO ALONE</div>
        <div className="mt-2.5 flex flex-col">
          {neverAlone.map((entry) => (
            <div key={entry.class} className="flex gap-3 py-2.5" style={{ borderTop: '1px solid #17171A' }}>
              <div className="mt-1.5 h-[5px] w-[5px] flex-none rounded-full" style={{ background: '#B4553A' }} />
              <div className="flex-1">
                <div className="text-[12.5px]" style={{ color: '#DEDEE2' }}>{entry.class}</div>
                {/* Shown so it can be ARGUED with, not toggled: a disabled switch invites you to look
                    for the enable; a reason invites you to disagree with it. */}
                <div className="mt-[3px] text-[11.5px] leading-[1.45]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>{entry.because}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 text-[12px] leading-[1.5]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>
          No rule widens this, whatever it says about itself, and there is no setting that empties it. A rule proposing to
          settle one of these is refused when it is written, not when it is used.
        </div>
      </div>

      {interrupt ? <Interrupt state={interrupt} /> : null}
    </div>
  );
}
