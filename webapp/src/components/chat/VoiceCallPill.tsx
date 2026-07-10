import React, { useRef, useState } from 'react';
import { Mic, PhoneOff } from 'lucide-react';
import {
  bindingBannerText,
  estimateCallCostUsd,
  formatCallCost,
  formatElapsed,
  nextPttUiState,
  voiceStateLabel,
  type CaptionState,
  type CallHudPhase,
  type PttGestureEvent,
  type PttUiMode,
} from '../../lib/voice/callHud';
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
  captionSpeaker: 'assistant' | 'user' | null;
  captionText: string;
  elapsedLabel: string;
  costLabel: string;
  reconnectNotice: string | null;
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
  onEndCall: () => void;
}

export const VoiceCallPillView = ({
  bindingBanner,
  stateLabel,
  captionSpeaker,
  captionText,
  elapsedLabel,
  costLabel,
  reconnectNotice,
  pttEngaged,
  panelOpen,
  onPttDown,
  onPttUp,
  onPttLeave,
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

    {captionText && (
      <p className="line-clamp-2 text-xs text-gray-700 dark:text-gray-300">
        <span className="font-medium text-gray-500 dark:text-gray-400">{captionSpeaker === 'user' ? 'You: ' : 'Agent: '}</span>
        {captionText}
      </p>
    )}

    <div className="flex items-center justify-between gap-3">
      <button
        type="button"
        aria-label="Push to talk — hold to speak, or tap to lock recording on"
        title="Hold to talk, or tap to lock recording on"
        onPointerDown={onPttDown}
        onPointerUp={onPttUp}
        onPointerLeave={onPttLeave}
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

export const VoiceCallPill = () => {
  const call = useVoiceCall();
  const { isChatOpen } = useTaskContext();
  const [pttMode, setPttMode] = useState<PttUiMode>('idle');
  const pressedAtRef = useRef(0);

  if (!call.isCallActive || !call.binding) return null;

  const applyGesture = (event: PttGestureEvent, holdMs: number) => {
    const result = nextPttUiState(pttMode, event, holdMs);
    setPttMode(result.mode);
    if (result.action === 'press') call.pttPress();
    if (result.action === 'release') call.pttRelease();
  };

  const handleDown = () => {
    // MINOR-6: no mic stream exists yet during 'connecting' — a press here would have nothing to
    // start recording, and would desync pttMode from the (still idle) VoiceSession state machine.
    if (call.phase === 'connecting') return;
    pressedAtRef.current = Date.now();
    applyGesture('down', 0);
  };
  const handleUp = () => applyGesture('up', Date.now() - pressedAtRef.current);
  const handleLeave = () => applyGesture('leave', Date.now() - pressedAtRef.current);

  const phase: CallHudPhase = call.phase;
  const caption: CaptionState | null = call.caption;

  return (
    <VoiceCallPillView
      bindingBanner={bindingBannerText(call.binding.sessionTitle)}
      stateLabel={voiceStateLabel(phase)}
      captionSpeaker={caption?.speaker ?? null}
      captionText={caption?.text ?? ''}
      elapsedLabel={formatElapsed(call.elapsedMs)}
      costLabel={formatCallCost(estimateCallCostUsd(call.elapsedMs))}
      reconnectNotice={call.reconnectNotice}
      pttEngaged={pttMode !== 'idle'}
      panelOpen={isChatOpen}
      onPttDown={handleDown}
      onPttUp={handleUp}
      onPttLeave={handleLeave}
      onEndCall={call.endCall}
    />
  );
};
