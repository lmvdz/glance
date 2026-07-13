/**
 * Voice session state machine + WebRTC transport (webapp-voice-lane concern 06).
 *
 * The repo's first provider-direct client surface: the browser connects straight to OpenAI's
 * realtime endpoint over WebRTC using a daemon-minted ephemeral token (`mintVoiceToken` in
 * `../api.ts`) — audio never transits the daemon. Framework-free: no React here (wiring lands in
 * concerns 07/08), no DOM assumptions beyond what's injected, so this whole module (bar the
 * default-export browser wiring at the bottom) runs under `bun test` without a browser.
 *
 * Connect flow (DESIGN.md "Providers"/"Lifecycle" rows, verified 2026-07-10): mint → build an
 * `RTCPeerConnection`, add the mic track, open a data channel named `oai-events` → `createOffer` /
 * `setLocalDescription` → POST the raw SDP offer text to the provider's `/v1/realtime/calls` with
 * `Authorization: Bearer <ek_...>` + `Content-Type: application/sdp` → the response body IS the SDP
 * answer text → `setRemoteDescription`. Remote audio arrives via `ontrack`. JSON events ride the
 * data channel both directions. Model/voice/instructions/turn_detection are pinned into the mint
 * request SERVER-SIDE (`src/voice-token.ts`) — this module never sends a `session.update`; doing so
 * would silently un-pin a cost-bearing parameter the mint already fixed.
 *
 * THE TWO ARBITRATION RULES (design-critical, pinned by `voiceSession.test.ts` — these ARE the
 * barge-in machinery per DESIGN.md's "Session state" row, not an incidental side effect of PTT):
 *   (a) PTT-press while a response is active (`speaking`, and — generalized here — `awaitingResponse`
 *       or `toolPending`, since a response can be "active" before its first audio delta or while a
 *       function call is in flight) → `response.cancel` + local playback stop, THEN start recording.
 *       WebRTC truncates playback server-side; this module also calls `stopPlayback()` so the local
 *       `<audio>` element doesn't keep rendering already-buffered frames. `VoiceSession.pttPress`
 *       additionally sends a best-effort `conversation.item.truncate` for the in-flight audio item
 *       (see `sendBargeInTruncate`) — the reducer's effects can't carry this because it needs
 *       runtime item/timing data the pure reducer never sees.
 *   (b) `response.create` is NEVER emitted while `userRecording`. This holds structurally, not by a
 *       runtime check sprinkled at each call site: the reducer's `ptt-press` branch is the ONLY way
 *       into `userRecording`, and every OTHER path that would emit `response.create` (PTT release,
 *       a queued injection flush, a function-call ack) requires the state to be something other
 *       than `userRecording` first. See `nextVoiceState` below for the exhaustive table.
 *
 * State machine: `idle | userRecording | awaitingResponse | speaking | toolPending`. The pure
 * reducer (`nextVoiceState`) owns the state × event transition table and the wire-level side
 * effects each transition demands (send this JSON, stop playback); `VoiceSession` owns everything
 * impure (the actual connection, timers, the injection/ack queues, lifecycle rotation) and applies
 * the reducer's effects.
 *
 * `response.done` correlation (CRITICAL, see `outstandingResponses`): the realtime wire can have
 * MORE THAN ONE response in flight at once — a function-call's synchronous ack sends a fresh
 * `response.create` for the continuation before the wrapping response (the one that carried the
 * function call) has itself emitted its own `response.done`. This module counts every
 * `response.create` it actually sends and only forwards a `response-done` event to the reducer once
 * that count is back to zero, so an unrelated wrapping-response completion can never be mistaken for
 * the ack response's completion (which would otherwise desync the whole machine: idle while the ack
 * response is still live, re-mint rotating mid-response, injections flushing into an active
 * response, and a PTT press taking the idle branch — no cancel, no stopPlayback).
 *
 * Testability (structured per the concern's explicit ask): every external dependency —
 * minting, `RTCPeerConnection` construction, `getUserMedia`, the SDP POST, remote-audio attachment,
 * playback stop, wall-clock time, and timers — is injected via `VoiceSessionDeps`. Tests build a
 * `VoiceSession` with fakes for all of these and drive it through `pttPress`/`pttRelease`/
 * `handleServerEvent`/`sendFunctionOutput`/`queueInjection` without ever touching a real browser
 * API. `createVoiceSession` (the default export) is the ONLY place real browser APIs are wired in
 * — that's the "DI surface stays honest" boundary the concern asks for.
 */

// =============================================================================
// Pure state machine
// =============================================================================

export type VoiceState = 'idle' | 'userRecording' | 'awaitingResponse' | 'speaking' | 'toolPending';

export interface PendingFunctionCall {
  callId: string;
  name: string;
  arguments: string;
  /** Whether the response that produced this call was triggered by the user's own turn (PTT
   *  release) or by an agent-initiated turn (a queued injection flush, or the ack that follows
   *  `sendFunctionOutput`). Concern 07's human-turn injection gate needs this to tell "the user
   *  asked for this tool call" apart from "the agent chained another tool call on its own". */
  trigger: 'user' | 'injection';
}

/** Events the pure reducer understands. These are internal — `VoiceSession` derives them from
 *  public calls (`pttPress`/`pttRelease`) and from parsed realtime server events
 *  (`response.created` → `response-started`, etc.) rather than exposing this union directly. */
export type VoiceEvent =
  | { type: 'ptt-press' }
  | { type: 'ptt-release' }
  | { type: 'response-started' }
  | { type: 'function-call-ready'; call: PendingFunctionCall }
  | { type: 'response-done' }
  | { type: 'ack-sent' }
  | { type: 'injection-flushed' }
  /** Force the machine back to `idle` regardless of its current state — the ONLY transition an
   *  impure caller can trigger unconditionally. Used by `VoiceSession` when a connection is torn
   *  down and rebuilt out from under whatever the state machine thought was happening (reconnect,
   *  proactive rotation, `disconnect()`), so the reset always goes through `dispatch` (and thus
   *  `onStateChange`) instead of a silent direct field assignment. */
  | { type: 'reset' };

/** Wire-level side effects a transition demands. `VoiceSession.applyEffect` is the only consumer —
 *  keeping effects as data (not closures) is what makes `nextVoiceState` a pure function callers
 *  can exhaustively table-test without a data channel. */
export type VoiceEffect = { type: 'send'; payload: Record<string, unknown> } | { type: 'stop-playback' };

export interface ReducerResult {
  state: VoiceState;
  effects: VoiceEffect[];
}

const CLEAR: VoiceEffect = { type: 'send', payload: { type: 'input_audio_buffer.clear' } };
const COMMIT: VoiceEffect = { type: 'send', payload: { type: 'input_audio_buffer.commit' } };
const RESPONSE_CREATE: VoiceEffect = { type: 'send', payload: { type: 'response.create' } };
const RESPONSE_CANCEL: VoiceEffect = { type: 'send', payload: { type: 'response.cancel' } };
const STOP_PLAYBACK: VoiceEffect = { type: 'stop-playback' };

const noop = (state: VoiceState): ReducerResult => ({ state, effects: [] });

/** Barge-in (arbitration rule a): cancel whatever response is in flight, stop local playback, and
 *  start recording fresh. Applies from every state where a response could plausibly be "active"
 *  (`awaitingResponse` — sent but not yet audible; `speaking` — the pinned case; `toolPending` — a
 *  function call is in flight and its wrapping response may still be open). The provider itself can
 *  answer `response.cancel` with a benign `response_cancel_not_active` error when nothing was
 *  actually in flight (e.g. two barge-ins in quick succession) — `VoiceSession.handleServerEvent`
 *  filters that known-benign code rather than surfacing it as a connection failure, which is what
 *  makes it safe to send unconditionally here. */
function bargeIn(): ReducerResult {
  return { state: 'userRecording', effects: [RESPONSE_CANCEL, STOP_PLAYBACK, CLEAR] };
}

/**
 * `(state, event) -> {state, effects}` — the entire voice session transition table. Every branch
 * below is intentional, not a fallthrough default: states/events with no meaningful transition
 * return `noop(state)` explicitly so the exhaustive test table has a real assertion for every cell,
 * not an assumed one.
 */
export function nextVoiceState(state: VoiceState, event: VoiceEvent): ReducerResult {
  if (event.type === 'reset') {
    // Unconditional: any state collapses to `idle`. Only emit stop-playback when there was
    // something to reset FROM — from `idle` this is a true no-op (no spurious extra effect on a
    // fresh connect(), which starts from idle already).
    return state === 'idle' ? noop('idle') : { state: 'idle', effects: [STOP_PLAYBACK] };
  }
  switch (state) {
    case 'idle':
      switch (event.type) {
        case 'ptt-press':
          return { state: 'userRecording', effects: [CLEAR] };
        case 'injection-flushed':
          // Only reachable when VoiceSession has just sent a queued injection's items +
          // response.create while idle (the only quiescent state injections/ack flush from).
          return { state: 'awaitingResponse', effects: [] };
        default:
          return noop('idle');
      }
    case 'userRecording':
      switch (event.type) {
        case 'ptt-press':
          return noop('userRecording'); // already recording — idempotent, no duplicate clear
        case 'ptt-release':
          // The user's turn: commit the buffer and ask for a response. This is the ONLY place
          // response.create is emitted from a state transition rooted in userRecording, and it
          // only fires on the way OUT of userRecording — rule (b) holds by construction.
          return { state: 'awaitingResponse', effects: [COMMIT, RESPONSE_CREATE] };
        default:
          // response-started / function-call-ready / response-done / ack-sent arriving while the
          // user is actively recording: stay in userRecording, no wire effects. This is rule (b)'s
          // other face — an ack or injection that would have emitted response.create is instead
          // silently absorbed here (see `VoiceSession.sendFunctionOutput`'s ack-sent handling).
          return noop('userRecording');
      }
    case 'awaitingResponse':
      switch (event.type) {
        case 'ptt-press':
          return bargeIn();
        case 'response-started':
          return { state: 'speaking', effects: [] };
        case 'function-call-ready':
          return { state: 'toolPending', effects: [] };
        case 'response-done':
          // The turn ended without ever producing audio (e.g. a function-call-only response whose
          // ack already resolved, or a short non-spoken reply) — back to quiescent.
          return { state: 'idle', effects: [] };
        default:
          return noop('awaitingResponse');
      }
    case 'speaking':
      switch (event.type) {
        case 'ptt-press':
          return bargeIn(); // the pinned case
        case 'function-call-ready':
          return { state: 'toolPending', effects: [] };
        case 'response-done':
          return { state: 'idle', effects: [] };
        default:
          return noop('speaking');
      }
    case 'toolPending':
      switch (event.type) {
        case 'ptt-press':
          return bargeIn(); // interrupting a slow tool-ack cycle is still a valid barge-in
        case 'ack-sent':
          // The dispatcher (concern 07) called sendFunctionOutput and we were NOT preempted by a
          // ptt-press in the meantime (that would already have moved state to userRecording,
          // landing in the branch above instead of here) — safe to continue the turn.
          return { state: 'awaitingResponse', effects: [RESPONSE_CREATE] };
        default:
          // A second function-call-ready before the first is acked, or the WRAPPING response's own
          // response.done arriving before the dispatcher has acked yet: both required protocol
          // handling, not an edge case to shrug off. `VoiceSession` already de-dupes/correlates
          // `response.done` against outstanding `response.create` sends before this event ever
          // reaches the reducer (see the module doc comment) — by the time either of these fires,
          // staying `toolPending` and waiting for `sendFunctionOutput` is the only correct move.
          return noop('toolPending');
      }
  }
}

// =============================================================================
// Realtime server events this module reacts to
// =============================================================================

/** A subset of the OpenAI realtime server-event shapes this module acts on. Deliberately loose
 *  (`[key: string]: unknown`) — the wire sends many event types this module doesn't need to model
 *  (session.created, rate_limits.updated, etc.); unrecognized `type`s are ignored, not errors. */
export interface RealtimeServerEvent {
  type: string;
  [key: string]: unknown;
}

/** Pulls `response.id` out of a `response.created`/`response.done` event's nested `response` object
 *  (MINOR-4 correlation) — both events carry it at `evt.response.id` per the realtime API's wire
 *  shape. Loose/defensive on purpose: an unexpected shape yields `undefined` (falls back to
 *  `currentTrigger`) rather than throwing. */
function extractResponseId(evt: RealtimeServerEvent): string | undefined {
  const response = evt.response;
  if (!response || typeof response !== 'object') return undefined;
  const id = (response as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

/** Provider error codes this module treats as benign, routine gestures rather than connection
 *  failures — both are the server's response to a no-op we send unconditionally by design:
 *  `response_cancel_not_active` (barge-in's `response.cancel` when nothing was actually in
 *  flight) and `input_audio_buffer_commit_empty` (an empty PTT tap's `input_audio_buffer.commit`
 *  with no audio behind it). `conversation_already_has_active_response` (CRITICAL-1
 *  belt-and-braces) is the provider's rejection of a `response.create` sent while a response was
 *  still open — the deferred-send machinery below (`sendRaw`/`deferredResponseCreate`) is meant to
 *  make this unreachable in practice, but if it ever does fire, it must be absorbed rather than
 *  torn down as a connection failure. Any other error code still surfaces via `onError`. */
const BENIGN_ERROR_CODES: ReadonlySet<string> = new Set([
  'response_cancel_not_active',
  'input_audio_buffer_commit_empty',
  'conversation_already_has_active_response',
]);

// =============================================================================
// Injected dependencies
// =============================================================================

/** Opaque timer handle — `ReturnType<typeof setTimeout>` in the browser, whatever a test's fake
 *  clock hands back in tests. Never inspected, only round-tripped to `clearTimer`. */
export type VoiceTimerHandle = unknown;

/** The subset of `RTCDataChannel` this module needs. Kept narrow (rather than typing against the
 *  real DOM interface everywhere) so tests can supply a plain object instead of a real channel. */
export interface DataChannelLike {
  readyState: string;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** The subset of `RTCPeerConnection` this module needs. */
export interface PeerConnectionLike {
  addTrack(track: MediaStreamTrack, stream: MediaStream): unknown;
  createDataChannel(label: string): DataChannelLike;
  createOffer(): Promise<{ sdp?: string; type: string }>;
  setLocalDescription(desc: { sdp?: string; type: string }): Promise<void>;
  setRemoteDescription(desc: { sdp: string; type: 'answer' }): Promise<void>;
  close(): void;
  localDescription: { sdp?: string; type: string } | null;
  ontrack: ((event: { streams: MediaStream[] }) => void) | null;
}

/** Mirrors `../api.ts`'s `VoiceMintToken` — duplicated (not imported) so this module's own mint
 *  dependency stays whatever shape the caller wants to inject; `createVoiceSession`'s default
 *  wiring adapts the real `mintVoiceToken()` response to it. */
export interface VoiceMintTokenLike {
  value: string;
  /** Unix epoch SECONDS (not milliseconds) — mirrors the provider's ephemeral-token expiry field.
   *  Compare against `Date.now() / 1000`, never `Date.now()` directly. */
  expiresAt: number;
}

export interface VoiceSessionDeps {
  /** Mint a fresh ephemeral token. Called on every (re)connect, including re-mint rotation and
   *  reconnect retries — never cached across calls by this module (the daemon route's own rate cap
   *  is the throttle). */
  mint: () => Promise<VoiceMintTokenLike>;
  createPeerConnection: () => PeerConnectionLike;
  getUserMedia: () => Promise<MediaStream>;
  /** POST the local SDP offer text to the provider and resolve the answer SDP text. Encapsulated
   *  as one function (rather than a raw `fetch` dependency) so tests never need to fake `fetch`
   *  or a `Response` object — just resolve/reject a string. LOW batch: `signal` is an optional
   *  `AbortSignal` this module ties to a 15s send timeout AND to `disconnect()`/a superseding
   *  connect attempt — implementations that ignore it still work (fine for tests), but the real
   *  browser wiring passes it straight to `fetch`. */
  postSdpOffer: (ephemeralKey: string, offerSdp: string, signal?: AbortSignal) => Promise<string>;
  attachRemoteStream: (stream: MediaStream) => void;
  stopPlayback: () => void;
  /** CRITICAL-2: resume local playback of the shared `<audio>` element. Called every time a fresh
   *  response actually starts (`response.created`) — cheap/idempotent when playback was never
   *  paused, and the ONLY thing that un-pauses it after `stopPlayback()` paused it for a barge-in
   *  (see that field's doc comment: nothing else ever calls `.play()` again, so without this every
   *  response after the FIRST barge-in would play into a permanently-paused element). */
  resumePlayback: () => void;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => VoiceTimerHandle;
  clearTimer: (handle: VoiceTimerHandle) => void;
}

// =============================================================================
// Public event surface + options
// =============================================================================

export interface VoiceSessionErrorInfo {
  /** `mic-denied` — `getUserMedia` was denied. `mint-failed` — the daemon mint call itself failed
   *  (rate limit, flag off, etc). `connect-failed` — everything AFTER a successful mint failed:
   *  building the peer connection, the SDP offer/answer exchange, or a provider `error` event that
   *  wasn't one of the known-benign codes. `reconnect-failed` — the bounded reconnect/rotation retry
   *  was exhausted. Kept as four distinct codes (rather than folding SDP failures into
   *  `mint-failed`) so the caller can tell "the daemon route is the problem" apart from "the
   *  provider itself rejected the connection". */
  code: 'mic-denied' | 'mint-failed' | 'connect-failed' | 'reconnect-failed';
  message: string;
  /** Set on errors the caller should treat as "give up on voice for this session, fall back to the
   *  text composer" — the bounded-retry and mic-denied paths both set this; a single transient send
   *  failure never would (this module has none of those — every send is fire-and-forget over an
   *  already-open data channel). */
  fallbackToText?: boolean;
}

export interface ReconnectedInfo {
  /** The recap text carried into the new session's opening context, or `''` when the caller
   *  supplied no `getRecap` (or it returned empty) and this was an unexpected-drop reconnect rather
   *  than a proactive rotation. */
  recap: string;
}

export interface VoiceSessionOptions {
  onStateChange?: (state: VoiceState, previous: VoiceState) => void;
  /** Live caption text — `response.output_audio_transcript.delta` (assistant) or
   *  `conversation.item.input_audio_transcription.delta` (user) chunks, in wire order, tagged with
   *  which side produced them. The user-transcription event only fires when the session has input
   *  transcription enabled — mint (`src/voice-token.ts`) doesn't request it today, so in practice
   *  every caption is currently `'assistant'`; the handler stays wired and tagged `'user'` so it
   *  activates for free the day concern 07/05 turns on `input_audio_transcription` server-side.
   *  Optional server behavior either way — callers should treat captions as a nice-to-have, never a
   *  required signal. */
  onCaption?: (text: string, speaker: 'assistant' | 'user') => void;
  onFunctionCall?: (call: PendingFunctionCall) => void;
  onError?: (error: VoiceSessionErrorInfo) => void;
  /** Fired after a successful reconnect — proactive rotation (with `recap`) or an unexpected-drop
   *  recovery (recap `''`, since only rotation carries context forward). Concern 08's HUD notice
   *  hangs off this. */
  onReconnected?: (info: ReconnectedInfo) => void;
  /** Rolling summary of the conversation so far, read fresh at rotation time (not cached) — the
   *  caller (concern 07/08) owns how it's built. Absent/empty means no recap text is injected. */
  getRecap?: () => string;
  /** The bound console agentId, folded into the carry-over injection text alongside the recap so
   *  the new session's opening context still names which agent it's driving. */
  agentId?: string;
  /** Proactive re-mint delay from connect time. Default 55 minutes (DESIGN.md "Lifecycle" row: the
   *  provider's cap is 60 minutes). Exposed for tests — production callers should leave it unset. */
  reMintAfterMs?: number;
}

/** One batch of `conversation.item.create` payloads to inject, plus the `response.create` that
 *  follows once they've all been sent — concern 07's async-ack completion narrations queue through
 *  this shape. Kept as `unknown` item payloads: this module doesn't know or care about realtime
 *  conversation-item schemas, only that "send these, then ask for a response" must wait for
 *  quiescence. */
export type InjectionItem = unknown;

// =============================================================================
// Internal error markers (establishConnection's failure taxonomy — see MINOR-11/MAJOR-5)
// =============================================================================

/** Thrown by `establishConnection` when `deps.mint()` itself fails — distinguishes a mint-side
 *  failure (daemon route: rate limit, flag off, auth) from anything that fails AFTER a successful
 *  mint (peer connection / SDP exchange), which callers report as `connect-failed` instead. */
class VoiceMintError extends Error {}

/** Thrown by `establishConnection` when a `disconnect()` (or a newer connect/rotate/reconnect
 *  attempt) invalidated this attempt's epoch while it was still in flight. Callers catch this and
 *  bail out completely silently — no `onError`, no state mutation — since the operation this
 *  attempt represents no longer applies to anything the caller cares about. */
class EpochStaleError extends Error {}

// =============================================================================
// VoiceSession
// =============================================================================

export class VoiceSession {
  private state: VoiceState = 'idle';
  private pc: PeerConnectionLike | undefined;
  private dataChannel: DataChannelLike | undefined;
  private micStream: MediaStream | undefined;
  private readonly injectionQueue: InjectionItem[][] = [];
  private reMintPending = false;
  private reMintTimer: VoiceTimerHandle | undefined;
  /** True once `connect()` (or a rotation/reconnect) has a live connection. Guards
   *  `handleUnexpectedDisconnect` from firing on a data-channel close this module itself caused
   *  (`disconnect()`, or tearing down mid-rotation). */
  private connected = false;
  /** Reentrancy guard for `connect()` (MINOR-14) — a second call while the first is still
   *  establishing (double-click, duplicate mount effect, etc.) is a no-op rather than racing two
   *  connection attempts against each other. */
  private connecting = false;

  /** Bumped by `disconnect()` and at the start of every (re)connect attempt (`connect`,
   *  `rotateSession`, `attemptReconnect`). Each attempt captures the value at its own start and
   *  checks it after every `await` inside `establishConnection`; a mismatch means some OTHER,
   *  later event (an explicit `disconnect()`, or a newer attempt superseding this one) has already
   *  decided what should happen, so this attempt bails out silently instead of resurrecting a
   *  connection nobody asked for anymore (MAJOR-5: a `disconnect()` mid-connect/rotate/reconnect
   *  no longer leaves `connected=true`, a rescheduled re-mint timer, or a leaked `RTCPeerConnection`
   *  behind it). */
  private epoch = 0;

  /** Count of `response.create` sends not yet matched by a `response.done` (see the module doc
   *  comment's "response.done correlation" section, and CRITICAL-1). Only reaches zero — and only
   *  then does a `response.done` server event become a `response-done` reducer event — once every
   *  response this module asked for has actually completed. */
  private outstandingResponses = 0;

  /** What triggered the response currently (or about to be) in flight — set at the three places a
   *  `response.create` is actually requested: `pttRelease` ('user'), `flushInjectionQueue`
   *  ('injection'), and `sendFunctionOutput`'s ack ('injection'). Defaults to 'user': the only way a
   *  function call can arrive at all is after SOME response.create, which will always have already
   *  set this first.
   *
   *  MINOR-4: this single mutable field is only a PROVISIONAL trigger at send time — it is NOT
   *  itself read when a function call arrives (see `pendingTriggerQueue`/`responseTriggerById`
   *  below). Without per-response correlation, two function calls belonging to the SAME
   *  user-triggered wrapping response — one arriving after the dispatcher has already acked the
   *  first (which flips this field to 'injection' for the ack's own, unrelated response.create) —
   *  would have the second wrongly stamped 'injection' and fail-closed-blocked by the human-turn
   *  gate, even though the operator's own speech is what produced BOTH calls. */
  private currentTrigger: 'user' | 'injection' = 'user';

  /** FIFO of triggers for `response.create` sends not yet claimed by a `response.created`'s
   *  `response.id` (MINOR-4). A single reliable, ordered WebRTC data channel means response.create
   *  sends and the server's `response.created` acks arrive in the same relative order, so shifting
   *  this queue on every `response.created` correctly pairs each new response with the trigger that
   *  was active at the moment its creation was requested — independent of any LATER currentTrigger
   *  flip from an ack sent while that response is still open. */
  private pendingTriggerQueue: Array<'user' | 'injection'> = [];

  /** Settled `response.id -> trigger` mapping, populated once a `response.created` event claims an
   *  entry off `pendingTriggerQueue` and consulted by every `function_call_arguments.done` event
   *  carrying that same `response_id` — so ALL function calls belonging to one response are
   *  attributed to whatever triggered that response, however many there are and however long the
   *  response stays open. Cleared once that response's own `response.done` arrives. Residual: if a
   *  future provider build ever omits `response_id` from `function_call_arguments.done` (the
   *  documented OpenAI Realtime API shape includes it as of writing), this module falls back to the
   *  provisional `currentTrigger` field above rather than losing the event entirely. */
  private responseTriggerById = new Map<string, 'user' | 'injection'>();

  /** Best-effort target for the barge-in `conversation.item.truncate` (MINOR-9) — the most
   *  recently-seen assistant audio item's id/content-index, and the wall-clock time its first delta
   *  arrived. Reset whenever every outstanding response completes, so a stale item id never bleeds
   *  into a later, unrelated response. */
  private activeAudioItemId: string | undefined;
  private activeAudioContentIndex: number | undefined;
  private activeAudioStartedAt: number | undefined;

  /** Flapping-channel tracking (MINOR-7): incidents (unexpected data-channel closes) within 60s of
   *  the previous one count as part of the same streak, even though each individual incident's own
   *  bounded retry might still succeed. Past a threshold this module stops silently re-minting and
   *  surfaces the instability instead. */
  private consecutiveIncidentCount = 0;
  private lastIncidentAt: number | undefined;
  private static readonly INCIDENT_WINDOW_MS = 60_000;
  private static readonly MAX_CONSECUTIVE_INCIDENTS = 3;
  private static readonly RECONNECT_ATTEMPT_DELAY_MS = 500;
  private static readonly SDP_POST_TIMEOUT_MS = 15_000;

  /** CRITICAL-1: a `response.create` that `sendRaw` deferred because a wrapping response was still
   *  active (`outstandingResponses > 0`) at send time — holds the trigger that was live when the
   *  send was REQUESTED (an ack, always 'injection' in practice, but kept general). Sent for real
   *  the moment `handleServerEvent`'s `response.done` case brings `outstandingResponses` back to
   *  zero. Cleared (without ever sending) by a barge-in (`pttPress`) or a reset/disconnect — a
   *  superseded turn must never have its deferred continuation fire into whatever comes next. */
  private deferredResponseCreate: { trigger: 'user' | 'injection' } | undefined;

  /** LOW batch: the AbortController backing the current SDP POST's 15s timeout — aborted by
   *  `disconnect()` (hanging up mid-connect shouldn't leave a POST in flight) and superseded by the
   *  next `establishConnection` attempt's own controller. */
  private sdpAbortController: AbortController | undefined;

  constructor(
    private readonly deps: VoiceSessionDeps,
    private readonly opts: VoiceSessionOptions = {},
  ) {}

  getState(): VoiceState {
    return this.state;
  }

  /** MEDIUM-4: whether this session has ever completed a connection (as opposed to still being on
   *  its very first, never-yet-successful `connect()` attempt). `VoiceCallContext.tsx`'s
   *  `shouldEndCall` decision uses this to distinguish "nothing to keep alive yet" (always end the
   *  call on any error before this is ever true) from "already live, only end for a genuinely
   *  terminal error" (once it is). */
  isConnected(): boolean {
    return this.connected;
  }

  /** GAP-1: `opts.agentId` is normally fixed at construction, but a call can start before any
   *  console agent is bound (concern 07/08's bootstrap path) — without a way to update it, a
   *  rotation/reconnect's carry-over text (`buildCarryOverText`) would permanently render a blank
   *  "Bound console agent:" line even after the bind happens mid-call. The provider calls this the
   *  moment `useVoiceDispatcher`'s `onAgentBound` fires, so the NEXT rotation (proactive re-mint or
   *  an unexpected-disconnect reconnect) carries the real id forward. */
  setAgentId(agentId: string | undefined): void {
    this.opts.agentId = agentId;
  }

  // ---------------------------------------------------------------------------
  // Connect / disconnect
  // ---------------------------------------------------------------------------

  /** Mic permission and mint/connect failures are distinct, terminal error codes — neither retries
   *  on its own (DESIGN.md "Failure modes" row: "no re-prompt loop"). The caller decides whether to
   *  offer a retry affordance. A second concurrent call while the first is still in flight is a
   *  silent no-op (MINOR-14). */
  async connect(): Promise<void> {
    if (this.connecting || this.connected) return;
    this.connecting = true;
    const myEpoch = ++this.epoch;
    try {
      let mic: MediaStream;
      try {
        mic = await this.deps.getUserMedia();
      } catch {
        if (myEpoch === this.epoch) this.opts.onError?.({ code: 'mic-denied', message: 'Microphone access was denied.' });
        return;
      }
      if (myEpoch !== this.epoch) {
        // disconnect() (or a newer attempt) fired while awaiting mic permission — this stream is
        // ours alone and nobody else will stop it.
        for (const track of mic.getTracks()) track.stop();
        return;
      }
      // Hot-mic privacy (MINOR-8): the mic stays muted except while PTT is actually held.
      for (const track of mic.getAudioTracks()) track.enabled = false;
      this.micStream = mic;
      try {
        await this.establishConnection(mic, myEpoch);
      } catch (err) {
        if (myEpoch !== this.epoch || err instanceof EpochStaleError) return; // bail silently
        // HIGH-3: a genuine mint/connect failure never becomes a live session — stop the mic here
        // too (previously only the bounded-reconnect give-up path did this), so a failed initial
        // connect doesn't leave the device held open with nothing to show for it.
        for (const track of this.micStream?.getTracks() ?? []) track.stop();
        this.micStream = undefined;
        this.opts.onError?.({
          code: err instanceof VoiceMintError ? 'mint-failed' : 'connect-failed',
          message: err instanceof Error ? err.message : 'Failed to start the voice session.',
        });
        return;
      }
      if (myEpoch !== this.epoch) {
        this.teardownConnection(); // superseded mid-establish — undo what we just wired up
        return;
      }
      this.connected = true;
      this.scheduleReMint();
    } finally {
      this.connecting = false;
    }
  }

  disconnect(): void {
    this.epoch++; // invalidate any in-flight connect/rotate/reconnect
    this.connected = false;
    this.sdpAbortController?.abort(); // LOW batch: cancel a hanging SDP POST rather than let it run
    this.sdpAbortController = undefined;
    this.deferredResponseCreate = undefined; // CRITICAL-1: nothing left to continue into
    // Clear the injection queue and the re-mint flag BEFORE dispatching 'reset': if a batch were
    // still queued, `dispatch`'s `onQuiescent()` (fired because reset lands on `idle`) would flush
    // it straight through the about-to-be-torn-down data channel and leave `getState()` reporting
    // `awaitingResponse` right after a disconnect instead of `idle`.
    this.injectionQueue.length = 0;
    this.reMintPending = false;
    this.dispatch({ type: 'reset' }); // stale-HUD fix: goes through onStateChange, stops local playback
    if (this.reMintTimer !== undefined) {
      this.deps.clearTimer(this.reMintTimer);
      this.reMintTimer = undefined;
    }
    this.teardownConnection();
    for (const track of this.micStream?.getTracks() ?? []) track.stop();
    this.micStream = undefined;
    this.outstandingResponses = 0;
    this.pendingTriggerQueue = []; // MINOR-4: stale queue entries from the torn-down session
    this.responseTriggerById.clear();
    this.activeAudioItemId = undefined;
    this.activeAudioContentIndex = undefined;
    this.activeAudioStartedAt = undefined;
    this.consecutiveIncidentCount = 0;
    this.lastIncidentAt = undefined;
  }

  // ---------------------------------------------------------------------------
  // PTT
  // ---------------------------------------------------------------------------

  pttPress(): void {
    const responseActive = this.state === 'awaitingResponse' || this.state === 'speaking' || this.state === 'toolPending';
    if (responseActive) this.sendBargeInTruncate();
    // CRITICAL-1: a barge-in supersedes any ack continuation still waiting on the wrapping
    // response's response.done — that continuation must never fire into whatever the user is
    // about to say next (it would violate rule (b): response.create must never be emitted while
    // userRecording). Safe to clear unconditionally even when nothing was pending.
    this.deferredResponseCreate = undefined;
    // Hot-mic privacy (MINOR-8): unmute for the duration of the hold.
    for (const track of this.micStream?.getAudioTracks() ?? []) track.enabled = true;
    this.dispatch({ type: 'ptt-press' });
  }

  pttRelease(): void {
    this.currentTrigger = 'user'; // this turn's response.create (if any) is user-triggered (MAJOR-3)
    this.dispatch({ type: 'ptt-release' });
    // Hot-mic privacy (MINOR-8): mute again the instant the user lets go.
    for (const track of this.micStream?.getAudioTracks() ?? []) track.enabled = false;
  }

  /** Best-effort `conversation.item.truncate` alongside the barge-in `response.cancel` (MINOR-9) —
   *  tells the server how much of the in-flight assistant audio item was actually heard before the
   *  user talked over it. `audio_end_ms` is best-effort: if we never got a delta with `item_id`
   *  attached (transcription not enabled, or barge-in landed before the first delta), there's no
   *  item to target and this is skipped entirely; when we DO have an item, `0` is used if timing is
   *  unavailable — truncating everything is still strictly better than leaving the model's context
   *  claiming the user heard audio that was in fact cancelled. */
  private sendBargeInTruncate(): void {
    if (!this.activeAudioItemId) return;
    const playedMs = this.activeAudioStartedAt !== undefined ? Math.max(0, this.deps.now() - this.activeAudioStartedAt) : 0;
    this.sendRaw({
      type: 'conversation.item.truncate',
      item_id: this.activeAudioItemId,
      content_index: this.activeAudioContentIndex ?? 0,
      audio_end_ms: playedMs,
    });
    this.activeAudioItemId = undefined;
    this.activeAudioContentIndex = undefined;
    this.activeAudioStartedAt = undefined;
  }

  // ---------------------------------------------------------------------------
  // Server events
  // ---------------------------------------------------------------------------

  /** Public entry point for a parsed realtime server event — tests call this directly; the real
   *  data-channel wiring (`establishConnection`) JSON-parses the wire message and calls this. */
  handleServerEvent(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || typeof (raw as { type?: unknown }).type !== 'string') return;
    const evt = raw as RealtimeServerEvent;
    switch (evt.type) {
      case 'response.created': {
        // MINOR-4: claim this response's slot in the trigger queue — the trigger that was active
        // when its response.create was SENT, not whatever currentTrigger happens to hold now.
        const responseId = extractResponseId(evt);
        const trigger = this.pendingTriggerQueue.shift() ?? this.currentTrigger;
        if (responseId) this.responseTriggerById.set(responseId, trigger);
        this.dispatch({ type: 'response-started' });
        // CRITICAL-2: a fresh response is starting — resume local playback in case the PREVIOUS
        // turn ended in a barge-in (`stopPlayback()` paused the shared <audio> element and nothing
        // else ever un-pauses it). Idempotent/cheap when playback was never paused to begin with.
        // But NOT while the user is recording: if they barged in again inside the RTT window before
        // this `response.created` landed, un-pausing would play the about-to-be-cancelled response's
        // buffered frames over the user's new utterance.
        if (this.state !== 'userRecording') this.deps.resumePlayback();
        return;
      }
      case 'response.output_audio_transcript.delta':
        if (typeof evt.delta === 'string') this.opts.onCaption?.(evt.delta, 'assistant');
        if (typeof evt.item_id === 'string') this.activeAudioItemId = evt.item_id;
        if (typeof evt.content_index === 'number') this.activeAudioContentIndex = evt.content_index;
        if (this.activeAudioStartedAt === undefined) this.activeAudioStartedAt = this.deps.now();
        return;
      case 'conversation.item.input_audio_transcription.delta':
        // Optional user-side transcription — surfaced through the same caption channel when
        // present; some sessions won't have it enabled at all (DESIGN.md: "treat captions as
        // optional"; see VoiceSessionOptions.onCaption for why this is currently always dormant).
        if (typeof evt.delta === 'string') this.opts.onCaption?.(evt.delta, 'user');
        return;
      case 'response.function_call_arguments.done': {
        // MINOR-4: correlate by this event's own response_id against the settled map — falls back
        // to the provisional currentTrigger only when response_id is absent (residual, see the
        // responseTriggerById doc comment above).
        // LOW batch: fail CLOSED on the residual no-response_id case (consistent with MINOR-3's
        // doctrine at the decision layer) — default to 'injection', never to whatever
        // `currentTrigger` happens to hold, so an uncorrelated call is blocked pending explicit
        // user confirmation rather than silently sailing through as if the user just asked for it.
        const responseId = typeof evt.response_id === 'string' ? evt.response_id : undefined;
        const trigger = (responseId !== undefined ? this.responseTriggerById.get(responseId) : undefined) ?? 'injection';
        const call: PendingFunctionCall = {
          callId: typeof evt.call_id === 'string' ? evt.call_id : '',
          name: typeof evt.name === 'string' ? evt.name : '',
          arguments: typeof evt.arguments === 'string' ? evt.arguments : '',
          trigger,
        };
        this.dispatch({ type: 'function-call-ready', call });
        this.opts.onFunctionCall?.(call);
        return;
      }
      case 'response.done': {
        // Correlate against outstanding response.create sends (see the module doc comment and
        // CRITICAL-1) — only forward to the reducer once every response this module asked for has
        // actually finished, so an unrelated wrapping response's completion can't be mistaken for a
        // synchronous ack's response completing.
        const responseId = extractResponseId(evt);
        if (responseId) this.responseTriggerById.delete(responseId); // MINOR-4: this response is done
        if (this.outstandingResponses > 0) this.outstandingResponses--;
        if (this.outstandingResponses === 0) {
          // CRITICAL-1: the wrapping response (or whichever response was last outstanding) has now
          // actually finished — if an ack's continuation was deferred waiting for exactly this
          // moment, send it for real now instead of dispatching `response-done` (the turn isn't
          // over; it's continuing). `sendRaw` sees outstandingResponses back at 0 and sends
          // immediately rather than deferring again.
          // The wrapping response's audio item is finished either way — clear its tracking BEFORE
          // firing a deferred continuation, or a barge-in during the continuation (before its own
          // first delta) would truncate the now-completed item with a wall-clock `audio_end_ms`
          // that exceeds the item's real duration (provider error, not benign → spurious teardown).
          this.activeAudioItemId = undefined;
          this.activeAudioContentIndex = undefined;
          this.activeAudioStartedAt = undefined;
          if (this.deferredResponseCreate) {
            const { trigger } = this.deferredResponseCreate;
            this.deferredResponseCreate = undefined;
            this.currentTrigger = trigger;
            this.sendRaw({ type: 'response.create' });
            return;
          }
          this.dispatch({ type: 'response-done' });
        }
        return;
      }
      case 'error': {
        const error = evt.error;
        const code =
          error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
            ? (error as { code: string }).code
            : undefined;
        if (code === 'conversation_already_has_active_response') {
          // CRITICAL-1 belt-and-braces: a response.create this module sent WAS rejected because a
          // response was already active (should be unreachable now that sendRaw defers instead of
          // sending in that situation, but a race or a future provider quirk could still trigger
          // it). Undo its optimistic bookkeeping — it will never receive a matching response.done —
          // so outstandingResponses/pendingTriggerQueue can't permanently overcount and wedge the
          // machine open forever.
          if (this.outstandingResponses > 0) this.outstandingResponses--;
          this.pendingTriggerQueue.pop();
        }
        if (code !== undefined && BENIGN_ERROR_CODES.has(code)) return; // routine gesture, not a failure
        const message =
          error && typeof error === 'object' && 'message' in error && typeof (error as { message?: unknown }).message === 'string'
            ? (error as { message: string }).message
            : 'The voice provider reported an error.';
        this.opts.onError?.({ code: 'connect-failed', message });
        return;
      }
      default:
        return; // forward-compatible: unrecognized event types are ignored, not errors
    }
  }

  // ---------------------------------------------------------------------------
  // Tool dispatcher surface (concern 07)
  // ---------------------------------------------------------------------------

  /** Send a function's output back to the model and — ONLY if the state is still `toolPending`
   *  (i.e. no `ptt-press` preempted it into `userRecording` in the meantime) — ask for the model's
   *  continuation. The `conversation.item.create` itself is unconditional: the tool's output always
   *  joins the conversation so it isn't lost even if the ack's `response.create` is withheld by
   *  rule (b); the next turn (PTT release, or a later injection flush) will surface it. */
  sendFunctionOutput(callId: string, output: unknown): void {
    this.sendRaw({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: typeof output === 'string' ? output : JSON.stringify(output),
      },
    });
    this.currentTrigger = 'injection'; // any function call the ack's response produces is agent-chained (MAJOR-3)
    this.dispatch({ type: 'ack-sent' });
  }

  /** Queue a batch of `conversation.item.create` payloads (+ a trailing `response.create`) for the
   *  next quiescent moment. Flushes immediately if already idle; otherwise waits — including
   *  through `userRecording` (rule b) and through any active response — for the state machine to
   *  return to `idle` on its own. Only one batch is in flight at a time: a second `queueInjection`
   *  call while the first is still being answered waits for that response's own `response.done`
   *  to land the session back on `idle` before draining further. */
  queueInjection(items: InjectionItem[]): void {
    this.injectionQueue.push(items);
    if (this.state === 'idle') this.flushInjectionQueue();
  }

  // ---------------------------------------------------------------------------
  // Internal: dispatch / effects
  // ---------------------------------------------------------------------------

  private dispatch(event: VoiceEvent): void {
    const previous = this.state;
    const { state, effects } = nextVoiceState(previous, event);
    for (const effect of effects) this.applyEffect(effect);
    if (state !== previous) {
      this.state = state;
      this.opts.onStateChange?.(state, previous);
      if (state === 'idle') this.onQuiescent();
    }
  }

  private applyEffect(effect: VoiceEffect): void {
    if (effect.type === 'stop-playback') {
      this.deps.stopPlayback();
    } else {
      this.sendRaw(effect.payload);
    }
  }

  private sendRaw(payload: Record<string, unknown>): void {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') return; // dropped, not queued/retried
    if (payload.type === 'response.create') {
      if (this.outstandingResponses > 0) {
        // CRITICAL-1: a response is still active (its response.done hasn't arrived) — sending
        // response.create now would hit the provider's `conversation_already_has_active_response`
        // rejection. Defer the actual send until `handleServerEvent`'s 'response.done' case brings
        // outstandingResponses back to zero (at most the wrapping turn's own remaining duration —
        // never the whole fleet, and never a re-issued prompt: nothing here re-asks the model
        // anything, it just delays ONE already-decided send).
        this.deferredResponseCreate = { trigger: this.currentTrigger };
        return;
      }
      this.outstandingResponses++;
      // MINOR-4: record the trigger active AT SEND TIME — claimed off this FIFO by the matching
      // `response.created`'s response.id, so a later currentTrigger flip (an ack sent while this
      // response is still open) can never retroactively relabel it.
      this.pendingTriggerQueue.push(this.currentTrigger);
    }
    this.dataChannel.send(JSON.stringify(payload));
  }

  /** Called whenever the reducer lands the machine on `idle`. Injection flush takes priority over
   *  a pending re-mint: flushing moves the state straight back to `awaitingResponse`, so the re-mint
   *  check simply runs again the next time this method fires (after that flush's own response
   *  completes). */
  private onQuiescent(): void {
    if (this.injectionQueue.length > 0) {
      this.flushInjectionQueue();
      return;
    }
    if (this.reMintPending) {
      this.reMintPending = false;
      void this.rotateSession();
    }
  }

  /** Flush the oldest queued injection batch. Safe to call from anywhere (`onQuiescent`, right
   *  after a fresh connection is wired up, or a data channel's `onopen`) — it's a no-op unless the
   *  machine is actually `idle` AND the data channel is actually `open`. That second guard is
   *  MAJOR-6's fix: previously this ran unconditionally whenever the state happened to already be
   *  `idle`, including the window mid-rotation where `teardownConnection` has cleared
   *  `dataChannel` but the new one isn't wired up yet — `sendRaw` would silently drop every send,
   *  the batch would still be discarded from the queue, and `dispatch({type:'injection-flushed'})`
   *  would move the machine to `awaitingResponse` with no connection behind it. Now the batch stays
   *  queued until a data channel is genuinely there to receive it — `establishConnection` calls this
   *  again immediately after wiring up a fresh channel, and again from that channel's `onopen`, so a
   *  batch queued mid-rotation flushes as soon as the new connection is actually usable. */
  private flushInjectionQueue(): void {
    if (this.injectionQueue.length === 0) return;
    if (this.state !== 'idle') return;
    if (this.dataChannel?.readyState !== 'open') return;
    const batch = this.injectionQueue.shift();
    if (!batch) return;
    this.currentTrigger = 'injection'; // the response this flush requests is agent-triggered (MAJOR-3)
    for (const item of batch) this.sendRaw({ type: 'conversation.item.create', item });
    this.sendRaw({ type: 'response.create' });
    this.dispatch({ type: 'injection-flushed' });
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  /** Mint, build the peer connection + data channel, and complete the SDP offer/answer exchange.
   *  `myEpoch` is the caller's epoch snapshot at the moment it started this attempt — checked after
   *  every await so a `disconnect()` (or a newer attempt) firing mid-flight aborts this one instead
   *  of resurrecting a connection nobody wants anymore (MAJOR-5). The locally-created `pc` is closed
   *  in `finally` on ANY throw — mint failure, SDP failure, or an epoch go-stale — so a failed
   *  attempt never leaks a live `RTCPeerConnection` (MINOR-14). On success, resets the state machine
   *  through `dispatch({type:'reset'})` rather than a direct field assignment (MAJOR-4) — every
   *  prior state, not just the ones this module happens to expect, forces back to `idle` with a
   *  `onStateChange` notification (fixing a stale HUD on unexpected reconnect) and a stop-playback
   *  effect. NOTE: if a PTT was held when the connection this replaces went away, that hold is
   *  silently discarded here — rotation/reconnect always lands on `idle`, so releasing a PTT that
   *  was held across a rotation does nothing in the new session (no commit, no response.create).
   *  This is a documented limitation, not a bug: there is no meaningful way to resume a half-spoken
   *  utterance across a torn-down and rebuilt peer connection. */
  private async establishConnection(mic: MediaStream, myEpoch: number): Promise<void> {
    // HIGH-3: re-assert the hot-mic-privacy mute at the START of every (re)connect attempt, not
    // just `connect()`'s own first call. `rotateSession`/`attemptReconnect` reuse this SAME
    // MediaStream, whose tracks might still be `enabled: true` (a PTT held across the tear-down —
    // see the "documented limitation" note below), and this module resets to `idle` regardless of
    // what was happening before. Nothing else would otherwise re-mute a track already producing
    // audio into a torn-down/soon-to-be-rebuilt connection.
    for (const track of mic.getAudioTracks()) track.enabled = false;
    let token: VoiceMintTokenLike;
    try {
      token = await this.deps.mint(); // `token.value` (the ek_ secret) never leaves this scope
    } catch (err) {
      throw new VoiceMintError(err instanceof Error ? err.message : 'Failed to mint a voice token.');
    }
    if (myEpoch !== this.epoch) throw new EpochStaleError();

    const pc = this.deps.createPeerConnection();
    let succeeded = false;
    try {
      const track = mic.getAudioTracks()[0];
      if (track) pc.addTrack(track, mic);
      const dc = pc.createDataChannel('oai-events');
      dc.onmessage = (event) => {
        try {
          this.handleServerEvent(JSON.parse(event.data));
        } catch {
          // Malformed frame — ignore rather than throw across the data channel's own event loop.
        }
      };
      dc.onclose = () => {
        void this.handleUnexpectedDisconnect();
      };
      dc.onopen = () => {
        this.flushInjectionQueue(); // MAJOR-6's other flush trigger: production channels open async
      };
      pc.ontrack = (event) => {
        const [stream] = event.streams;
        if (stream) this.deps.attachRemoteStream(stream);
      };
      const offer = await pc.createOffer();
      if (myEpoch !== this.epoch) throw new EpochStaleError();
      await pc.setLocalDescription(offer);
      if (myEpoch !== this.epoch) throw new EpochStaleError();
      const offerSdp = pc.localDescription?.sdp ?? offer.sdp ?? '';
      // LOW batch: bound the SDP POST with a 15s timeout, and make it abortable by `disconnect()`
      // or a superseding (re)connect attempt — previously this had no timeout at all, so a hung
      // provider request could leave `connect()` (and the caller's "Connecting…" UI) stuck forever.
      // Uses the injected setTimer/clearTimer (not a raw AbortSignal.timeout) so this is directly
      // testable with the same fake-timer harness every other lifecycle test in this file uses.
      this.sdpAbortController?.abort(); // a stale attempt's controller, if any, is done either way
      const abortController = new AbortController();
      this.sdpAbortController = abortController;
      const timeoutHandle = this.deps.setTimer(() => abortController.abort(), VoiceSession.SDP_POST_TIMEOUT_MS);
      let answerSdp: string;
      try {
        answerSdp = await this.deps.postSdpOffer(token.value, offerSdp, abortController.signal);
      } finally {
        this.deps.clearTimer(timeoutHandle);
        if (this.sdpAbortController === abortController) this.sdpAbortController = undefined;
      }
      if (myEpoch !== this.epoch) throw new EpochStaleError();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      if (myEpoch !== this.epoch) throw new EpochStaleError();

      this.pc = pc;
      this.dataChannel = dc;
      this.outstandingResponses = 0;
      this.deferredResponseCreate = undefined; // CRITICAL-1: a fresh connection has nothing to continue
      this.pendingTriggerQueue = []; // MINOR-4: a fresh connection has no in-flight responses to correlate
      this.responseTriggerById.clear();
      this.activeAudioItemId = undefined;
      this.activeAudioContentIndex = undefined;
      this.activeAudioStartedAt = undefined;
      this.dispatch({ type: 'reset' });
      this.flushInjectionQueue(); // pick up anything queued during the connection gap (MAJOR-6)
      succeeded = true;
    } finally {
      if (!succeeded) {
        try {
          pc.close();
        } catch {
          // never opened / already closed — fine.
        }
      }
    }
  }

  private teardownConnection(): void {
    if (this.dataChannel) {
      this.dataChannel.onopen = null;
      this.dataChannel.onclose = null;
      this.dataChannel.onmessage = null;
      this.dataChannel.onerror = null;
      try {
        this.dataChannel.close();
      } catch {
        // already closed — fine.
      }
    }
    if (this.pc) {
      this.pc.ontrack = null;
      try {
        this.pc.close();
      } catch {
        // already closed — fine.
      }
    }
    this.dataChannel = undefined;
    this.pc = undefined;
  }

  private scheduleReMint(): void {
    if (this.reMintTimer !== undefined) this.deps.clearTimer(this.reMintTimer);
    const delay = this.opts.reMintAfterMs ?? 55 * 60_000;
    this.reMintTimer = this.deps.setTimer(() => this.onReMintDue(), delay);
  }

  /** Fires ~55 minutes in. Only rotates immediately from `idle` (quiescent) — otherwise sets a
   *  flag `onQuiescent` checks on every future transition into `idle`, so a re-mint due mid-sentence
   *  or mid-tool-call waits rather than yanking the session out from under the user (DESIGN.md
   *  "Lifecycle" row: "re-mint mid-sentence or mid-tool is a designed failure"). */
  private onReMintDue(): void {
    if (this.state === 'idle') {
      void this.rotateSession();
    } else {
      this.reMintPending = true;
    }
  }

  /** Proactive re-mint: tear down and rebuild the connection, then inject a carry-over summary (the
   *  caller's `getRecap()` plus the bound `agentId`) into the fresh session so it isn't amnesiac,
   *  and notify via `onReconnected`. Only ever called from a quiescent state (see `onReMintDue`).
   *  Guards against `micStream` having already been cleared by a concurrent `disconnect()` — without
   *  it, dereferencing the old non-null-asserted `micStream!` after `disconnect()` nulled it would
   *  throw inside `establishConnection` and surface as a spurious `reconnect-failed` right after a
   *  clean hangup (MAJOR-5). */
  private async rotateSession(): Promise<void> {
    const myEpoch = ++this.epoch;
    if (!this.micStream) return; // disconnect() already tore this down; nothing to rotate
    const recap = this.opts.getRecap?.() ?? '';
    this.teardownConnection();
    try {
      await this.establishConnection(this.micStream, myEpoch);
    } catch (err) {
      if (myEpoch !== this.epoch || err instanceof EpochStaleError) return; // bail silently
      for (const track of this.micStream?.getTracks() ?? []) track.stop();
      this.micStream = undefined;
      this.opts.onError?.({
        code: 'reconnect-failed',
        message: 'Could not rotate the voice session before its token expired.',
        fallbackToText: true,
      });
      return;
    }
    if (myEpoch !== this.epoch) {
      this.teardownConnection();
      return;
    }
    this.connected = true;
    if (recap) {
      this.sendRaw({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text: this.buildCarryOverText(recap) }],
        },
      });
    }
    this.scheduleReMint();
    this.opts.onReconnected?.({ recap });
  }

  private buildCarryOverText(recap: string): string {
    const agentPart = this.opts.agentId ? ` Bound console agent: ${this.opts.agentId}.` : '';
    return `[Voice session carried over from a prior connection.${agentPart}]\n${recap}`;
  }

  /** Token-expiry or a data-channel close mid-session: one silent reconnect attempt, and — only if
   *  THAT retry also fails — a second, final attempt before giving up, with a short delay between
   *  the two so a flapping channel doesn't hammer the provider back-to-back (MINOR-7). Two
   *  consecutive failures surface `onError` with `fallbackToText: true` (DESIGN.md "Lifecycle" row:
   *  "bounded retry, never silent-forever"). Either attempt succeeding resets the session with no
   *  error shown — reconnecting quietly is the whole point of "silent". Never fires for a close this
   *  module itself caused (`disconnect()`/rotation clear `dataChannel.onclose` before closing).
   *
   *  Incidents (calls to this method) within `INCIDENT_WINDOW_MS` of the previous one count toward
   *  the same flapping streak even when each incident's own bounded retry succeeds — a channel that
   *  keeps dropping and silently reconnecting is still broken from the user's point of view, just
   *  not in a way any single incident's retry counter would ever catch. Past
   *  `MAX_CONSECUTIVE_INCIDENTS`, this stops attempting reconnects for that incident entirely and
   *  surfaces the instability instead of re-minting forever. */
  private async handleUnexpectedDisconnect(): Promise<void> {
    if (!this.connected || !this.micStream) return;
    this.connected = false;

    const now = this.deps.now();
    this.consecutiveIncidentCount =
      this.lastIncidentAt !== undefined && now - this.lastIncidentAt <= VoiceSession.INCIDENT_WINDOW_MS
        ? this.consecutiveIncidentCount + 1
        : 1;
    this.lastIncidentAt = now;

    if (this.consecutiveIncidentCount > VoiceSession.MAX_CONSECUTIVE_INCIDENTS) {
      this.giveUpOnVoice('The voice connection is unstable and could not be kept alive.');
      return;
    }

    if (await this.attemptReconnect()) return;
    await this.delayBetweenReconnectAttempts();
    if (!this.micStream) return; // disconnect() ran during the delay
    if (await this.attemptReconnect()) return;
    if (!this.micStream) return; // disconnect() ran during the retry window — not a real failure
    this.giveUpOnVoice('The voice session was lost and could not be restored.');
  }

  private delayBetweenReconnectAttempts(): Promise<void> {
    return new Promise((resolve) => {
      this.deps.setTimer(() => resolve(), VoiceSession.RECONNECT_ATTEMPT_DELAY_MS);
    });
  }

  /** Give up on voice for this session: stop the mic (MINOR-14 — a terminal `reconnect-failed`
   *  means the caller is falling back to text, so the mic shouldn't stay hot) and surface the
   *  bounded, final error. */
  private giveUpOnVoice(message: string): void {
    for (const track of this.micStream?.getTracks() ?? []) track.stop();
    this.micStream = undefined;
    this.opts.onError?.({ code: 'reconnect-failed', message, fallbackToText: true });
  }

  private async attemptReconnect(): Promise<boolean> {
    const myEpoch = ++this.epoch;
    if (!this.micStream) return false;
    this.teardownConnection();
    try {
      await this.establishConnection(this.micStream, myEpoch);
    } catch {
      return false; // epoch-stale or a genuine failure — either way this attempt didn't succeed
    }
    if (myEpoch !== this.epoch) {
      this.teardownConnection();
      return false;
    }
    this.connected = true;
    this.scheduleReMint();
    this.opts.onReconnected?.({ recap: '' });
    return true;
  }
}

// =============================================================================
// Default (real-browser) wiring — the ONLY place this module touches actual browser APIs.
// =============================================================================

let sharedAudioEl: HTMLAudioElement | undefined;

function getSharedAudioEl(): HTMLAudioElement {
  if (!sharedAudioEl) {
    sharedAudioEl = document.createElement('audio');
    sharedAudioEl.autoplay = true;
  }
  return sharedAudioEl;
}

async function defaultPostSdpOffer(ephemeralKey: string, offerSdp: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ephemeralKey}`, 'Content-Type': 'application/sdp' },
    body: offerSdp,
    signal,
  });
  if (!res.ok) throw new Error(`voice: SDP exchange failed (${res.status})`);
  return res.text();
}

/** Real-browser dependency wiring. Imports `mintVoiceToken` from `../api.ts` lazily-by-reference
 *  (a plain function call, not a closed-over module cache) so nothing here holds the minted token
 *  past the single `mint()` call each connect/reconnect makes. */
export function createDefaultVoiceSessionDeps(mintFn: () => Promise<VoiceMintTokenLike>): VoiceSessionDeps {
  return {
    mint: mintFn,
    createPeerConnection: () => new RTCPeerConnection() as unknown as PeerConnectionLike,
    getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: true }),
    postSdpOffer: defaultPostSdpOffer,
    attachRemoteStream: (stream) => {
      getSharedAudioEl().srcObject = stream;
    },
    stopPlayback: () => {
      sharedAudioEl?.pause();
    },
    resumePlayback: () => {
      // CRITICAL-2: `.play()` on an already-playing element is a harmless no-op — this only
      // matters the first time it runs after `stopPlayback()` paused the element for a barge-in.
      const playResult = sharedAudioEl?.play();
      if (playResult && typeof playResult.catch === 'function') {
        playResult.catch(() => {
          // Autoplay rejected (no user-gesture context, etc.) — not a connection failure. The
          // element stays silent until the next response.created call retries this.
        });
      }
    },
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

/** Build a `VoiceSession` wired to real browser APIs. `mintFn` is still passed in (rather than this
 *  module importing `mintVoiceToken` itself) purely to avoid a hard import-time dependency on
 *  `../api.ts` for callers that already have their own mint wrapper (e.g. a test harness for
 *  concern 07/08) — production callers should pass `mintVoiceToken` from `../api.ts` unmodified. */
export default function createVoiceSession(mintFn: () => Promise<VoiceMintTokenLike>, opts?: VoiceSessionOptions): VoiceSession {
  return new VoiceSession(createDefaultVoiceSessionDeps(mintFn), opts);
}
