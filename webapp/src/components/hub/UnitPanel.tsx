import React from 'react';
import type { AgentDTO } from '../../lib/dto';
import { duration } from '../../lib/roomState';

/**
 * UnitPanel — standing inside one piece of work.
 *
 * Replaces the old workbench agent view, which was four columns of a different application: a FLEET
 * roster, a transcript, and a LAND / CHANGES / RUN stack whose headings named the machinery rather
 * than anything a person wants to know. `01-room.html`'s decision screen names the three questions
 * instead:
 *
 * - **THIS UNIT** — what it has been doing, in a sentence, and what it is missing.
 * - **WHAT THE CHECKS SAY** — the verdict, not the fact that checks ran.
 * - **WHAT CHANGES IN THE PRODUCT** — the diff described as behaviour, with the files as a footnote.
 *
 * That last one is the whole difference. "4 files changed" is true and tells a person nothing; "a
 * caller that fails repeatedly now gets refused for thirty seconds instead of retrying forever" is
 * what they are actually deciding about. The file list stays, underneath, in the size a footnote gets.
 */

const MONO = "'JetBrains Mono',ui-monospace,monospace";

export interface UnitCheck {
  name: string;
  detail: string;
  state: 'pass' | 'fail' | 'running' | 'unknown';
}

const CHECK_DOT: Record<UnitCheck['state'], string> = {
  pass: '#3E7D57',
  fail: '#B4553A',
  running: '#F0A35A',
  unknown: '#4A4A52',
};

/** What this unit has been doing, and what it is waiting on — in one sentence. */
export function thisUnitSentence(agent: AgentDTO, now: number): string {
  const name = agent.name || agent.id;
  const worked = agent.startedAt ? duration(now - agent.startedAt) : undefined;
  const been = worked ? `${name} has been on this for ${worked}.` : `${name} picked this up.`;
  if ((agent.pending?.length ?? 0) > 0) {
    return `${been} The work is written; the only thing missing is your answer.`;
  }
  if (agent.status === 'error') {
    return `${been} It stopped in a way it did not choose${agent.error ? ` — ${agent.error}` : ''}.`;
  }
  if (agent.landReady) return `${been} It is ready to land and nothing is waiting on you until you say so.`;
  if (agent.status === 'stopped') return `${been} It has stopped and is off the working surface.`;
  return `${been} Nothing is waiting on you for this.`;
}

/** The checks, read as verdicts. A check that has not run says so rather than reading as a pass. */
export function unitChecks(agent: AgentDTO): UnitCheck[] {
  const out: UnitCheck[] = [];
  // The real vocabulary is "unknown" | "none" | "failed" | "stale" | "fresh" — and the distinction
  // that matters most is that STALE is not a pass. Evidence that was green against a different main
  // is evidence about a different repository.
  const verification = agent.verificationState;
  out.push(
    verification === 'fresh'
      ? { name: 'verification', detail: 'green', state: 'pass' }
      : verification === 'failed'
        ? { name: 'verification', detail: 'failed', state: 'fail' }
        : verification === 'stale'
          ? { name: 'verification', detail: 'green, but against an older main', state: 'unknown' }
          : { name: 'verification', detail: 'has not run', state: 'unknown' },
  );
  if (agent.validation) {
    const verdict = String((agent.validation as { verdict?: unknown }).verdict ?? 'unknown');
    out.push({ name: 'review', detail: verdict, state: verdict === 'pass' ? 'pass' : verdict === 'fail' || verdict === 'veto' ? 'fail' : 'unknown' });
  }
  out.push(
    agent.landReady
      ? { name: 'ready to land', detail: 'yes', state: 'pass' }
      : { name: 'ready to land', detail: agent.blockedReason ? String(agent.blockedReason) : 'not yet', state: agent.blockedReason ? 'fail' : 'unknown' },
  );
  if (agent.prState) out.push({ name: 'pull request', detail: agent.prState, state: agent.prState === 'merged' ? 'pass' : 'unknown' });
  return out;
}

export function UnitPanel({ agent, now, onClose }: { agent: AgentDTO; now: number; onClose?: () => void }) {
  const checks = unitChecks(agent);
  const goal = agent.issue?.name;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto" style={{ background: '#0A0A0B', color: '#E8E8EA' }}>
      <div className="flex items-baseline gap-3 px-5 pb-2 pt-4">
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.16em', color: '#5A5A61' }}>THIS UNIT</div>
        <div className="flex-1" />
        {onClose ? (
          <button type="button" onClick={onClose} style={{ fontFamily: MONO, fontSize: 10, color: '#5A5A61' }} title="Close this and bring the tree back.">esc closes</button>
        ) : null}
      </div>

      <div className="px-5 text-[12.5px] leading-[1.55]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>
        {thisUnitSentence(agent, now)}
      </div>
      {goal ? (
        <div className="mt-2 px-5 text-[12.5px] leading-[1.5]" style={{ color: '#C9C9CF', textWrap: 'pretty' }}>“{goal}”</div>
      ) : null}

      <div className="mt-5 flex" style={{ borderTop: '1px solid #1F1F22', borderBottom: '1px solid #1F1F22' }}>
        <div className="flex-1 px-4 py-3" style={{ borderRight: '1px solid #1F1F22' }}>
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>WHAT THE CHECKS SAY</div>
          <div className="mt-2.5 flex flex-col gap-[7px]">
            {checks.map((check) => (
              <div key={check.name} className="flex items-center gap-2.5">
                <div className="h-[5px] w-[5px] flex-none rounded-full" style={{ background: CHECK_DOT[check.state] }} />
                <div className="flex-1 text-[12.5px]" style={{ color: '#C9C9CF' }}>{check.name}</div>
                <div style={{ fontFamily: MONO, fontSize: 10.5, color: check.state === 'fail' ? '#C2704A' : check.state === 'pass' ? '#6F9E85' : '#5A5A61' }}>
                  {check.detail}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2.5 text-[12px] leading-[1.5]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>
            A check that has not run is shown as not run. It is not a pass, and reading it as one is how a unit lands on
            nobody's evidence.
          </div>
        </div>

        <div className="w-[270px] flex-none px-4 py-3">
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>WHAT CHANGES IN THE PRODUCT</div>
          {/* Behaviour first, files as a footnote. "4 files changed" is true and tells a person
              nothing about what they are deciding. */}
          <div className="mt-2.5 text-[12.5px] leading-[1.5]" style={{ color: '#C9C9CF', textWrap: 'pretty' }}>
            {/* There is no product-change sentence on the DTO. Saying so is the honest rendering —
                inventing one from the branch name would be the machine putting words in someone's
                mouth about what their change does. */}
            {'Nobody has written down what this changes for anyone using the product yet — the diff exists, the sentence does not.'}
          </div>
          <div className="mt-2.5" style={{ fontFamily: MONO, fontSize: 10, color: '#4A4A52', lineHeight: 1.7 }}>
            <div>{agent.repo?.split('/').pop() ?? 'this repo'} · {agent.branch ?? 'no branch yet'}</div>
            {agent.prUrl ? <div>{agent.prState ?? 'open'} · #{agent.prNumber}</div> : null}
          </div>
        </div>
      </div>

      <div className="flex-1" />
      <div className="px-5 py-3" style={{ borderTop: '1px solid #1F1F22', fontFamily: MONO, fontSize: 10, color: '#4A4A52', lineHeight: 1.7 }}>
        <div>model&nbsp;&nbsp;<span style={{ color: '#8A8A91' }}>{agent.model || 'default'}</span></div>
        {agent.contextPct !== undefined ? (
          <div>context&nbsp;&nbsp;<span style={{ color: agent.contextPct > 85 ? '#D9A03C' : '#8A8A91' }}>{Math.round(agent.contextPct)}% used</span></div>
        ) : null}
      </div>
    </div>
  );
}
