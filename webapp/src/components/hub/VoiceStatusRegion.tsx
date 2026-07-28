import React from 'react';
import type { ThreadStatus } from '../../lib/voice/roomCall';

/**
 * VoiceStatusRegion — one line that says what this thread's state actually is.
 *
 * `threadStatus` picks exactly one of no call / all clear / active agents / open decisions / review
 * queue / degraded / ended unexpectedly, by strict precedence. This renders that one, plus the
 * attention chip and the polite live region that goes with it.
 *
 * The live region is `aria-live="polite"` and nothing else: a decision arriving while someone is
 * mid-sentence in the composer announces itself and does NOT take the caret, scroll the view, or
 * open a panel. Focus theft is the failure mode a room like this earns fastest.
 */

const MONO = "'JetBrains Mono',ui-monospace,monospace";

const TONE_RULE: Record<ThreadStatus['tone'], string> = {
  neutral: '#2A2A30',
  info: '#3E5C8A',
  warning: '#D9A03C',
  success: '#3E7D57',
  destructive: '#A6483C',
};

const TONE_INK: Record<ThreadStatus['tone'], string> = {
  neutral: '#8A8A91',
  info: '#9AB0C6',
  warning: '#D9A03C',
  success: '#7FB093',
  destructive: '#C58A7E',
};

export interface VoiceStatusRegionProps {
  status: ThreadStatus;
  /** Short chip text, or `undefined` when nothing is waiting. */
  chipLabel?: string;
  /** What the polite region should say right now. `undefined` renders it empty rather than
   *  repeating the last announcement. */
  announcement?: string;
  /** Opens the decision door. Only rendered when there is something to open. */
  onOpenDecisions?: () => void;
  onOpenArtifacts?: () => void;
  artifactCount: number;
  /** Concern 10 (call-management-ui): opens the cross-room calls surface. Unlike the two buttons
   *  above, this is never gated on the CURRENT room having a call — the whole point of that surface
   *  is seeing calls (and broker orphans) this room's own state cannot show at all. */
  onOpenCalls?: () => void;
}

export function VoiceStatusRegion({ status, chipLabel, announcement, onOpenDecisions, onOpenArtifacts, artifactCount, onOpenCalls }: VoiceStatusRegionProps) {
  return (
    <div
      className="flex-none"
      data-room-workspace=""
      style={{ borderBottom: '1px solid #1F1F22', background: '#0A0A0B', borderLeft: `2px solid ${TONE_RULE[status.tone]}` }}
    >
      {/* The announcement lives in its own always-present region: a live region added to the DOM at
          the same moment its text appears is frequently missed by screen readers, so the container
          is mounted for the life of the room and only its text changes. */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement ?? ''}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <span className="text-[12.5px] font-semibold" style={{ color: TONE_INK[status.tone] }}>{status.headline}</span>
          {status.detail ? (
            <span className="min-w-0 text-[12px] leading-[1.5]" style={{ color: '#7A7A82', textWrap: 'pretty' }}>{status.detail}</span>
          ) : null}
        </div>

        <div className="flex flex-none items-center gap-2">
          {chipLabel && onOpenDecisions ? (
            <button
              type="button"
              onClick={onOpenDecisions}
              className="inline-flex min-h-10 items-center rounded-full px-3 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2"
              style={{ border: '1px solid #4A3319', background: '#161211', color: '#D9A03C', fontFamily: MONO, letterSpacing: '.06em' }}
              title="Open the question. It has been waiting here, not interrupting you."
            >
              {chipLabel}
            </button>
          ) : null}
          {onOpenArtifacts ? (
            <button
              type="button"
              onClick={onOpenArtifacts}
              className="inline-flex min-h-10 items-center rounded-full px-3 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2"
              style={{ border: '1px solid #26262B', color: '#8A8A91', fontFamily: MONO, letterSpacing: '.06em' }}
              title="What this run produced."
            >
              {artifactCount === 0 ? 'artifacts' : `artifacts · ${artifactCount}`}
            </button>
          ) : null}
          {onOpenCalls ? (
            <button
              type="button"
              onClick={onOpenCalls}
              className="inline-flex min-h-10 items-center rounded-full px-3 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2"
              style={{ border: '1px solid #26262B', color: '#8A8A91', fontFamily: MONO, letterSpacing: '.06em' }}
              title="Every call this account can see across every room, plus any orphaned broker process — see, end, or reattach without curl."
            >
              calls
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
