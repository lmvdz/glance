/**
 * Voice call HUD — pure, framework-free decision/formatting functions backing the floating
 * in-call pill (webapp-voice-lane concern 08). Extracted the same way `Composer.tsx`'s auto-grow/
 * history-recall logic is (see that file's header) so every branch is directly unit-testable with
 * `bun:test`, with no React render and no fake timers required.
 */

import type { VoiceSessionErrorInfo, VoiceState } from './voiceSession';

// =============================================================================
// Elapsed time + cost meter (DESIGN.md "Session ownership" row: "the operator should see the
// meter" — a running cost ESTIMATE, not a billing-accurate figure; audio never transits the
// daemon, so there is no server-side spend signal this could reconcile against even if it wanted
// to. See voice-token.ts: `openai`'s registry entry is `flatPrice: false` (metered per session
// params, not a flat rate like the deferred xAI/Grok entry would be) — there is no PINNED
// per-minute number this repo can cite, only OpenAI's published (and frequently-changed)
// audio-token pricing. The constant below is a deliberately rough blended estimate (roughly
// splitting the published per-minute audio-input/audio-output rates for `gpt-realtime`) so the
// pill shows SOMETHING rather than nothing; it is not wired to any billing source and must not be
// read as authoritative.
// =============================================================================

/** Rough blended $/minute estimate for the v1 (OpenAI `gpt-realtime`) provider — NOT billing
 *  accurate, see the module doc comment above. Exported so a future provider entry (or a real
 *  pricing feed) can override it without touching every call site. */
export const VOICE_COST_PER_MINUTE_USD_ESTIMATE = 0.15;

/** `mm:ss`, floored to the second, never negative (a stale/clock-skewed `elapsedMs` still renders
 *  something sane instead of a negative or NaN readout). */
export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function estimateCallCostUsd(elapsedMs: number, ratePerMinuteUsd = VOICE_COST_PER_MINUTE_USD_ESTIMATE): number {
  return (Math.max(0, elapsedMs) / 60_000) * ratePerMinuteUsd;
}

/** `~$0.02` — the leading tilde is load-bearing copy, not decoration: it's the only thing telling
 *  the operator this number is an estimate rather than a metered total. */
export function formatCallCost(costUsd: number): string {
  return `~$${costUsd.toFixed(2)}`;
}

// =============================================================================
// State → label (pill's state indicator; DESIGN.md "Session state" — recording/thinking/
// speaking/tool, plus a call-lifecycle 'connecting' phase voiceSession.ts's own state machine has
// no concept of, since it only starts once a connection already exists).
// =============================================================================

export type CallHudPhase = 'connecting' | VoiceState;

export function voiceStateLabel(phase: CallHudPhase): string {
  switch (phase) {
    case 'connecting':
      return 'Connecting…';
    case 'idle':
      // The mic is MUTED at idle (hot-mic privacy, voiceSession.ts MINOR-8) — the old copy
      // ("Listening — hold to talk") claimed the opposite and taught operators a mute-toggle mental
      // model that made them talk into a dead mic. Say what's true.
      return 'Muted — hold or tap to talk';
    case 'userRecording':
      return 'Recording…';
    case 'awaitingResponse':
      return 'Thinking…';
    case 'speaking':
      return 'Speaking…';
    case 'toolPending':
      return 'Working…';
  }
}

// =============================================================================
// Live caption state (DESIGN.md "Transcript coherence"): the in-progress spoken turn, rendered
// live in the chat thread (AssistantChat's streaming voice bubble). VoiceCallContext accumulates
// per-speaker buffers itself (whisper's user transcript lands asynchronously, mid-reply — see its
// buffer doc comments) and publishes whichever side is currently in progress through this shape;
// COMPLETED turns leave this surface entirely and persist as durable Messages (`finalizeVoiceTurn`
// below + sessionStore.ts).
// =============================================================================

export interface CaptionState {
  speaker: 'assistant' | 'user';
  text: string;
}

/**
 * Voice back-and-forth in the chat thread: a COMPLETED caption turn becomes a durable session
 * `Message` (VoiceCallContext flushes through this at every turn boundary — speaker switch, a
 * fresh recording starting, the machine returning to idle, call end), so the whole spoken
 * conversation renders in `AssistantChat` like any typed exchange instead of living only in the
 * pill's transient caption line. Pure decision half, per this package's hook-testing convention.
 *
 * Returns `null` (persist nothing) for an empty/whitespace turn, and for a USER turn already
 * claimed by a `prompt_agent` dispatch — the dispatcher persisted that utterance itself
 * (`onSpokenSummary` `role:'user'`, WITH the dispatch's `clientTurnId` so it dedupes against the
 * agent-transcript echo); a second, id-less copy from the caption stream would double-render.
 */
export function finalizeVoiceTurn(
  caption: CaptionState | null,
  claimedByDispatch: boolean,
): { role: 'user' | 'model'; text: string } | null {
  const text = caption?.text.trim();
  if (!caption || !text) return null;
  if (caption.speaker === 'user' && claimedByDispatch) return null;
  return { role: caption.speaker === 'user' ? 'user' : 'model', text };
}

// =============================================================================
// Pinned-binding banner (DESIGN.md "Session binding" row: "the pill shows 'voice → <session
// title>'" — unconditionally, regardless of whatever view/session the operator navigates to while
// the call is live, since the pill itself is rendered at provider level and has no notion of
// "what the operator is currently looking at" to compare against; see the concern 08 report for
// why this is the chosen reading of "banner it on switch").
// =============================================================================

export function bindingBannerText(sessionTitle: string | undefined): string {
  const title = sessionTitle?.trim();
  return `voice → ${title || 'this session'}`;
}

// =============================================================================
// Reconnect notice (DESIGN.md "Lifecycle" row's HUD notice; exact base wording pinned by test so
// this file and the concern doc can never quietly drift apart).
// =============================================================================

export function reconnectNoticeText(hasRecap: boolean): string {
  return hasRecap ? 'Reconnected — recapping context.' : 'Reconnected.';
}

// =============================================================================
// Push-enable nudge (voice-loop concern 05, DESIGN.md "Push lane": the whole away-loop is inert if
// notification permission was never requested). Pure decision + pinned copy; the pill renders it
// styled like the `reconnectNotice` banner above. `permission` mirrors `../push.ts`'s
// `pushPermission()` return shape exactly — `NotificationPermission`'s three values plus
// `'unsupported'` for a browser with no Notification API at all. `dismissedThisCall` is per-call
// React state owned by `VoiceCallPill.tsx` (no persistence) — a once-per-call whisper, not a nag,
// that resets on the next call regardless of what happened on this one.
// =============================================================================

/** The nudge's one-line copy — pinned here, not inline in the component, so this file and the
 *  concern doc can never quietly drift apart (same convention as `reconnectNoticeText`). */
export const PUSH_NUDGE_TEXT = 'Enable notifications to get pinged when agents finish';

/** `'default'` (never asked) is the only state that shows anything: `'granted'`/`'denied'` are
 *  already-settled browser-side decisions (nothing left to nudge toward, and "the browser said
 *  no" must be respected, not re-prompted), and `'unsupported'` has no Notification API to ask. */
export function shouldShowPushNudge(permission: 'default' | 'granted' | 'denied' | 'unsupported', dismissedThisCall: boolean): boolean {
  return permission === 'default' && !dismissedThisCall;
}

// =============================================================================
// Error → toast copy (BUILD item 5: "distinct toasts ... no retry loops"). One sentence per code,
// exhaustive over `VoiceSessionErrorInfo['code']` — a future 5th code fails this file's build
// (missing switch arm) rather than silently falling through to a generic message.
// =============================================================================

export function errorToastMessage(code: VoiceSessionErrorInfo['code']): string {
  switch (code) {
    case 'mic-denied':
      return 'Microphone access was denied — voice call ended. You can keep typing.';
    case 'mint-failed':
      return 'Could not start the voice call — try again in a moment.';
    case 'mint-rate-limited':
      return 'Your organization has reached its voice-call limit for now — try again in a few minutes.';
    case 'connect-failed':
      return 'Voice call connection failed — falling back to text.';
    case 'reconnect-failed':
      return 'Voice call was lost and could not be restored — falling back to text.';
  }
}

// =============================================================================
// MEDIUM-4: honor VoiceSessionErrorInfo.fallbackToText. Previously VoiceCallContext.tsx ended the
// call on ANY onError, discarding the flag entirely — an informational/benign provider error mid-
// call (surfaced as 'connect-failed' by voiceSession.ts's generic 'error' handler, but NOT a
// connection teardown on its own) would drop a perfectly healthy call. `shouldEndCall` is the pure
// decision: end only for an explicit `fallbackToText`, or a code that is ALWAYS terminal regardless
// of whether the flag happened to be set at the call site.
//
// 'mic-denied' is always terminal even though `voiceSession.ts` doesn't set `fallbackToText` on it
// (no mic access means there is no voice channel to keep alive, full stop). 'reconnect-failed' is
// listed too for the same "always terminal" reason, even though every call site that emits it
// already sets `fallbackToText: true` — belt-and-braces, so a future call site can't silently regress
// this by forgetting the flag. 'mint-failed'/'connect-failed' are NOT unconditionally terminal: the
// caller (VoiceCallContext.tsx) additionally treats "never successfully connected yet" as terminal
// regardless of this function's answer (there's nothing yet to keep alive), which this pure helper
// deliberately doesn't know about — see VoiceSession.isConnected().
// =============================================================================

const ALWAYS_TERMINAL_ERROR_CODES: ReadonlySet<VoiceSessionErrorInfo['code']> = new Set(['mic-denied', 'reconnect-failed']);

export function shouldEndCall(errorInfo: Pick<VoiceSessionErrorInfo, 'code' | 'fallbackToText'>): boolean {
  return !!errorInfo.fallbackToText || ALWAYS_TERMINAL_ERROR_CODES.has(errorInfo.code);
}

// =============================================================================
// MEDIUM-6: idle / max-duration spend cap. Nothing previously ended an unattended call — a proactive
// re-mint happens every ~55 minutes forever, and completion narrations get spoken into an empty
// room. Two independent client-side caps, both pure so `VoiceCallContext.tsx`'s ticking check (it
// already re-renders once a second for the elapsed-time meter) can drive them without any of this
// logic itself owning a timer.
// =============================================================================

/** Hard cap on total call length regardless of activity — generous (2h, well past the ~55min
 *  re-mint cadence) but bounded, so a call nobody ever explicitly ends doesn't run forever. */
export const MAX_CALL_DURATION_MS = 2 * 60 * 60 * 1000;

/** No PTT activity (press OR release) for this long ends the call — an unattended session
 *  shouldn't keep re-minting and narrating completions into an empty room. Tightened 10min -> 3min
 *  (Lars, 2026-07-15): an open realtime session is billable surface, and the away-loop (completion
 *  push + next-call debrief) means hanging up early costs nothing — anything that finishes after
 *  the auto-hangup pushes a notification and gets spoken at the next call. */
export const CALL_IDLE_TIMEOUT_MS = 3 * 60 * 1000;

export function shouldEndCallForMaxDuration(elapsedMs: number, maxDurationMs = MAX_CALL_DURATION_MS): boolean {
  return elapsedMs >= maxDurationMs;
}

export function shouldEndCallForIdle(msSinceLastPttActivity: number, idleTimeoutMs = CALL_IDLE_TIMEOUT_MS): boolean {
  return msSinceLastPttActivity >= idleTimeoutMs;
}

// =============================================================================
// Push-to-talk gesture (BUILD item 3: "PTT button (press-hold AND tap-toggle both work)"). A
// three-state gesture machine, structurally identical in spirit to `voiceSession.ts`'s own
// `nextVoiceState` — pure `(mode, event, holdMs) -> {mode, action}` so the pointer-event wiring in
// `VoiceCallPill.tsx` is a thin, untested shell around an exhaustively-tested table.
//
//   idle --down(press)--> holding --up, short hold--> locked (stays recording)
//   holding --up, long hold--(release)--> idle
//   locked --down, engaged >= min turn--(release)--> idle (the second tap turns it back off)
//   locked --down, engaged < min turn--(abort)--> idle (a double-click — nothing was said)
//
// THE EMPTY-TURN RULE (live-bug fix, 2026-07-15): an engagement that ends before it could
// plausibly contain speech must ABORT (discard the buffer), never RELEASE (commit + ask the model
// to respond). A release with only room tone behind it makes the model re-answer the previous
// context — heard live as "it immediately said the same thing again" — while the release re-muted
// the mic, so the operator's actual words went nowhere. Three gestures used to hit this: a
// deliberate mouse click held past the old 250ms tap threshold, a pointer drifting off the 40px
// button mid-click (`pointerleave`), and a double-click's second `down` landing on 'locked'.
// =============================================================================

export type PttUiMode = 'idle' | 'holding' | 'locked';
/** `'leave'` (MINOR-6) is distinct from `'up'`: a `pointerleave` fires when the pointer slides off
 *  the button, which is NOT the same signal as a genuine release while still over the target — only
 *  the latter may legitimately turn into a tap-to-lock.
 *
 *  HIGH-3: `'forceRelease'` is distinct from BOTH — `pointercancel`, a window `blur`, or the
 *  document going hidden (`visibilitychange`) mean the operator has stopped interacting with this
 *  tab/window entirely (switched apps, the OS yanked the pointer, the browser cancelled the
 *  gesture). Unlike `'leave'`, this must force a release even out of `'locked'` — a locked
 *  (tap-to-toggle) recording surviving the pointer sliding off the button is the whole POINT of
 *  "lock", but surviving the user tabbing away entirely is a hot mic with nobody watching the HUD
 *  to notice. The PTT watchdog (`shouldForceReleaseForWatchdog` below) fires the same event as a
 *  last-resort backstop if none of those signals ever arrive. */
/** `'watchdogExpire'` (review finding, voice-loop branch): the 60s hot-mic watchdog firing means
 *  NOBODY has interacted with the pill for the whole window — overwhelmingly a forgotten/accidental
 *  lock, not a deliberate dictation. Unlike `'forceRelease'` (blur/tab-hide mid-interaction, where
 *  committing preserves real speech), the watchdog ABORTS: transmitting up to a minute of ambient
 *  room audio to the provider — and having the model answer it unprompted — is a privacy failure,
 *  while discarding a genuinely-forgotten recording costs nothing. A present operator who dictated
 *  60s+ sees the pill flip to "Muted" and can re-record. */
export type PttGestureEvent = 'down' | 'up' | 'leave' | 'forceRelease' | 'watchdogExpire';
export interface PttGestureResult {
  mode: PttUiMode;
  /** `'abort'` (empty-turn rule, see the section comment): end the engagement and DISCARD the
   *  buffer — `VoiceSession.pttAbort()` — instead of committing it and asking for a response. */
  action: 'press' | 'release' | 'abort' | 'none';
}

/** A press/release shorter than this reads as a "tap" (lock on) rather than a deliberate hold.
 *  Raised 250 → 500 (live-bug fix): a deliberate "click to unmute" mouse press routinely runs
 *  250–500ms, and past the threshold it read as an instant, empty talk turn. Below-threshold taps
 *  lock recording ON, so nothing the operator says is ever lost to a slow click — while a genuine
 *  hold-to-talk utterance (press, speak, lift) is always comfortably longer than 500ms. */
export const PTT_TAP_THRESHOLD_MS = 500;

/** An engagement shorter than this cannot plausibly contain a finished utterance — ending it
 *  aborts (discards) instead of releasing (commit + response). See the empty-turn rule above. */
export const PTT_MIN_TURN_MS = 500;

export function nextPttUiState(
  mode: PttUiMode,
  event: PttGestureEvent,
  holdMs: number,
  tapThresholdMs = PTT_TAP_THRESHOLD_MS,
  minTurnMs = PTT_MIN_TURN_MS,
): PttGestureResult {
  /** Ends the engagement: a turn long enough to plausibly contain speech commits (release);
   *  anything shorter is an accident of pointer mechanics and discards (abort). */
  const endEngagement = (): PttGestureResult => ({ mode: 'idle', action: holdMs < minTurnMs ? 'abort' : 'release' });
  if (event === 'watchdogExpire') {
    // Always an ABORT from an engaged mode (see the event's doc comment) — never a commit.
    if (mode === 'idle') return { mode: 'idle', action: 'none' };
    return { mode: 'idle', action: 'abort' };
  }
  if (event === 'forceRelease') {
    // HIGH-3: unconditional — ends 'holding' AND 'locked' engagements alike; a true no-op only
    // from 'idle' (nothing was engaged to release). A blur/cancel landing within the min-turn
    // window aborts like any other short engagement (nothing was said yet); a long-held one
    // commits — the operator was mid-interaction (tab switch, OS dialog), so their speech is real.
    if (mode === 'idle') return { mode: 'idle', action: 'none' };
    return endEngagement();
  }
  if (event === 'down') {
    if (mode === 'idle') return { mode: 'holding', action: 'press' };
    // Second tap: stop. `holdMs` here is the time since the FIRST tap's own down (the engagement
    // length) — a second down inside the min-turn window is a double-click, not a spoken turn.
    if (mode === 'locked') return endEngagement();
    return { mode, action: 'none' }; // a stray 'down' while already holding — ignore
  }
  if (event === 'leave') {
    // MINOR-6: a quick press-then-slide-off must never read as a tap-to-lock — that would leave
    // the mic silently recording with no way to tell it was an accident, not a deliberate lock.
    // End the engagement from 'holding' regardless of elapsed time (aborting inside the min-turn
    // window — pointer drift during a click — committing past it, so sliding off mid-dictation
    // still sends what was said). 'idle'/'locked' stay a no-op: a locked recording is a
    // deliberate toggle that must survive the pointer moving away afterward (the whole point of
    // "lock" is that the pointer no longer needs to stay put).
    if (mode === 'holding') return endEngagement();
    return { mode, action: 'none' };
  }
  // event === 'up'
  if (mode === 'holding') {
    if (holdMs < tapThresholdMs) return { mode: 'locked', action: 'none' }; // quick tap: stay recording
    return endEngagement(); // a real hold: commit on lift (>= min turn whenever >= tap threshold)
  }
  return { mode, action: 'none' }; // 'up' while idle/locked (a stray duplicate up) — no-op
}

// =============================================================================
// HIGH-3: PTT watchdog — a last-resort backstop for a hot mic that outlives every other release
// signal (up/leave/forceRelease). `VoiceCallPill.tsx` polls this on an interval against how long
// the current engagement (holding OR locked) has lasted; once true, it fires the SAME
// 'forceRelease' gesture a blur/visibilitychange would. Pure so the threshold logic is directly
// testable without a real timer/interval.
// =============================================================================

/** Default max continuous PTT engagement before the watchdog forces a release — generous enough to
 *  never interrupt a genuine long dictation, but bounded so a stuck/forgotten lock can't hold the
 *  mic open indefinitely. */
export const MAX_PTT_HOLD_MS = 60_000;

export function shouldForceReleaseForWatchdog(mode: PttUiMode, heldMs: number, maxHoldMs = MAX_PTT_HOLD_MS): boolean {
  return mode !== 'idle' && heldMs >= maxHoldMs;
}
