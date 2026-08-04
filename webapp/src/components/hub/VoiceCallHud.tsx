import React from 'react';
import { Loader2, Mic, MicOff, PhoneCall, PhoneOff, RefreshCw } from 'lucide-react';
import {
  IDLE_HANGUP_MS,
  PHASE_LABEL,
  PHASE_LABEL_CH,
  S2S_OUTSIDE_ROOMS_NOTE,
  bindingBanner,
  browserAudioStatusLine,
  callPhase,
  idlePolicyLine,
  phaseExplanation,
  retentionNotice,
  type BrowserAudioMicStatus,
  type BrowserAudioRelayStatus,
  type CallPhase,
} from '../../lib/voice/roomCall';
import type { VoiceCallBindingDTO } from '../../lib/api';

/**
 * VoiceCallHud — the room's call entry and, once a call is up, its controls.
 *
 * This REPLACES the thread's old call entry (the Composer's `VoiceCallButton`, which starts the
 * provider-direct S2S dispatcher lane). Concern 05's recorded decision is that a room uses the
 * OMP-live lane exclusively and the dispatcher stays available outside rooms — so inside a room
 * there is exactly one call affordance, and it is this one.
 *
 * Three things it does that the dispatcher HUD does not:
 *
 * 1. **Open mic, not push-to-talk.** `VoiceCallPill`'s whole gesture machine — hold, tap-lock, the
 *    60-second watchdog — exists because that lane records a turn at a time. This lane is a call:
 *    the mic is open and the visible control is MUTE. What survives from the pill is the shape a
 *    call HUD needs: a binding banner, a single-flight start, and a session-pinned identity.
 * 2. **Fixed-size phase chrome.** The phase box reserves the widest label's width and the layout
 *    keeps a constant row count, so connecting → live → degraded → ended never reflows the controls
 *    out from under the pointer.
 * 3. **The recording state is visible at call start**, including the case where the session reports
 *    a different mode than the room asked for. See `retentionNotice`.
 *
 * Presentational half first (props only), so it is directly testable with `renderToStaticMarkup` —
 * the same split every other tested component in this package uses.
 */

const MONO = "'JetBrains Mono',ui-monospace,monospace";

/** Phase → the 2px rule colour. Same vocabulary as the timeline's own tone rules. `checking` reads
 *  as a quieter cousin of `connecting` — a real thing may be happening, the room just does not know
 *  yet, which is a different (less certain) fact than "dialling out". */
const PHASE_RULE: Record<CallPhase, string> = {
  none: '#2A2A30',
  checking: '#33333A',
  connecting: '#3E5C8A',
  live: '#3E7D57',
  degraded: '#D9A03C',
  ended: '#2A2A30',
};

export interface VoiceCallHudViewProps {
  binding: VoiceCallBindingDTO | null;
  /** `true` only until the FIRST binding read resolves after mount — see `callPhase`'s doc for why
   *  this must gate the phase/start-offer, not just a spinner: without it, a page refresh mid-call
   *  briefly rendered as "no call", inviting a race against the daemon's own single-active-call
   *  guard instead of showing the real (possibly live) binding a beat later. */
  loading: boolean;
  /** Single-flight: a start already in flight, so the button cannot be pressed twice. */
  starting: boolean;
  ending: boolean;
  /** Concern 10: a user-triggered reconnect, offered only for a `degraded` call — see
   *  `VoiceCallCoordinator#reattach`'s doc for what it actually does server-side. */
  reattaching?: boolean;
  onReattach?: () => void;
  /** What the daemon has last been ASKED to do with the mic — never a confirmed mic state. */
  muted: boolean;
  muteBusy: boolean;
  /** `false` while there is no live socket: the controls say so instead of pretending. */
  controlsAvailable: boolean;
  /** Last human or agent activity, for the idle line. */
  lastActivityAt?: number;
  now: number;
  /** Set when the last start attempt failed — shown in place, never as a toast that vanishes. */
  error?: string;
  /**
   * `false` on a surface where starting a call is not the offer — a unit's own conversation, which
   * already has its own panel and its own vocabulary. A call BOUND to such a thread still renders in
   * full (hiding a live call would be the worse lie); only the invitation to start one is withheld.
   */
  canStart?: boolean;
  /**
   * Concern 09 (browser-audio-transport): `useRoomCallAudio`'s own state, when this call is
   * audio-less. Additive and optional — a caller that never passes it (or whose call is
   * device-audio, `relayStatus: 'idle'`) renders exactly as before this concern existed; see
   * `browserAudioStatusLine` for why `undefined` in that shape draws nothing at all.
   */
  browserAudio?: { micStatus: BrowserAudioMicStatus; relayStatus: BrowserAudioRelayStatus; error?: string; onRetry: () => void };
  onStart: () => void;
  onEnd: () => void;
  onToggleMute: () => void;
}

function PhaseBox({ phase }: { phase: CallPhase }) {
  return (
    <div
      className="flex-none text-center"
      // The reserved width is what makes this chrome fixed-size: every phase word occupies the
      // widest word's box, so nothing beside it moves when the phase changes.
      style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', textTransform: 'uppercase', color: PHASE_RULE[phase], minWidth: `${PHASE_LABEL_CH}ch` }}
    >
      {PHASE_LABEL[phase]}
    </div>
  );
}

export function VoiceCallHudView({
  binding,
  loading,
  starting,
  ending,
  reattaching = false,
  onReattach,
  muted,
  muteBusy,
  controlsAvailable,
  lastActivityAt,
  now,
  error,
  canStart = true,
  browserAudio,
  onStart,
  onEnd,
  onToggleMute,
}: VoiceCallHudViewProps) {
  const phase: CallPhase = callPhase(binding, loading);
  const active = binding !== null && binding.state !== 'ended';
  const retention = binding ? retentionNotice(binding) : undefined;
  const banner = bindingBanner(binding);
  const audioLine = browserAudio ? browserAudioStatusLine(browserAudio) : undefined;

  return (
    <section
      className="flex-none"
      // Marks the whole call subtree for the reduced-motion rule in index.css — the spinner, the
      // colour transitions and the active-state scale all stop for a reader who asked them to.
      data-room-workspace=""
      style={{ borderBottom: '1px solid #1F1F22', background: '#0A0A0B', borderLeft: `2px solid ${PHASE_RULE[phase]}` }}
      aria-label="Call"
    >
      <div className="flex items-start gap-3 px-4 py-2.5">
        <PhaseBox phase={phase} />

        <div className="min-w-0 flex-1">
          {/* Row one is the same height in every phase: one sentence, no wrapping chrome. */}
          <p className="text-[12.5px] leading-[1.5]" style={{ color: '#C9C9CF', textWrap: 'pretty' }}>
            {phaseExplanation(binding, loading)}
          </p>

          {retention ? (
            <p
              className="mt-1 text-[11.5px] leading-[1.5]"
              style={{ color: retention.mismatch ? '#D9A03C' : '#8A8A91', textWrap: 'pretty' }}
              // The mismatch is an alert, not decoration: a room claiming to record in full over a
              // session journaling tails is the invisible privacy expansion DESIGN.md forbids.
              role={retention.mismatch ? 'alert' : undefined}
            >
              <span style={{ fontFamily: MONO, letterSpacing: '.08em', textTransform: 'uppercase', fontSize: 10 }}>{retention.label}</span>
              {' — '}
              {retention.detail}
            </p>
          ) : null}

          {active ? (
            <p className="mt-1 text-[11.5px] leading-[1.5]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>
              {idlePolicyLine(lastActivityAt, now)}
            </p>
          ) : (
            <p className="mt-1 text-[11.5px] leading-[1.5]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>
              {S2S_OUTSIDE_ROOMS_NOTE}
            </p>
          )}

          {/* The binding banner: which call, and which session is PINNED to it. After a reload this
              is what proves the call on screen is the call that was started, rather than a stranger
              that inherited the port — the `port-reused` case the daemon refuses to adopt. */}
          {banner ? (
            <p className="mt-1 truncate" style={{ fontFamily: MONO, fontSize: 10, color: '#4A4A52' }} title={banner}>
              {banner}
            </p>
          ) : null}

          {/* Concern 09: the browser's own mic/speaker relay state — only rendered for an audio-less
              call (`browserAudioStatusLine` returns undefined for a device-audio one, or once the
              mic is fully connected with nothing left to report). */}
          {audioLine ? (
            <p
              className="mt-1 text-[11.5px] leading-[1.5]"
              style={{ color: audioLine.tone === 'error' ? '#D9A03C' : '#6A6A72', textWrap: 'pretty' }}
              role={audioLine.tone === 'error' ? 'alert' : undefined}
            >
              {audioLine.text}
              {audioLine.showRetry ? (
                <button
                  type="button"
                  onClick={browserAudio?.onRetry}
                  className="ml-1.5 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
                  style={{ color: '#F0A35A' }}
                >
                  Retry
                </button>
              ) : null}
            </p>
          ) : null}

          {error ? (
            <p className="mt-1.5 text-[12px] leading-[1.5]" style={{ color: '#C2704A', textWrap: 'pretty' }} role="alert">
              {error}
            </p>
          ) : null}
        </div>

        {/* Controls keep a constant footprint too — the mute/end pair replaces the start button in
            the same box, so the row never grows or shrinks between phases. */}
        <div className="flex flex-none items-center gap-2">
          {active ? (
            <>
              {/* Concern 10: reattach is offered ONLY for a `degraded` call — the case where a real
                  reconnect might actually succeed. Live already has a working bridge; connecting is
                  already mid-flow; ended is terminal — none of those need (or make sense for) this
                  button, so it stays out of the DOM rather than rendering disabled-forever. */}
              {phase === 'degraded' && onReattach ? (
                <button
                  type="button"
                  onClick={onReattach}
                  disabled={reattaching}
                  aria-label="Reattach to the call"
                  title="Ask the daemon to reconnect to this call right now, instead of waiting for the automatic check."
                  className="flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-[3px] px-2.5 text-[12px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ border: '1px solid #4A3319', color: '#D9A03C' }}
                >
                  {reattaching ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
                  <span>Reattach</span>
                </button>
              ) : null}
              <button
                type="button"
                onClick={onToggleMute}
                disabled={!controlsAvailable || muteBusy}
                aria-pressed={muted}
                aria-label={muted ? 'Unmute the microphone' : 'Mute the microphone'}
                title={
                  controlsAvailable
                    ? muted
                      ? 'Unmute. The room asked the session to mute; the protocol gives no read-back, so this is what was asked for, not a confirmed mic state.'
                      : 'Mute. The room asks the session to mute — there is no read-back, so this records what was asked.'
                    : 'There is no live socket to the session right now, so the mic cannot be changed.'
                }
                className="flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-[3px] px-2.5 text-[12px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                style={{ border: `1px solid ${muted ? '#4A3319' : '#26262B'}`, background: muted ? '#1A140C' : 'transparent', color: muted ? '#D9A03C' : '#C9C9CF' }}
              >
                {muted ? <MicOff className="h-4 w-4" aria-hidden /> : <Mic className="h-4 w-4" aria-hidden />}
                <span>{muted ? 'Muted' : 'Mute'}</span>
              </button>
              <button
                type="button"
                onClick={onEnd}
                disabled={ending}
                aria-label="End the call"
                title="End the call. The record stays in this thread."
                className="flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-[3px] px-2.5 text-[12px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                style={{ border: '1px solid #3A2320', color: '#C58A7E' }}
              >
                {ending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <PhoneOff className="h-4 w-4" aria-hidden />}
                <span>End</span>
              </button>
            </>
          ) : phase === 'checking' ? (
            // The room does not know yet whether this thread already has a call — see `callPhase`'s
            // doc. Offering "Start a call" here is exactly the refresh-rehydration defect (concern
            // 10): a click would race the daemon's own single-active-call guard the instant the real
            // (possibly live) binding arrives a beat later. Nothing renders in this slot until the
            // first read resolves one way or the other.
            <Loader2 className="h-4 w-4 flex-none animate-spin" style={{ color: '#4A4A52' }} aria-hidden />
          ) : canStart ? (
            <button
              type="button"
              onClick={onStart}
              disabled={starting}
              aria-label="Start a call in this thread"
              title="Start a live call. The mic stays open; the conversation, decisions and artifacts all land in this thread."
              className="flex h-10 items-center justify-center gap-1.5 rounded-[3px] px-3 text-[12px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 active:scale-[0.99]"
              style={{ background: '#F0A35A', color: '#140D06' }}
            >
              {starting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <PhoneCall className="h-4 w-4" aria-hidden />}
              <span>{starting ? 'Starting…' : binding ? 'Start another call' : 'Start a call'}</span>
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** Elapsed-time helper the container uses for the idle line's clock. Exported for the HUD's tests:
 *  the boundary between "quiet" and "about to hang up" is a product decision, not a render detail. */
export function callIsIdleCritical(lastActivityAt: number | undefined, now: number): boolean {
  return lastActivityAt !== undefined && now - lastActivityAt >= IDLE_HANGUP_MS - 60_000;
}
