import React, { useEffect, useRef, useState } from 'react';
import { Mic, PhoneOff, X } from 'lucide-react';
import {
  bindingBannerText,
  estimateCallCostUsd,
  formatCallCost,
  formatElapsed,
  nextPttUiState,
  shouldForceReleaseForWatchdog,
  shouldShowPushNudge,
  voiceStateLabel,
  PUSH_NUDGE_TEXT,
  type CallHudPhase,
  type PttGestureEvent,
  type PttUiMode,
} from '../../lib/voice/callHud';
import { enablePush, pushPermission } from '../../lib/push';
import { useVoiceCall } from '../../context/VoiceCallContext';
import { useTaskContext } from '../../context/TaskContext';

/**
 * Floating in-call HUD (webapp-voice-lane concern 08, DESIGN.md "Session ownership" row) — rendered
 * from PROVIDER level in App.tsx (a sibling of `AppContent`, mirroring the existing Agent FAB's
 * "mounted outside every view-conditional" placement), so it survives the chat panel closing, a
 * view switch, even a session delete elsewhere in the app. `VoiceCallPillView` below is the
 * presentational half (props only, no context) — directly testable with `renderToStaticMarkup`
 * (this repo has no jsdom); `VoiceCallPill` is the thin context-reading container.
 */

export interface VoiceCallPillViewProps {
  bindingBanner: string;
  stateLabel: string;
  elapsedLabel: string;
  costLabel: string;
  reconnectNotice: string | null;
  /** Push-enable nudge (voice-loop concern 05): `true` only while the decision helper
   *  (`shouldShowPushNudge`) says so — `default` permission, not yet dismissed this call. */
  showPushNudge: boolean;
  onEnablePush: () => void;
  onDismissPushNudge: () => void;
  pttEngaged: boolean;
  /** MAJOR-1: the chat panel is docked to the right edge of the screen, and the composer sits at
   *  ITS bottom — the same rectangle a bottom-right `fixed` pill would otherwise sit on top of.
   *  `false` (panel closed) anchors the pill just above the Agent FAB (App.tsx, same bottom-right
   *  corner); `true` (panel open) anchors it near the TOP of the screen instead, which clears the
   *  composer unconditionally regardless of the composer's actual rendered height. */
  panelOpen: boolean;
  onPttDown: () => void;
  onPttUp: () => void;
  onPttLeave: () => void;
  /** HIGH-3: `pointercancel` (the browser itself aborting the gesture — a system dialog stealing
   *  focus, a touch gesture reinterpreted as a scroll, etc.) is a FORCED release, not a `'leave'` —
   *  it must end a `'locked'` engagement too, not just a `'holding'` one. */
  onPttCancel: () => void;
  onEndCall: () => void;
}

export const VoiceCallPillView = ({
  bindingBanner,
  stateLabel,
  elapsedLabel,
  costLabel,
  reconnectNotice,
  showPushNudge,
  onEnablePush,
  onDismissPushNudge,
  pttEngaged,
  panelOpen,
  onPttDown,
  onPttUp,
  onPttLeave,
  onPttCancel,
  onEndCall,
}: VoiceCallPillViewProps) => (
  <div
    className={`pill-rise fixed z-[55] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-2xl border border-gray-200 bg-white/95 p-3 shadow-xl backdrop-blur transition-colors dark:border-gray-800 dark:bg-gray-950/95 ${panelOpen ? 'top-16 right-4' : 'bottom-16 right-4'}`}
    role="status"
    aria-live="polite"
  >
    {reconnectNotice && (
      <div className="rounded-lg bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-700 dark:bg-amber-900/20 dark:text-amber-400" role="alert">
        {reconnectNotice}
      </div>
    )}
    {/* Push-enable nudge (voice-loop concern 05): styled like the reconnect banner above it — same
        amber "heads up" treatment — but interactive (an inline Enable action + a per-call dismiss),
        since unlike the reconnect notice this one asks for something rather than just reporting. */}
    {showPushNudge && (
      <div
        className="flex items-center justify-between gap-2 rounded-lg bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-700 dark:bg-amber-900/20 dark:text-amber-400"
        role="status"
      >
        <span className="truncate">{PUSH_NUDGE_TEXT}</span>
        <div className="flex flex-shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onEnablePush}
            className="rounded px-1.5 py-0.5 font-semibold text-amber-800 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-amber-300"
          >
            Enable
          </button>
          <button
            type="button"
            aria-label="Dismiss notification nudge"
            title="Dismiss"
            onClick={onDismissPushNudge}
            className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-amber-500 hover:text-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-amber-500 dark:hover:text-amber-300"
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        </div>
      </div>
    )}
    <div className="flex items-center justify-between gap-2">
      <span className="truncate text-[11px] font-medium text-gray-500 dark:text-gray-400" title={bindingBanner}>
        {bindingBanner}
      </span>
      <button
        type="button"
        aria-label="End voice call"
        title="End voice call"
        onClick={onEndCall}
        className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 dark:hover:bg-red-900/20 dark:hover:text-red-400 dark:focus-visible:ring-offset-gray-950"
      >
        <PhoneOff className="h-4 w-4" aria-hidden />
      </button>
    </div>

    {/* No caption line here — the spoken back-and-forth renders in the chat thread itself
        (AssistantChat: durable turn Messages + a live streaming bubble); this pill is purely the
        call CONTROLS (PTT, end, state, meter). */}
    <div className="flex items-center justify-between gap-3">
      <button
        type="button"
        aria-label="Push to talk — hold to speak, or tap to lock recording on"
        title="Hold to talk, or tap to lock recording on"
        onPointerDown={onPttDown}
        onPointerUp={onPttUp}
        onPointerLeave={onPttLeave}
        onPointerCancel={onPttCancel}
        className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-950 active:scale-[0.99] ${
          pttEngaged
            ? 'bg-amber-500 text-white'
            : 'bg-gray-900 text-white hover:bg-black dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-white'
        }`}
      >
        <Mic className="h-4 w-4" aria-hidden />
      </button>
      <div className="flex flex-1 flex-col items-end text-right">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{stateLabel}</span>
        <span className="text-[11px] text-gray-400 dark:text-gray-500">
          {elapsedLabel} · {costLabel}
        </span>
      </div>
    </div>
  </div>
);

/** HIGH-3: how often the PTT watchdog checks how long the current engagement has run. Cheap and
 *  coarse on purpose — this only needs to catch a stuck-open mic within a few seconds of the
 *  60s cap, not react instantly. */
const PTT_WATCHDOG_POLL_MS = 5_000;

export const VoiceCallPill = () => {
  const call = useVoiceCall();
  const { isChatOpen } = useTaskContext();
  const [pttMode, setPttMode] = useState<PttUiMode>('idle');
  const pressedAtRef = useRef(0);
  // Push-enable nudge (voice-loop concern 05): permission is read once at mount (this pill is
  // mounted once at provider level, see the header comment, and just renders null between calls)
  // and refreshed on every call-start edge plus after `enablePush()` resolves. `pushNudgeDismissed`
  // is per-call — reset on the SAME edge — so a dismiss on one call never suppresses the nudge on
  // the next.
  const [pushPerm, setPushPerm] = useState<'default' | 'granted' | 'denied' | 'unsupported'>(() => pushPermission());
  const [pushNudgeDismissed, setPushNudgeDismissed] = useState(false);

  useEffect(() => {
    if (!call.isCallActive) return;
    setPushPerm(pushPermission());
    setPushNudgeDismissed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-armed only on the isCallActive rising edge, not on every binding update (e.g. mid-call agentId rebinding)
  }, [call.isCallActive]);

  const handleEnablePush = () => {
    // enablePush() itself requires a user gesture (browsers reject Notification.requestPermission
    // otherwise) — this handler IS that gesture, wired straight to the button's onClick. Re-read
    // permission from the source of truth after it resolves rather than trusting its return value
    // directly, so this stays correct even if a future call site of pushPermission() diverges.
    void enablePush().then(() => setPushPerm(pushPermission()));
  };
  const handleDismissPushNudge = () => setPushNudgeDismissed(true);

  const applyGesture = (event: PttGestureEvent, holdMs: number) => {
    const result = nextPttUiState(pttMode, event, holdMs);
    setPttMode(result.mode);
    if (result.action === 'press') call.pttPress();
    if (result.action === 'release') call.pttRelease();
    if (result.action === 'abort') call.pttAbort(); // empty-turn rule (callHud.ts): discard, don't send
  };

  const handleDown = () => {
    // MINOR-6: no mic stream exists yet during 'connecting' — a press here would have nothing to
    // start recording, and would desync pttMode from the (still idle) VoiceSession state machine.
    if (call.phase === 'connecting') return;
    // Measure the CURRENT engagement's length before restarting the clock — a 'down' landing on
    // 'locked' is the engagement-ending second tap, and the gesture machine needs its true length
    // to tell a double-click (abort) from a deliberate toggle-off (release).
    const heldMs = Date.now() - pressedAtRef.current;
    pressedAtRef.current = Date.now();
    applyGesture('down', heldMs);
  };
  const handleUp = () => applyGesture('up', Date.now() - pressedAtRef.current);
  const handleLeave = () => applyGesture('leave', Date.now() - pressedAtRef.current);
  // HIGH-3: pointercancel, window blur, and document visibilitychange all mean "the operator has
  // stopped interacting with this — force a release, don't leave a lock engaged with nobody
  // watching the HUD".
  const handleForceRelease = () => applyGesture('forceRelease', Date.now() - pressedAtRef.current);

  // HIGH-3: window blur / tab hidden — a hot mic must not survive the operator tabbing away.
  // Re-registered whenever `pttMode` changes so the listener's closure never reads a stale mode
  // (the churn rate here is "once per press/release", not a hot loop).
  useEffect(() => {
    const onBlur = () => handleForceRelease();
    const onVisibilityChange = () => {
      if (document.hidden) handleForceRelease();
    };
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-armed only on pttMode change
  }, [pttMode]);

  // HIGH-3: the watchdog backstop — if engagement (holding or locked) somehow outlives every other
  // release signal, force it closed rather than hold the mic open indefinitely.
  useEffect(() => {
    if (pttMode === 'idle') return;
    const id = setInterval(() => {
      // Review finding: the watchdog ABORTS (discards) rather than committing — see
      // callHud.ts's 'watchdogExpire' doc comment (a forgotten lock must not transmit a minute of
      // ambient room audio and provoke an unprompted reply).
      if (shouldForceReleaseForWatchdog(pttMode, Date.now() - pressedAtRef.current)) applyGesture('watchdogExpire', Date.now() - pressedAtRef.current);
    }, PTT_WATCHDOG_POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-armed only on pttMode change
  }, [pttMode]);

  // Review finding: the pill instance lives at provider level and merely renders null between
  // calls — a call ended while tap-locked would otherwise leak pttMode 'locked' into the NEXT
  // call (engaged-looking button over a muted mic; the first press consumed as a phantom
  // release). Reset the gesture state whenever no call is active.
  useEffect(() => {
    if (!call.isCallActive) setPttMode('idle');
  }, [call.isCallActive]);

  if (!call.isCallActive || !call.binding) return null;

  const phase: CallHudPhase = call.phase;

  return (
    <VoiceCallPillView
      bindingBanner={bindingBannerText(call.binding.sessionTitle)}
      stateLabel={voiceStateLabel(phase)}
      elapsedLabel={formatElapsed(call.elapsedMs)}
      costLabel={formatCallCost(estimateCallCostUsd(call.elapsedMs))}
      reconnectNotice={call.reconnectNotice}
      showPushNudge={shouldShowPushNudge(pushPerm, pushNudgeDismissed)}
      onEnablePush={handleEnablePush}
      onDismissPushNudge={handleDismissPushNudge}
      pttEngaged={pttMode !== 'idle'}
      panelOpen={isChatOpen}
      onPttDown={handleDown}
      onPttUp={handleUp}
      onPttLeave={handleLeave}
      onPttCancel={handleForceRelease}
      onEndCall={call.endCall}
    />
  );
};
