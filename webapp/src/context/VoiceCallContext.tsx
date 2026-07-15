import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { getVoiceConfig, mintVoiceToken } from '../lib/api';
import createVoiceSession, { type VoiceSession, type VoiceSessionErrorInfo, type VoiceState } from '../lib/voice/voiceSession';
import {
  errorToastMessage,
  finalizeVoiceTurn,
  reconnectNoticeText,
  shouldEndCall,
  shouldEndCallForIdle,
  shouldEndCallForMaxDuration,
  type CaptionState,
} from '../lib/voice/callHud';
import { useVoiceDispatcher } from '../hooks/useVoiceDispatcher';
import { buildVoiceContextBrief } from '../lib/voice/tools';
import { appendSpokenSummary, appendSpokenUserMessage, bindSessionAgent, loadPersistedSessionsOrNull, subscribeSessionStore } from '../lib/chat/sessionStore';
import { useTaskContext } from './TaskContext';
import { useAuth } from './AuthContext';
import { usePageContext } from './PageContext';
import { serializePageContextForPrompt } from '../lib/pageContextDerive';

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

/**
 * Org-switch call termination (plans/voice-db-mode/07-csp-and-org-switch.md, DESIGN.md "Org switch
 * mid-call" row). A voice call is bound to a chat session, but the tool dispatches (`prompt_agent`,
 * `spawn_agent`, …) resolve the fleet from the CURRENT session's active org — so if the operator
 * switches orgs mid-call, the call would keep narrating under org A's minted token while
 * dispatching into org B's fleet. `pinnedOrgId` is captured once, at `startCall`; `currentOrgId` is
 * re-read live off `useAuth()`'s `me.activeOrganizationId` on every render. Server-side dispatch
 * binding is deliberately NOT done instead: the operator is a legitimate member of both orgs, so
 * this is attribution confusion, not privilege escalation, and ending client-side is enough.
 *
 * Pulled out as a pure, framework-free function per this package's hook-testing convention (see
 * `useVoiceDispatcher.test.ts`'s header) — there is no jsdom/render harness here, so the org-switch
 * DECISION is unit-tested directly; the effect below is the untested imperative shell around it.
 * `null` pinned values never trigger: file mode has no org concept, so both sides stay permanently
 * `null` there and no call ever ends over this.
 */
export function shouldEndCallForOrgSwitch(pinnedOrgId: string | null, currentOrgId: string | null): boolean {
  return pinnedOrgId !== null && currentOrgId !== pinnedOrgId;
}

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
  /** End the engagement WITHOUT sending it (empty-turn rule, callHud.ts) — the gesture layer
   *  decided it was an accidental click/drift/double-click, not a spoken turn. */
  pttAbort: () => void;
}

const VoiceCallContext = createContext<VoiceCallContextValue | undefined>(undefined);

const RECONNECT_NOTICE_DURATION_MS = 6_000;

export function VoiceCallProvider({ children }: { children: React.ReactNode }) {
  const { showToast, agents, currentProject } = useTaskContext();
  // What the operator is looking at RIGHT NOW (live page-context store) — folded into the
  // connect-time context brief and streamed as silent mid-call updates on navigation, so the
  // voice model can resolve "this repository" / "this task" / "what I'm looking at".
  const pageContext = usePageContext();
  // File mode: `me` is always null, so `activeOrganizationId` reads as `null` throughout — the
  // org-switch check below never fires there (see `shouldEndCallForOrgSwitch`'s doc comment).
  const { me } = useAuth();

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
  /** Per-speaker in-progress turn buffers. Two INDEPENDENT buffers, not one speaker-switching
   *  caption: whisper-1 delivers the operator's transcript asynchronously — routinely landing in
   *  the MIDDLE of the assistant's streaming reply — so a single buffer would split the
   *  assistant's turn in two around the late user transcript. The user buffer flushes the moment
   *  the assistant starts replying (or at any turn boundary); the assistant buffer keeps
   *  accumulating regardless. */
  const assistantCaptionRef = useRef('');
  const userCaptionRef = useRef('');
  /** True once the current user turn's spoken text was claimed by a `prompt_agent` dispatch
   *  (`onSpokenSummary` `role:'user'` fired) — the caption flush skips persisting a second copy
   *  (see `finalizeVoiceTurn`). Reset at the start of every fresh recording. */
  const turnClaimedByDispatchRef = useRef(false);
  /** MEDIUM-6: wall-clock time of the last PTT press/release — the idle-timeout cap's clock. Reset
   *  at call start (so an unattended call that never touches PTT still starts the idle clock from
   *  connection time, not from `undefined`). */
  const lastPttActivityAtRef = useRef<number | null>(null);
  /** Org-switch call termination's pinned value (`shouldEndCallForOrgSwitch` above) — set once at
   *  `startCall`, compared against the LIVE `me.activeOrganizationId` on every render thereafter. */
  const pinnedOrgIdRef = useRef<string | null>(null);
  /** The context brief, rebuilt every render and read through this ref at connection-wiring time
   *  (`getContextBrief`) — the VoiceSession's closure is fixed per call, the ref keeps it live. */
  const contextBriefRef = useRef('');

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
      if (event.role === 'user') {
        appendSpokenUserMessage(binding.sessionId, event.text, event.clientTurnId);
        // The dispatch owns this user turn's persistence — the caption flush must not write a
        // second, id-less copy of the same utterance (see `finalizeVoiceTurn`).
        turnClaimedByDispatchRef.current = true;
      } else {
        appendSpokenSummary(binding.sessionId, event.text);
      }
    },
  });

  // Rebuilt every render so `getContextBrief` (read at connection-wiring time, and again on every
  // silent reconnect/rotation) always describes the CURRENT project/session/agent/screen.
  contextBriefRef.current = buildVoiceContextBrief({
    projectName: currentProject?.name,
    sessionTitle: binding?.sessionTitle,
    agentName: binding?.agentId ? agents.find((a) => a.id === binding.agentId)?.name : undefined,
    pageContextBlock: serializePageContextForPrompt(pageContext),
  });

  /** The live caption (pill state + AssistantChat's streaming voice bubble) mirrors whichever
   *  buffer matters most right now: a streaming assistant reply wins; otherwise a pending user
   *  transcript; otherwise nothing. */
  const refreshLiveCaption = useCallback(() => {
    setCaption(
      assistantCaptionRef.current
        ? { speaker: 'assistant', text: assistantCaptionRef.current }
        : userCaptionRef.current
          ? { speaker: 'user', text: userCaptionRef.current }
          : null,
    );
  }, []);

  /** Turn boundaries: persist a completed side of the spoken back-and-forth as a durable session
   *  Message (the chat thread's copy) and clear its buffer. Safe to call redundantly — a
   *  blank/claimed turn persists nothing (`finalizeVoiceTurn`), and a flush into a since-deleted
   *  session is a store-level no-op. */
  const flushUserTurn = useCallback(
    (sessionId: string) => {
      const turn = finalizeVoiceTurn(
        userCaptionRef.current ? { speaker: 'user', text: userCaptionRef.current } : null,
        turnClaimedByDispatchRef.current,
      );
      userCaptionRef.current = '';
      if (turn) appendSpokenUserMessage(sessionId, turn.text, undefined);
      refreshLiveCaption();
    },
    [refreshLiveCaption],
  );
  const flushAssistantTurn = useCallback(
    (sessionId: string) => {
      const turn = finalizeVoiceTurn(assistantCaptionRef.current ? { speaker: 'assistant', text: assistantCaptionRef.current } : null, false);
      assistantCaptionRef.current = '';
      if (turn) appendSpokenSummary(sessionId, turn.text);
      refreshLiveCaption();
    },
    [refreshLiveCaption],
  );
  /** Every boundary flushes the user side first — the operator's utterance precedes the reply it
   *  provoked, and durable messages render in append order. */
  const flushCaptionTurns = useCallback(
    (sessionId: string) => {
      flushUserTurn(sessionId);
      flushAssistantTurn(sessionId);
    },
    [flushUserTurn, flushAssistantTurn],
  );

  const teardown = useCallback(() => {
    setCallToken(null);
    setBinding(null);
    setVoiceState('idle');
    setConnecting(false);
    setCaption(null);
    setReconnectNotice(null);
    setCallStartedAt(null);
    lastPttActivityAtRef.current = null;
    pinnedOrgIdRef.current = null;
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
      pinnedOrgIdRef.current = me?.activeOrganizationId ?? null; // org-switch check's baseline
      setConnecting(true);
    },
    [callToken, me],
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

  // Org switch ends the call (plans/voice-db-mode/07-csp-and-org-switch.md, DESIGN.md "Org switch
  // mid-call" row) — see `shouldEndCallForOrgSwitch`'s doc comment above for why this is client-side
  // and why it's a toast, not a hard error. Fires before any further tool dispatch can resolve
  // against the new org.
  useEffect(() => {
    if (!callToken) return;
    if (shouldEndCallForOrgSwitch(pinnedOrgIdRef.current, me?.activeOrganizationId ?? null)) {
      showToast('Voice call ended — the active organization changed.', 'info');
      endCall();
    }
  }, [callToken, me?.activeOrganizationId, showToast, endCall]);

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
    const boundSessionId = binding.sessionId; // fixed for the call's lifetime (only agentId rebinds)
    const session = createVoiceSession(mintVoiceToken, {
      agentId: binding.agentId,
      getRecap: dispatcher.getRecap,
      getContextBrief: () => contextBriefRef.current,
      onFunctionCall: dispatcher.onFunctionCall,
      onCaption: (text, speaker) => {
        dispatcher.onCaption(text, speaker);
        if (speaker === 'user') {
          userCaptionRef.current += text;
        } else {
          // The reply starting is the user turn's boundary: whisper's transcript of the operator's
          // utterance (however late it landed) belongs BEFORE the reply it provoked, so persist it
          // now — the assistant buffer keeps streaming independently.
          if (userCaptionRef.current) flushUserTurn(boundSessionId);
          assistantCaptionRef.current += text;
        }
        refreshLiveCaption();
      },
      onStateChange: (state, previous) => {
        setVoiceState(state);
        setConnecting(false);
        if (state === 'userRecording' && previous !== 'userRecording') {
          flushCaptionTurns(boundSessionId); // turn boundary: whatever was said before this recording is complete
          turnClaimedByDispatchRef.current = false; // a fresh user turn — no dispatch has claimed it yet
        } else if (state === 'idle' && previous !== 'idle') {
          // The response (and thus the assistant's spoken turn) finished — flush so the chat
          // thread gets the completed turn promptly, not only when the operator next speaks.
          flushCaptionTurns(boundSessionId);
        }
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
    // Live-triage hook: `__glanceVoiceDebug()` in the browser console dumps the session's
    // diagnostic ring buffer (event types + state transitions + correlation ids, no transcript
    // text) — the flight recorder for wire-level bug reports. Cleared with the call.
    (window as unknown as Record<string, unknown>).__glanceVoiceDebug = () => session.getDebugLog();
    void session.connect().then(() => {
      if (!cancelled) setConnecting(false); // no error fired — the connection is live
    });
    return () => {
      cancelled = true;
      // Call over (endCall/org-switch/session-delete/unmount): whatever was mid-utterance is the
      // final turn — persist it so the chat thread's record of the call is complete. A flush into
      // a just-deleted session is a store-level no-op.
      flushCaptionTurns(boundSessionId);
      dispatcher.registerSession(null);
      session.disconnect();
      // Safe unconditionally: React runs this cleanup BEFORE a successor call's own effect body,
      // which re-installs the hook for the new session.
      delete (window as unknown as Record<string, unknown>).__glanceVoiceDebug;
      if (sessionRef.current === session) sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on callToken only, see comment above
  }, [callToken]);

  // Mid-call navigation: when the operator moves to a different screen, silently inject a context
  // update (no response requested — the model absorbs it and uses it on the next turn). Debounced,
  // deduped against the last sent block, and the connect-time brief covers the initial view (the
  // `null` sentinel skips the first run per call so connect isn't immediately followed by a
  // duplicate update).
  const lastSentPageContextRef = useRef<string | null>(null);
  useEffect(() => {
    if (!callToken) {
      lastSentPageContextRef.current = null;
      return;
    }
    const serialized = serializePageContextForPrompt(pageContext);
    if (lastSentPageContextRef.current === null) {
      lastSentPageContextRef.current = serialized;
      return;
    }
    if (!serialized || serialized === lastSentPageContextRef.current) return;
    const timer = setTimeout(() => {
      lastSentPageContextRef.current = serialized;
      sessionRef.current?.updateSystemContext(`[Context update — the operator's screen changed.]\n${serialized}`);
    }, 1_500);
    return () => clearTimeout(timer);
  }, [callToken, pageContext]);

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
  const pttAbort = useCallback(() => {
    lastPttActivityAtRef.current = Date.now(); // an aborted click is still operator activity
    sessionRef.current?.pttAbort();
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
    pttAbort,
  };

  return <VoiceCallContext.Provider value={value}>{children}</VoiceCallContext.Provider>;
}

export function useVoiceCall(): VoiceCallContextValue {
  const context = useContext(VoiceCallContext);
  if (!context) throw new Error('useVoiceCall must be used within VoiceCallProvider');
  return context;
}
