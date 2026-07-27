import React, { useEffect, useRef, useState } from 'react';
import { apiJson } from '../../lib/api';

/**
 * DecisionPanel — a person answering a stopped agent.
 *
 * This is the core interaction of the product and it did not exist: the alarm band showed the
 * questions and nothing could answer them in place. `02-surfaces.html` specifies 34 zones for it; the
 * audit found 3.
 *
 * Three things the reference does that a normal dialog does not, and they are the whole point:
 *
 * 1. **Answering does not take the room away.** The panel is beside the conversation, not over it.
 *    The reference says so in the left column: "the composer is still here — answering doesn't take
 *    the room away." A modal would make you leave the fleet to answer one question about it.
 * 2. **Words are the primary answer, not the fallback.** "ANSWER IN WORDS" is the ember-bordered box
 *    and the preset options sit underneath it. Most real answers are "per endpoint is right, but make
 *    the window configurable" — which no button can express, and which a form-shaped screen quietly
 *    discourages.
 * 3. **Every option carries its consequence.** Not "Per endpoint" but "Wren resumes in about twenty
 *    seconds and finishes 3.2 today. 3.2.1 starts behind her." A choice whose result you have to guess
 *    is a choice you make wrong.
 *
 * It also states what the agent already worked out BEFORE offering the choice, because a person
 * deciding without that is re-deriving what the agent already knows.
 */

const MONO = "'JetBrains Mono',ui-monospace,monospace";

export interface DecisionOption {
  label: string;
  /** What happens if this is chosen. Never omitted — a control without one is not finished. */
  consequence: string;
  /** Set when the agent has a view. Visible, never pre-selected. */
  preferred?: boolean;
}

export interface DecisionRequest {
  id: string;
  agentName: string;
  /** Spoken address plus what it is, e.g. "3.2 retry-budget". */
  address: string;
  stoppedAgoMs?: number;
  question: string;
  /** Why the agent stopped rather than picking. */
  context?: string;
  /** What it already established, so the person is not re-deriving it. */
  findings?: string[];
  options?: DecisionOption[];
  /** How many are waiting in total, for the "1 of 3" counter. */
  index?: number;
  total?: number;
  /** The unit this belongs to, so the panel can fetch what is being decided about. */
  unitId?: string;
  /** Where its conversation lives, for when there is nothing else to show. */
  unitHref?: string;
}

function ago(ms: number | undefined): string {
  if (ms === undefined) return 'just now';
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return 'moments ago';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m ago`;
}

/**
 * The thing the question is about.
 *
 * Fetches the unit's own plan when there is one. When there is not, it says so and points at the
 * unit's conversation, which is where the reasoning actually lives — because "nothing to show" and
 * "nothing exists" are different, and only one of them is a reason to answer blind.
 */
function Subject({ unitId, unitHref, question }: { unitId?: string; unitHref?: string; question: string }) {
  const [plan, setPlan] = React.useState<{ path: string; content: string } | undefined>();
  const [state, setState] = React.useState<'idle' | 'loading' | 'none'>('idle');
  const [open, setOpen] = React.useState(true);

  React.useEffect(() => {
    if (!unitId) { setState('none'); return; }
    let alive = true;
    setState('loading');
    apiJson<{ path: string; content: string }>(`/api/agents/${encodeURIComponent(unitId)}/plan`)
      .then((doc) => { if (alive) { setPlan(doc); setState('idle'); } })
      .catch(() => { if (alive) { setPlan(undefined); setState('none'); } });
    return () => { alive = false; };
  }, [unitId]);

  const aboutAPlan = /\bplan\b/i.test(question);

  if (state === 'loading') {
    return <div style={{ fontFamily: MONO, fontSize: 10, color: '#4A4A52' }}>reading what this is about…</div>;
  }

  if (!plan) {
    // Only claimed where it matters. A gate that is not about a document does not need to apologise
    // for having no document.
    if (!aboutAPlan) return null;
    return (
      <div className="px-3.5 py-2.5" style={{ border: '1px solid #241A17', borderLeft: '2px solid #B4553A', background: '#100D0C' }}>
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#C2704A' }}>THE PLAN ITSELF DID NOT COME WITH THE QUESTION</div>
        <div className="mt-2 text-[12.5px] leading-[1.5]" style={{ color: '#DEDEE2', textWrap: 'pretty' }}>
          You are being asked to approve something this screen cannot show you. No plan file was found in the unit's
          worktree, so the reasoning is wherever it said it — answering without reading it is answering blind, and that
          is worth knowing before you pick.
        </div>
        {unitHref ? (
          <a href={unitHref} className="mt-2 inline-block" style={{ fontFamily: MONO, fontSize: 10.5, color: '#F0A35A' }}>
            open the unit's conversation ›
          </a>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-baseline gap-2.5 text-left"
        style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}
      >
        <span>WHAT YOU ARE BEING ASKED TO APPROVE</span>
        <span style={{ color: '#4A4A52' }}>{plan.path}</span>
        <span className="flex-1" />
        <span style={{ color: '#4A4A52' }}>{open ? 'hide' : 'read it'}</span>
      </button>
      {open ? (
        <div
          className="mt-2.5 overflow-y-auto whitespace-pre-wrap px-3.5 py-3 text-[12.5px]"
          style={{ border: '1px solid #1F1F22', background: '#0C0C0D', color: '#C9C9CF', lineHeight: 1.65, maxHeight: 340, textWrap: 'pretty' }}
        >
          {plan.content}
        </div>
      ) : null}
    </div>
  );
}

export function DecisionPanel({
  request,
  onAnswer,
  onClose,
}: {
  request: DecisionRequest;
  onAnswer: (answer: string) => void;
  onClose: () => void;
}) {
  const [words, setWords] = useState('');
  const wordsRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    // Words first, literally: the caret starts in the free-text box, not on a button.
    wordsRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside
      className="flex w-[560px] flex-none flex-col overflow-hidden"
      style={{ background: '#0C0B0B', borderLeft: '1px solid #1F1F22' }}
      aria-label={`Answering ${request.agentName}`}
    >
      <div className="flex-none px-5 pb-3 pt-3.5" style={{ borderBottom: '1px solid #1F1F22', borderLeft: '2px solid #D9A03C' }}>
        <div className="flex items-baseline gap-2.5">
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.16em', color: '#D9A03C' }}>
            ANSWERING{request.total && request.total > 1 ? ` · ${request.index ?? 1} OF ${request.total}` : ''}
          </div>
          <div className="flex-1" />
          {/* Says the cost of leaving before you do it. */}
          <div style={{ fontFamily: MONO, fontSize: 10, color: '#5A5A61' }}>esc closes · nothing is lost</div>
        </div>

        <div className="mt-3 flex items-baseline gap-2.5">
          <div className="text-[13px] font-semibold">{request.agentName}</div>
          <div style={{ fontFamily: MONO, fontSize: 10, color: '#6A6A72' }}>
            {request.address} · stopped {ago(request.stoppedAgoMs)}
          </div>
        </div>

        <div className="mt-2.5 max-w-[480px] text-[17px] leading-[1.45]" style={{ color: '#F2F2F4', textWrap: 'pretty' }}>
          {request.question}
        </div>
        {request.context ? (
          <div className="mt-2 max-w-[480px] text-[13px] leading-[1.5]" style={{ color: '#9A9AA2', textWrap: 'pretty' }}>
            {request.context}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-3.5">
        {/* WHAT YOU ARE BEING ASKED TO APPROVE.
            Found by using the product: an "Approve plan" gate arrived carrying only a title and two
            buttons. The plan was real — the unit had written it and said so — but the question was
            unanswerable without leaving for a terminal. A decision surface that cannot show its own
            subject is not a decision surface. */}
        <Subject unitId={request.unitId} unitHref={request.unitHref} question={request.question} />

        {request.findings && request.findings.length > 0 ? (
          <>
            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>
              WHAT {request.agentName.toUpperCase()} ALREADY WORKED OUT
            </div>
            <div className="mt-2.5 flex flex-col gap-[7px]">
              {request.findings.map((finding) => (
                <div key={finding} className="flex gap-2.5">
                  <div className="mt-1.5 h-[5px] w-[5px] flex-none rounded-full" style={{ background: '#3E5C8A' }} />
                  <div className="flex-1 text-[12.5px] leading-[1.5]" style={{ color: '#C9C9CF', textWrap: 'pretty' }}>{finding}</div>
                </div>
              ))}
            </div>
          </>
        ) : null}

        {/* Words FIRST, and bordered in ember: the primary answer, not the escape hatch. */}
        <div className="mt-[18px]" style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>ANSWER IN WORDS</div>
        <textarea
          ref={wordsRef}
          value={words}
          onChange={(event) => setWords(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && words.trim()) { event.preventDefault(); onAnswer(words.trim()); }
          }}
          placeholder={`Say it the way you'd say it out loud. ${request.agentName} reads it as instruction, not as a form.`}
          className="mt-2.5 min-h-[74px] w-full resize-none rounded-[3px] px-3 py-2.5 text-[13.5px] outline-none"
          style={{ border: '1px solid #F0A35A', background: '#0A0A0B', color: '#E8E8EA' }}
        />
        {words.trim() ? (
          <button
            type="button"
            onClick={() => onAnswer(words.trim())}
            className="mt-2 w-full rounded-[3px] px-3 py-2 text-left text-[12.5px]"
            style={{ background: '#F0A35A', color: '#0A0A0B' }}
          >
            Send this to {request.agentName} — she picks the work back up from where she stopped. ⌘↵
          </button>
        ) : null}

        {request.options && request.options.length > 0 ? (
          <div className="mb-5 mt-3.5 flex flex-col gap-2.5">
            {request.options.map((option) => (
              <button
                key={option.label}
                type="button"
                onClick={() => onAnswer(option.label)}
                className="flex items-start gap-3 rounded-[3px] px-3 py-2.5 text-left transition-colors"
                style={{ border: '1px solid #26262B' }}
              >
                <div className="flex-1">
                  <div className="text-[13px]" style={{ color: '#E8E8EA' }}>{option.label}</div>
                  {/* No control acts without saying what it does. */}
                  <div className="mt-1 text-[11.5px] leading-[1.45]" style={{ color: '#6A6A72' }}>{option.consequence}</div>
                </div>
                {option.preferred ? (
                  // Visible, never pre-selected: a recommendation you can see is advice, one that is
                  // already chosen for you is a decision someone else made.
                  <div className="flex-none" style={{ fontFamily: MONO, fontSize: 10, color: '#4A4A52' }}>she prefers this</div>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
