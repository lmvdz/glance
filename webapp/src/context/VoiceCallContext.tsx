import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { getVoiceConfig, mintVoiceToken } from '../lib/api';
import createVoiceSession, { type VoiceSession, type VoiceSessionErrorInfo, type VoiceState } from '../lib/voice/voiceSession';
import {
  appendCaption,
  errorToastMessage,
  reconnectNoticeText,
  shouldEndCall,
  shouldEndCallForIdle,
  shouldEndCallForMaxDuration,
  type CaptionState,
} from '../lib/voice/callHud';
import { useVoiceDispatcher } from '../hooks/useVoiceDispatcher';
import { appendSpokenSummary, appendSpokenUserMessage, bindSessionAgent, loadPersistedSessionsOrNull, subscribeSessionStore } from '../lib/chat/sessionStore';
import { useTaskContext } from './TaskContext';

/**
 * Live voice call, owned ABOVE the chat panel (webapp-voice-lane concern 08, DESIGN.md "Session
 * ownership" row). `AssistantChat` unmounts on Back/close/session-delete (App.tsx's
 * `isChatOpen` toggle) — a `VoiceSession` constructed inside it would die the moment the operator
 * closed the panel, which is exactly the failure this concern exists to prevent. So the
 * `VoiceSession` + `useVoiceDispatcher` wiring live here instead, mounted once at App.tsx (beside
 * `TaskProvider`, sibling to `AppContent`) and never torn down by navigation — only by
 * `endCall()` or an unrecoverable error.
 *
 * `useVoiceDispatcher` (concern 07) is called unconditionally on every render (Rules of Hooks);
 * its `sessionId`/`agentId` inputs fall back to `''`/`undefined` when no call is pinned, which is
 * inert — the hook only does anything once `registerSession` has actually been handed a live
 * `VoiceSession`.
 */

export interface VoiceCallBinding {
  /** The `AssistantChat` `Session.id` this call is pinned to at start — `useVoiceDispatcher`'s
   *  single-flight key, and the durable-message target for `onSpokenSummary`. */
  sessionId: string;
  /** Display-only — the pill's "voice → <title>" banner. Captured at call start, never re-read
   *  live from the session store (a title rename mid-call is not worth reacting to). */
  sessionTitle: string;
  /** The console agent already bound to this chat thread, if any — absent means "mint one on the
   *  first prompt_agent" (useVoiceDispatcher's bootstrap path). Updated in place as the dispatcher
   *  (re)binds (see `onAgentBound` below). */
  agentId?: string;
}

export interface VoiceCallContextValue {
  /** `GET /api/voice/config` capability probe result — gates whether `VoiceCallButton` renders at
   *  all (DESIGN.md "Flagging" row: "no button that 404s"). `undefined` while the probe is still in
   *  flight — treated as `false` (hidden) by callers until it resolves. */
  voiceEnabled: boolean;
  isCallActive: boolean;
  binding: VoiceCallBinding | null;
  /** 'connecting' covers the window between `startCall` and the first successful `connect()` —
   *  `voiceSession.ts`'s own state machine has no concept of this (it starts once a connection
   *  already exists). Once connected, mirrors `VoiceSession.getState()`. */
  phase: 'connecting' | VoiceState;
  caption: CaptionState | null;
  /** Set on `onReconnected`, cleared a few seconds later — the HUD notice text, or `null` when
   *  there's nothing to show. */
  reconnectNotice: string | null;
  elapsedMs: number;
  startCall: (binding: VoiceCallBinding) => void;
  endCall: () => void;
  pttPress: () => void;
  pttRelease: () => void;
}

const VoiceCallContext = createContext<VoiceCallContextValue | undefined>(undefined);

const RECONNECT_NOTICE_DURATION_MS = 6_000;

export function VoiceCallProvider({ children }: { children: React.ReactNode }) {
  const { showToast } = useTaskContext();

  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [binding, setBinding] = useState<VoiceCallBinding | null>(null);
  const [callToken, setCallToken] = useState<string | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [connecting, setConnecting] = useState(false);
  const [caption, setCaption] = useState<CaptionState | null>(null);
  const [reconnectNotice, setReconnectNotice] = useState<string | null>(null);
  const [callStartedAt, setCallStartedAt] = useState<number | null>(null);
  const [, forceTick] = useState(0);

  const sessionRef = useRef<VoiceSession | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** MEDIUM-6: wall-clock time of the last PTT press/release — the idle-timeout cap's clock. Reset
   *  at call start (so an unattended call that never touches PTT still starts the idle clock from
   *  connection time, not from `undefined`). */
  const lastPttActivityAtRef = useRef<number | null>(null);

  // Capability probe (DESIGN.md "Flagging" row) — the only honest discovery channel; a flag-off
  // 404 is mapped to `{enabled:false}` by `getVoiceConfig` itself, never surfaced as an error here.
  useEffect(() => {
    let alive = true;
    void getVoiceConfig()
      .then((config) => {
        if (alive) setVoiceEnabled(config.enabled);
      })
      .catch(() => {
        if (alive) setVoiceEnabled(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const dispatcher = useVoiceDispatcher({
    sessionId: binding?.sessionId ?? '',
    agentId: binding?.agentId,
    onAgentBound: (agentId) => {
      if (!binding) return;
      bindSessionAgent(binding.sessionId, agentId);
      setBinding((current) => (current ? { ...current, agentId } : current));
      // GAP-1: a call that starts before any agent is bound (voiceSession.ts's `agentId` was
      // undefined at construction) would otherwise carry a permanently blank "Bound console
      // agent:" line into every future rotation carry-over. `setAgentId` lets the already-live
      // VoiceSession pick up the binding the moment it happens, mid-call.
      sessionRef.current?.setAgentId(agentId);
    },
    onSpokenSummary: (event) => {
      if (!binding) return;
      // MAJOR-2a: the operator's own spoken prompt persists as role:'user' (with the dispatch's
      // clientTurnId, so it rides the existing user-side render dedupe); the assistant's narrated
      // completion persists as role:'model' (deduped on the OTHER side — see
      // partitionSessionMessages' MAJOR-2b doc comment).
      if (event.role === 'user') appendSpokenUserMessage(binding.sessionId, event.text, event.clientTurnId);
      else appendSpokenSummary(binding.sessionId, event.text);
    },
  });

  const teardown = useCallback(() => {
    setCallToken(null);
    setBinding(null);
    setVoiceState('idle');
    setConnecting(false);
    setCaption(null);
    setReconnectNotice(null);
    setCallStartedAt(null);
    lastPttActivityAtRef.current = null;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const endCall = useCallback(() => {
    teardown(); // the connect-effect's cleanup (keyed on callToken) tears down the VoiceSession itself
  }, [teardown]);

  const startCall = useCallback(
    (nextBinding: VoiceCallBinding) => {
      if (callToken) return; // a call is already active — VoiceCallButton disables itself for this case
      setBinding(nextBinding);
      setCallToken(`call:${Date.now()}:${Math.random().toString(36).slice(2)}`);
      setCallStartedAt(Date.now());
      lastPttActivityAtRef.current = Date.now(); // MEDIUM-6: idle clock starts at connection time
      setConnecting(true);
    },
    [callToken],
  );

  // Session-store deletion watch (DESIGN.md "Session binding" row: "session delete ends the call
  // with a toast"). Global — not scoped to whatever the operator currently has open — since a
  // voice call can be bound to a thread the operator has since navigated away from.
  useEffect(() => {
    if (!binding) return;
    return subscribeSessionStore(() => {
      // LOW-7: `loadPersistedSessionsOrNull` returns `null` on a storage read/parse FAILURE
      // (private-mode blip, corrupt write from another tab) — distinct from a genuinely empty/
      // missing blob. A failure here is not evidence the bound session was deleted; skip this
      // notification entirely rather than false-ending the call over a storage hiccup.
      const sessions = loadPersistedSessionsOrNull();
      if (sessions === null) return;
      const stillExists = sessions.some((session) => session.id === binding.sessionId);
      if (!stillExists) {
        showToast('The session bound to this voice call was deleted — call ended.', 'error');
        endCall();
      }
    });
  }, [binding, showToast, endCall]);

  // Elapsed-time tick — re-renders once a second while a call is up so `elapsedMs` (read below)
  // stays live without a separate ref/interval per consumer. MEDIUM-6: the same tick also drives
  // the idle/max-duration spend cap — piggybacking here instead of a second interval, since nothing
  // about the checks needs a tighter cadence than the meter already has.
  useEffect(() => {
    if (!callStartedAt) return;
    const id = setInterval(() => {
      forceTick((tick) => tick + 1);
      const now = Date.now();
      if (shouldEndCallForMaxDuration(now - callStartedAt)) {
        showToast('Voice call ended automatically after reaching the maximum call duration.', 'info');
        endCall();
        return;
      }
      const lastActivity = lastPttActivityAtRef.current;
      if (lastActivity !== null && shouldEndCallForIdle(now - lastActivity)) {
        showToast('Voice call ended automatically after 10 minutes of inactivity.', 'info');
        endCall();
      }
    }, 1_000);
    return () => clearInterval(id);
  }, [callStartedAt, showToast, endCall]);

  // Construct/tear down the VoiceSession exactly once per `callToken` — NOT per `binding`, since
  // `binding` also changes in place as the dispatcher (re)binds an agent (`onAgentBound` above),
  // and that must never restart the live connection.
  useEffect(() => {
    if (!callToken || !binding) return;
    let cancelled = false;
    const session = createVoiceSession(mintVoiceToken, {
      agentId: binding.agentId,
      getRecap: dispatcher.getRecap,
      onFunctionCall: dispatcher.onFunctionCall,
      onCaption: (text, speaker) => {
        dispatcher.onCaption(text, speaker);
        setCaption((current) => appendCaption(current, text, speaker));
      },
      onStateChange: (state, previous) => {
        setVoiceState(state);
        setConnecting(false);
        if (state === 'userRecording' && previous !== 'userRecording') setCaption(null); // fresh turn
      },
      onReconnected: (info) => {
        setReconnectNotice(reconnectNoticeText(!!info.recap));
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = setTimeout(() => setReconnectNotice(null), RECONNECT_NOTICE_DURATION_MS);
      },
      onError: (error: VoiceSessionErrorInfo) => {
        showToast(errorToastMessage(error.code), 'error');
        // MEDIUM-4: previously ANY onError tore the call down, discarding
        // `VoiceSessionErrorInfo.fallbackToText` entirely — an informational/benign provider error
        // mid-call (voiceSession.ts's generic `error` handler surfaces these as 'connect-failed'
        // too, alongside genuine SDP/connect failures) would drop a perfectly healthy call. Two
        // conditions actually warrant tearing down: the session never got past its very first
        // connect attempt at all (nothing yet to keep alive — `session.isConnected()` is false), or
        // `shouldEndCall` says this specific error is terminal (an explicit `fallbackToText`, or a
        // code that's always terminal regardless of the flag, e.g. mic-denied). Anything else keeps
        // the call up — the toast already told the operator, no retry loop either way (BUILD item 5).
        if (!session.isConnected() || shouldEndCall(error)) teardown();
      },
    });
    sessionRef.current = session;
    dispatcher.registerSession(session);
    void session.connect().then(() => {
      if (!cancelled) setConnecting(false); // no error fired — the connection is live
    });
    return () => {
      cancelled = true;
      dispatcher.registerSession(null);
      session.disconnect();
      if (sessionRef.current === session) sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on callToken only, see comment above
  }, [callToken]);

  // MEDIUM-6: every PTT press/release resets the idle-timeout clock — this is the ONLY activity
  // signal the idle cap watches (fleet narration/completions don't count; an operator who's stepped
  // away isn't listening either way).
  const pttPress = useCallback(() => {
    lastPttActivityAtRef.current = Date.now();
    sessionRef.current?.pttPress();
  }, []);
  const pttRelease = useCallback(() => {
    lastPttActivityAtRef.current = Date.now();
    sessionRef.current?.pttRelease();
  }, []);

  const value: VoiceCallContextValue = {
    voiceEnabled,
    isCallActive: !!callToken,
    binding,
    phase: connecting ? 'connecting' : voiceState,
    caption,
    reconnectNotice,
    elapsedMs: callStartedAt ? Date.now() - callStartedAt : 0,
    startCall,
    endCall,
    pttPress,
    pttRelease,
  };

  return <VoiceCallContext.Provider value={value}>{children}</VoiceCallContext.Provider>;
}

export function useVoiceCall(): VoiceCallContextValue {
  const context = useContext(VoiceCallContext);
  if (!context) throw new Error('useVoiceCall must be used within VoiceCallProvider');
  return context;
}
