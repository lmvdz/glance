import { describe, expect, spyOn, test } from 'bun:test';
import {
  VoiceSession,
  nextVoiceState,
  type DataChannelLike,
  type PeerConnectionLike,
  type VoiceEvent,
  type VoiceMintTokenLike,
  type VoiceSessionDeps,
  type VoiceSessionOptions,
  type VoiceState,
} from './voiceSession';

// =================================================================================================
// Fakes
// =================================================================================================

/** A fake data channel that records every `send` call and starts already `open` (tests drive
 *  `onmessage` manually rather than needing a real connection to reach "open"). */
function makeFakeDataChannel(): DataChannelLike & { sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    readyState: 'open',
    send(data: string) {
      sent.push(JSON.parse(data));
    },
    close() {
      this.readyState = 'closed';
    },
    onopen: null,
    onclose: null,
    onmessage: null,
    onerror: null,
  };
}

/** Signature mirrors `VoiceSessionDeps['postSdpOffer']` (LOW batch: the SDP POST timeout/abort). */
type PostSdpOfferImpl = (ephemeralKey: string, offerSdp: string, signal?: AbortSignal) => Promise<string>;

function makeFakePeerConnection(dc: DataChannelLike): PeerConnectionLike {
  return {
    addTrack: () => undefined,
    createDataChannel: () => dc,
    createOffer: async () => ({ sdp: 'fake-offer-sdp', type: 'offer' }),
    setLocalDescription: async () => undefined,
    setRemoteDescription: async () => undefined,
    close: () => undefined,
    localDescription: { sdp: 'fake-offer-sdp', type: 'offer' },
    ontrack: null,
    connectionState: 'connected',
    onconnectionstatechange: null,
  };
}

/** The fake track's `enabled` is a real mutable property (not stubbed) so MINOR-8's hot-mic-privacy
 *  toggling (`track.enabled = true/false` on PTT press/release) is directly observable in tests. */
function makeFakeMediaStream(): MediaStream & { track: MediaStreamTrack & { enabled: boolean } } {
  const track = { stop: () => undefined, enabled: true } as unknown as MediaStreamTrack & { enabled: boolean };
  return {
    track,
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream & { track: MediaStreamTrack & { enabled: boolean } };
}

interface Harness {
  session: VoiceSession;
  deps: VoiceSessionDeps;
  dataChannels: (DataChannelLike & { sent: Record<string, unknown>[] })[];
  /** Every fake peer connection ever created, in order — lets tests drive
   *  `onconnectionstatechange` (silent ICE death detection). */
  pcs: PeerConnectionLike[];
  mintCalls: number;
  mintImpl: () => Promise<VoiceMintTokenLike>;
  postSdpOfferImpl: () => Promise<string>;
  getUserMediaImpl: () => Promise<MediaStream>;
  getUserMediaCalls: number;
  timers: { fn: () => void; ms: number; handle: number }[];
  nowValue: number;
  stopPlaybackCalls: number;
  resumePlaybackCalls: number;
  states: VoiceState[];
  errors: { code: string; message: string; fallbackToText?: boolean }[];
  reconnected: { recap: string }[];
  captions: { text: string; speaker: 'assistant' | 'user' }[];
  functionCalls: { callId: string; name: string; arguments: string; trigger: 'user' | 'injection' }[];
  /** Every `MediaStream` this harness's `getUserMedia` has ever handed out, in order — lets tests
   *  inspect (and assert on) mic-track `.enabled` toggling (MINOR-8) and confirm a stream's tracks
   *  were actually stopped on teardown/give-up paths. */
  micStreams: (MediaStream & { track: MediaStreamTrack & { enabled: boolean; stopped?: boolean } })[];
}

function makeHarness(optsOverride: VoiceSessionOptions = {}): Harness {
  const dataChannels: (DataChannelLike & { sent: Record<string, unknown>[] })[] = [];
  const pcs: PeerConnectionLike[] = [];
  let mintCalls = 0;
  let mintImpl: () => Promise<VoiceMintTokenLike> = async () => ({ value: `ek_fake_${++mintCalls}`, expiresAt: Date.now() + 3600_000 });
  let postSdpOfferImpl: PostSdpOfferImpl = async () => 'fake-answer-sdp';
  const micStreams: (MediaStream & { track: MediaStreamTrack & { enabled: boolean; stopped?: boolean } })[] = [];
  let getUserMediaCalls = 0;
  let getUserMediaImpl: () => Promise<MediaStream> = async () => {
    const stream = makeFakeMediaStream();
    (stream.track as { stop: () => void }).stop = () => {
      (stream.track as unknown as { stopped: boolean }).stopped = true;
    };
    micStreams.push(stream);
    return stream;
  };
  const timers: { fn: () => void; ms: number; handle: number }[] = [];
  let timerHandleSeq = 0;
  let nowValue = 0;
  let stopPlaybackCalls = 0;
  let resumePlaybackCalls = 0;

  const states: VoiceState[] = [];
  const errors: { code: string; message: string; fallbackToText?: boolean }[] = [];
  const reconnected: { recap: string }[] = [];
  const captions: { text: string; speaker: 'assistant' | 'user' }[] = [];
  const functionCalls: { callId: string; name: string; arguments: string; trigger: 'user' | 'injection' }[] = [];

  const deps: VoiceSessionDeps = {
    mint: () => mintImpl(),
    createPeerConnection: () => {
      const dc = makeFakeDataChannel();
      dataChannels.push(dc);
      const pc = makeFakePeerConnection(dc);
      pcs.push(pc);
      return pc;
    },
    getUserMedia: () => {
      getUserMediaCalls++;
      return getUserMediaImpl();
    },
    postSdpOffer: (key, sdp, signal) => postSdpOfferImpl(key, sdp, signal),
    attachRemoteStream: () => undefined,
    stopPlayback: () => {
      stopPlaybackCalls++;
    },
    resumePlayback: () => {
      resumePlaybackCalls++;
    },
    now: () => nowValue,
    setTimer: (fn, ms) => {
      const handle = ++timerHandleSeq;
      timers.push({ fn, ms, handle });
      return handle;
    },
    clearTimer: (handle) => {
      const idx = timers.findIndex((t) => t.handle === handle);
      if (idx >= 0) timers.splice(idx, 1);
    },
  };

  const opts: VoiceSessionOptions = {
    onStateChange: (state) => states.push(state),
    onError: (e) => errors.push(e),
    onReconnected: (info) => reconnected.push(info),
    onCaption: (text, speaker) => captions.push({ text, speaker }),
    onFunctionCall: (call) => functionCalls.push(call),
    ...optsOverride,
  };

  const session = new VoiceSession(deps, opts);

  return {
    session,
    deps,
    dataChannels,
    pcs,
    get mintCalls() {
      return mintCalls;
    },
    set mintImpl(fn: () => Promise<VoiceMintTokenLike>) {
      mintImpl = fn;
    },
    get mintImpl() {
      return mintImpl;
    },
    set postSdpOfferImpl(fn: PostSdpOfferImpl) {
      postSdpOfferImpl = fn;
    },
    get postSdpOfferImpl() {
      return postSdpOfferImpl;
    },
    set getUserMediaImpl(fn: () => Promise<MediaStream>) {
      getUserMediaImpl = fn;
    },
    get getUserMediaImpl() {
      return getUserMediaImpl;
    },
    get getUserMediaCalls() {
      return getUserMediaCalls;
    },
    timers,
    set nowValue(v: number) {
      nowValue = v;
    },
    get nowValue() {
      return nowValue;
    },
    get stopPlaybackCalls() {
      return stopPlaybackCalls;
    },
    get resumePlaybackCalls() {
      return resumePlaybackCalls;
    },
    states,
    errors,
    reconnected,
    captions,
    functionCalls,
    micStreams,
  } as unknown as Harness;
}

/** The most recent fake data channel's recorded sends. */
function lastSent(h: Harness): Record<string, unknown>[] {
  return h.dataChannels[h.dataChannels.length - 1]!.sent;
}

/** The most recently-acquired fake mic stream's (only) audio track. */
function lastMicTrack(h: Harness): MediaStreamTrack & { enabled: boolean; stopped?: boolean } {
  return h.micStreams[h.micStreams.length - 1]!.track;
}

/** Drains enough microtask ticks for an `establishConnection` chain (mint -> createOffer ->
 *  setLocalDescription -> postSdpOffer -> setRemoteDescription, each a separate `await`) to fully
 *  settle, including a `handleUnexpectedDisconnect` that chains TWO such attempts plus the delay
 *  between them. Generous on purpose — cheap, and this module's own promise chains are the only
 *  thing running. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Find and fire the (single) pending timer scheduled with the given delay — used to drive
 *  `delayBetweenReconnectAttempts` (MINOR-7's inter-attempt delay), which the harness's fake
 *  `setTimer` records like any other timer but never fires on its own. */
function fireTimer(h: Harness, ms: number): void {
  const timer = h.timers.find((t) => t.ms === ms);
  if (!timer) throw new Error(`no pending timer with ms=${ms} (have: ${h.timers.map((t) => t.ms).join(', ')})`);
  timer.fn();
}

/** Simulate a realtime server event arriving on the (most recent) data channel. */
function serverEvent(h: Harness, event: Record<string, unknown>): void {
  h.session.handleServerEvent(event);
}

// =================================================================================================
// Pure reducer — full state x event transition table
// =================================================================================================

const ALL_STATES: VoiceState[] = ['idle', 'userRecording', 'awaitingResponse', 'speaking', 'toolPending'];
const SAMPLE_CALL = { callId: 'call-1', name: 'fleet_status', arguments: '{}', trigger: 'user' as const };
const NON_PTT_EVENTS: VoiceEvent[] = [
  { type: 'response-started' },
  { type: 'function-call-ready', call: SAMPLE_CALL },
  { type: 'response-done' },
  { type: 'ack-sent' },
  { type: 'injection-flushed' },
];

test('nextVoiceState: exhaustive table — every state reacts to every event without throwing and returns a defined next state', () => {
  for (const state of ALL_STATES) {
    for (const event of [
      ...NON_PTT_EVENTS,
      { type: 'ptt-press' } as VoiceEvent,
      { type: 'ptt-release' } as VoiceEvent,
      { type: 'ptt-abort' } as VoiceEvent,
      { type: 'reset' } as VoiceEvent,
    ]) {
      const result = nextVoiceState(state, event);
      expect(ALL_STATES).toContain(result.state);
      expect(Array.isArray(result.effects)).toBe(true);
    }
  }
});

// -------------------------------------------------------------------------------------------------
// MINOR-13: the designated-noop cells, pinned exactly (state unchanged, zero effects) rather than
// merely asserting the result is SOME valid state — every cell below is a branch that intentionally
// falls to `default: return noop(state)` in `nextVoiceState`, enumerated by reading the switch table
// directly (not inferred from behavior).
// -------------------------------------------------------------------------------------------------

const NOOP_CELLS: Array<{ state: VoiceState; event: VoiceEvent }> = [
  // idle: only ptt-press and injection-flushed transition; everything else (including ptt-release —
  // there's no recording to release) is a no-op.
  // (idle + response-started is NOT here: it resyncs to 'speaking' — see its dedicated test.)
  { state: 'idle', event: { type: 'ptt-release' } },
  { state: 'idle', event: { type: 'ptt-abort' } },
  { state: 'idle', event: { type: 'function-call-ready', call: SAMPLE_CALL } },
  { state: 'idle', event: { type: 'response-done' } },
  { state: 'idle', event: { type: 'ack-sent' } },
  // userRecording: only ptt-release transitions (rule b); ptt-press is the idempotent case, and
  // every server-driven event is absorbed silently.
  { state: 'userRecording', event: { type: 'ptt-press' } },
  { state: 'userRecording', event: { type: 'response-started' } },
  { state: 'userRecording', event: { type: 'function-call-ready', call: SAMPLE_CALL } },
  { state: 'userRecording', event: { type: 'response-done' } },
  { state: 'userRecording', event: { type: 'ack-sent' } },
  { state: 'userRecording', event: { type: 'injection-flushed' } },
  // awaitingResponse: ptt-press/response-started/function-call-ready/response-done all transition;
  // ptt-release/ptt-abort/ack-sent/injection-flushed don't apply here.
  { state: 'awaitingResponse', event: { type: 'ptt-release' } },
  { state: 'awaitingResponse', event: { type: 'ptt-abort' } },
  { state: 'awaitingResponse', event: { type: 'ack-sent' } },
  { state: 'awaitingResponse', event: { type: 'injection-flushed' } },
  // speaking: ptt-press/function-call-ready/response-done transition; the rest don't.
  { state: 'speaking', event: { type: 'ptt-release' } },
  { state: 'speaking', event: { type: 'ptt-abort' } },
  { state: 'speaking', event: { type: 'response-started' } },
  { state: 'speaking', event: { type: 'ack-sent' } },
  { state: 'speaking', event: { type: 'injection-flushed' } },
  // toolPending: ptt-press/ack-sent transition; everything else — including a second
  // function-call-ready before the first is acked, and the wrapping response's own response-done —
  // is REQUIRED protocol handling (waiting for sendFunctionOutput), not a "stray" edge case.
  { state: 'toolPending', event: { type: 'ptt-release' } },
  { state: 'toolPending', event: { type: 'ptt-abort' } },
  { state: 'toolPending', event: { type: 'response-started' } },
  { state: 'toolPending', event: { type: 'function-call-ready', call: SAMPLE_CALL } },
  { state: 'toolPending', event: { type: 'response-done' } },
  { state: 'toolPending', event: { type: 'injection-flushed' } },
];

test('nextVoiceState: designated-noop cells are pinned exactly — state unchanged, zero effects', () => {
  for (const { state, event } of NOOP_CELLS) {
    expect(nextVoiceState(state, event)).toEqual({ state, effects: [] });
  }
});

// -------------------------------------------------------------------------------------------------
// MAJOR-4: the 'reset' event — unconditional collapse to idle, with a stop-playback effect except
// from idle itself (where there's nothing to stop and no spurious extra effect on a fresh connect).
// -------------------------------------------------------------------------------------------------

test("nextVoiceState: reset from idle is a true no-op (no stop-playback on a fresh connect)", () => {
  expect(nextVoiceState('idle', { type: 'reset' })).toEqual({ state: 'idle', effects: [] });
});

for (const activeState of ['userRecording', 'awaitingResponse', 'speaking', 'toolPending'] as VoiceState[]) {
  test(`nextVoiceState: reset from ${activeState} collapses to idle and stops playback`, () => {
    expect(nextVoiceState(activeState, { type: 'reset' })).toEqual({ state: 'idle', effects: [{ type: 'stop-playback' }] });
  });
}

test('nextVoiceState: idle + ptt-press -> userRecording, clears the input buffer', () => {
  const result = nextVoiceState('idle', { type: 'ptt-press' });
  expect(result.state).toBe('userRecording');
  expect(result.effects).toEqual([{ type: 'send', payload: { type: 'input_audio_buffer.clear' } }]);
});

test('nextVoiceState: userRecording + ptt-press is idempotent (no duplicate clear)', () => {
  const result = nextVoiceState('userRecording', { type: 'ptt-press' });
  expect(result.state).toBe('userRecording');
  expect(result.effects).toEqual([]);
});

test('nextVoiceState: userRecording + ptt-release -> awaitingResponse, commits then requests a response', () => {
  const result = nextVoiceState('userRecording', { type: 'ptt-release' });
  expect(result.state).toBe('awaitingResponse');
  expect(result.effects).toEqual([
    { type: 'send', payload: { type: 'input_audio_buffer.commit' } },
    { type: 'send', payload: { type: 'response.create' } },
  ]);
});

test('nextVoiceState: userRecording + ptt-abort -> idle, discards the buffer — no commit, no response.create (empty-turn rule)', () => {
  const result = nextVoiceState('userRecording', { type: 'ptt-abort' });
  expect(result.state).toBe('idle');
  expect(result.effects).toEqual([{ type: 'send', payload: { type: 'input_audio_buffer.clear' } }]);
});

test('nextVoiceState: rule (b) — response.create is NEVER among the effects for any event while in userRecording', () => {
  for (const event of [...NON_PTT_EVENTS, { type: 'ptt-press' } as VoiceEvent, { type: 'ptt-abort' } as VoiceEvent]) {
    const result = nextVoiceState('userRecording', event);
    const hasResponseCreate = result.effects.some((e) => e.type === 'send' && e.payload.type === 'response.create');
    expect(hasResponseCreate).toBe(false);
  }
});

test('nextVoiceState: idle + response-started -> speaking (resync — the server just asserted a response is live)', () => {
  expect(nextVoiceState('idle', { type: 'response-started' })).toEqual({ state: 'speaking', effects: [] });
});

test('nextVoiceState: awaitingResponse + response-started -> speaking', () => {
  expect(nextVoiceState('awaitingResponse', { type: 'response-started' })).toEqual({ state: 'speaking', effects: [] });
});

test('nextVoiceState: awaitingResponse + response-done -> idle (no audio ever produced)', () => {
  expect(nextVoiceState('awaitingResponse', { type: 'response-done' })).toEqual({ state: 'idle', effects: [] });
});

test('nextVoiceState: awaitingResponse + function-call-ready -> toolPending', () => {
  expect(nextVoiceState('awaitingResponse', { type: 'function-call-ready', call: SAMPLE_CALL })).toEqual({ state: 'toolPending', effects: [] });
});

test('nextVoiceState: speaking + response-done -> idle', () => {
  expect(nextVoiceState('speaking', { type: 'response-done' })).toEqual({ state: 'idle', effects: [] });
});

test('nextVoiceState: speaking + function-call-ready -> toolPending', () => {
  expect(nextVoiceState('speaking', { type: 'function-call-ready', call: SAMPLE_CALL })).toEqual({ state: 'toolPending', effects: [] });
});

test('nextVoiceState: toolPending + ack-sent -> awaitingResponse, sends response.create (the ack guard)', () => {
  expect(nextVoiceState('toolPending', { type: 'ack-sent' })).toEqual({
    state: 'awaitingResponse',
    effects: [{ type: 'send', payload: { type: 'response.create' } }],
  });
});

test('nextVoiceState: idle + injection-flushed -> awaitingResponse (no additional wire effect; the send already happened)', () => {
  expect(nextVoiceState('idle', { type: 'injection-flushed' })).toEqual({ state: 'awaitingResponse', effects: [] });
});

// -------------------------------------------------------------------------------------------------
// Arbitration rule (a): PTT-press while a response is active -> response.cancel + stop-playback,
// then start recording. Pinned for `speaking` (the design's literal case) and generalized to
// `awaitingResponse`/`toolPending`.
// -------------------------------------------------------------------------------------------------

for (const activeState of ['awaitingResponse', 'speaking', 'toolPending'] as VoiceState[]) {
  test(`nextVoiceState: barge-in — ptt-press while ${activeState} cancels the response, stops playback, and starts recording`, () => {
    const result = nextVoiceState(activeState, { type: 'ptt-press' });
    expect(result.state).toBe('userRecording');
    expect(result.effects).toEqual([
      { type: 'send', payload: { type: 'response.cancel' } },
      { type: 'stop-playback' },
      { type: 'send', payload: { type: 'input_audio_buffer.clear' } },
    ]);
  });
}

test('nextVoiceState: idle + ptt-press is NOT a barge-in (no response.cancel, nothing to cancel)', () => {
  const result = nextVoiceState('idle', { type: 'ptt-press' });
  expect(result.effects.some((e) => e.type === 'send' && e.payload.type === 'response.cancel')).toBe(false);
});

// =================================================================================================
// VoiceSession: connect / mic-denied / mint-failed
// =================================================================================================

test('VoiceSession.connect: getUserMedia denied surfaces a distinct mic-denied error and does not retry', async () => {
  const h = makeHarness();
  h.getUserMediaImpl = async () => {
    throw new DOMException('Permission denied', 'NotAllowedError');
  };
  await h.session.connect();
  expect(h.errors).toEqual([{ code: 'mic-denied', message: 'Microphone access was denied.' }]);
  expect(h.mintCalls).toBe(0); // never even attempted to mint
  expect(h.session.getState()).toBe('idle');
});

test('VoiceSession.connect: a mint failure surfaces a mint-failed error', async () => {
  const h = makeHarness();
  h.mintImpl = async () => {
    throw new Error('rate limited');
  };
  await h.session.connect();
  expect(h.errors).toEqual([{ code: 'mint-failed', message: 'rate limited' }]);
});

test('VoiceSession.connect: a 429 mint failure (org mint cap / rate limit) surfaces mint-rate-limited, not the generic mint-failed', async () => {
  const h = makeHarness();
  h.mintImpl = async () => {
    // What ApiError (api.ts) produces for the daemon's 429: an Error carrying a numeric `status`.
    throw Object.assign(new Error('this organization has reached its voice mint limit (5 per 62 minutes); try again later'), { status: 429 });
  };
  await h.session.connect();
  expect(h.errors).toEqual([
    { code: 'mint-rate-limited', message: 'this organization has reached its voice mint limit (5 per 62 minutes); try again later' },
  ]);
});

test('VoiceSession.connect: a non-429 mint failure stays mint-failed (the 429 branch is specific, not a catch-all)', async () => {
  const h = makeHarness();
  h.mintImpl = async () => {
    throw Object.assign(new Error('voice key storage unavailable'), { status: 501 });
  };
  await h.session.connect();
  expect(h.errors).toEqual([{ code: 'mint-failed', message: 'voice key storage unavailable' }]);
});

test('VoiceSession.connect: a successful connect leaves the session idle', async () => {
  const h = makeHarness();
  await h.session.connect();
  expect(h.session.getState()).toBe('idle');
  expect(h.errors).toEqual([]);
  expect(h.mintCalls).toBe(1);
});

test('MINOR-11: a failure AFTER a successful mint (SDP exchange) is connect-failed, not mint-failed', async () => {
  const h = makeHarness();
  h.postSdpOfferImpl = async () => {
    throw new Error('voice: SDP exchange failed (500)');
  };
  await h.session.connect();
  expect(h.errors).toEqual([{ code: 'connect-failed', message: 'voice: SDP exchange failed (500)' }]);
  expect(h.mintCalls).toBe(1); // mint itself succeeded
});

test('MINOR-14: a second connect() call while the first is still establishing is a silent no-op', async () => {
  const h = makeHarness();
  const first = h.session.connect();
  const second = h.session.connect(); // fired before `first` resolves
  await Promise.all([first, second]);
  await flush();
  expect(h.mintCalls).toBe(1); // only one connection attempt actually ran
  expect(h.getUserMediaCalls).toBe(1);
  expect(h.session.getState()).toBe('idle');
  expect(h.errors).toEqual([]);
});

test('MINOR-14: connect() again after a completed connection is also a no-op (already connected)', async () => {
  const h = makeHarness();
  await h.session.connect();
  await h.session.connect();
  expect(h.mintCalls).toBe(1);
});

test('MINOR-14: a throw partway through establishConnection closes the locally-created peer connection (no leak)', async () => {
  const h = makeHarness();
  let closed = false;
  const originalCreatePc = h.deps.createPeerConnection;
  h.deps.createPeerConnection = () => {
    const pc = originalCreatePc();
    const originalClose = pc.close.bind(pc);
    pc.close = () => {
      closed = true;
      originalClose();
    };
    return pc;
  };
  h.postSdpOfferImpl = async () => {
    throw new Error('boom');
  };
  await h.session.connect();
  expect(closed).toBe(true);
});

// =================================================================================================
// VoiceSession: PTT press/release end-to-end (through the data channel)
// =================================================================================================

test('VoiceSession: pttPress -> pttRelease sends clear, then commit + response.create, in order', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  expect(h.session.getState()).toBe('userRecording');
  h.session.pttRelease();
  expect(h.session.getState()).toBe('awaitingResponse');
  expect(lastSent(h)).toEqual([{ type: 'input_audio_buffer.clear' }, { type: 'input_audio_buffer.commit' }, { type: 'response.create' }]);
});

// -------------------------------------------------------------------------------------------------
// Empty-turn rule (live bug, 2026-07-15): an engagement the gesture layer deemed too short to
// contain speech ends via pttAbort — discard, re-mute, and critically NO response.create, so the
// model can never answer an empty commit by re-answering the previous context ("it immediately
// said the same thing again" while the operator's mic was freshly muted under them).
// -------------------------------------------------------------------------------------------------

test('VoiceSession: pttPress -> pttAbort discards the recording — clear only, no commit, no response.create, back to idle', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  expect(lastMicTrack(h).enabled).toBe(true);

  h.session.pttAbort();

  expect(h.session.getState()).toBe('idle');
  expect(lastMicTrack(h).enabled).toBe(false); // the engagement is over — hot-mic privacy re-mutes
  const sent = lastSent(h);
  expect(sent.some((s) => s.type === 'input_audio_buffer.commit')).toBe(false);
  expect(sent.some((s) => s.type === 'response.create')).toBe(false);
  expect(sent[sent.length - 1]).toEqual({ type: 'input_audio_buffer.clear' }); // the discard
});

test('VoiceSession: an aborted barge-in stays cancelled — the press cancels the response, the abort never asks for a new one', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  h.session.pttRelease();
  serverEvent(h, { type: 'response.created' });
  expect(h.session.getState()).toBe('speaking');

  h.session.pttPress(); // barge-in: response.cancel + stop playback + clear
  h.session.pttAbort(); // ...but the engagement was an accidental click — discard it

  expect(h.session.getState()).toBe('idle');
  serverEvent(h, { type: 'response.done' }); // the cancelled response unwinds
  expect(h.session.getState()).toBe('idle');
  const responseCreates = lastSent(h).filter((s) => s.type === 'response.create');
  expect(responseCreates).toHaveLength(1); // only the original turn's — nothing from the aborted engagement
});

test('VoiceSession: pttAbort with no recording in progress is a no-op (bar the idempotent re-mute)', async () => {
  const h = makeHarness();
  await h.session.connect();
  const sentBefore = lastSent(h).length;
  h.session.pttAbort();
  expect(h.session.getState()).toBe('idle');
  expect(lastSent(h).length).toBe(sentBefore); // no wire traffic from an idle abort
});

test('empty-commit backstop: input_audio_buffer_commit_empty withdraws the paired response.create via response.cancel, no onError', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  h.session.pttRelease(); // commit + response.create for a turn that turns out to be empty

  serverEvent(h, { type: 'error', error: { code: 'input_audio_buffer_commit_empty', message: 'buffer too small' } });

  expect(h.errors).toEqual([]); // still benign — never surfaced as a failure
  expect(lastSent(h)[lastSent(h).length - 1]).toEqual({ type: 'response.cancel' }); // the withdrawal
  serverEvent(h, { type: 'response.done' }); // the cancelled response unwinds the machine
  expect(h.session.getState()).toBe('idle');
});

test('empty-commit backstop: when the empty turn\'s response.create was DEFERRED behind a wrapping response, it is dropped, not cancelled', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  h.session.pttRelease(); // response.create #1 — outstandingResponses: 1
  serverEvent(h, { type: 'response.created', response: { id: 'resp-1' } });

  h.session.pttPress(); // barge-in on resp-1 (cancel sent; its response.done hasn't arrived yet)
  h.session.pttRelease(); // empty second turn: commit + a response.create that sendRaw DEFERS (outstanding > 0)
  expect(lastSent(h).filter((s) => s.type === 'response.create')).toHaveLength(1); // #2 deferred, not sent

  serverEvent(h, { type: 'error', error: { code: 'input_audio_buffer_commit_empty', message: 'buffer too small' } });
  serverEvent(h, { type: 'response.done', response: { id: 'resp-1' } }); // resp-1's cancel unwinds

  // The deferred continuation was dropped by the backstop — nothing fires into the empty turn.
  expect(lastSent(h).filter((s) => s.type === 'response.create')).toHaveLength(1);
  expect(h.session.getState()).toBe('idle');
  expect(h.errors).toEqual([]);
});

test('MINOR-8: hot-mic privacy — the mic track is muted by default, unmuted only while PTT is held', async () => {
  const h = makeHarness();
  await h.session.connect();
  expect(lastMicTrack(h).enabled).toBe(false); // muted immediately after connect

  h.session.pttPress();
  expect(lastMicTrack(h).enabled).toBe(true); // unmuted for the duration of the hold

  h.session.pttRelease();
  expect(lastMicTrack(h).enabled).toBe(false); // muted again the instant the user lets go
});

test('MINOR-8: a barge-in PTT press also unmutes the mic', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  h.session.pttRelease();
  serverEvent(h, { type: 'response.created' });
  h.session.pttRelease(); // no-op release from speaking, just to re-mute for the assertion's sake
  expect(lastMicTrack(h).enabled).toBe(false);

  h.session.pttPress(); // barge-in
  expect(lastMicTrack(h).enabled).toBe(true);
});

test('VoiceSession: barge-in end-to-end — pttPress while speaking cancels + stops playback before recording', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  h.session.pttRelease();
  serverEvent(h, { type: 'response.created' });
  expect(h.session.getState()).toBe('speaking');

  h.session.pttPress();

  expect(h.session.getState()).toBe('userRecording');
  expect(h.stopPlaybackCalls).toBe(1);
  const sent = lastSent(h);
  expect(sent[sent.length - 2]).toEqual({ type: 'response.cancel' });
  expect(sent[sent.length - 1]).toEqual({ type: 'input_audio_buffer.clear' });
});

test('MINOR-9: barge-in sends conversation.item.truncate for the in-flight audio item, with best-effort played-ms', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  h.session.pttRelease();
  serverEvent(h, { type: 'response.created' });
  h.nowValue = 1_000;
  serverEvent(h, { type: 'response.output_audio_transcript.delta', delta: 'Hel', item_id: 'item-1', content_index: 0 });
  h.nowValue = 1_750; // 750ms of audio played before the user barges in

  h.session.pttPress();

  const sent = lastSent(h);
  const truncate = sent.find((s) => s.type === 'conversation.item.truncate');
  expect(truncate).toEqual({ type: 'conversation.item.truncate', item_id: 'item-1', content_index: 0, audio_end_ms: 750 });
});

test('MINOR-9: barge-in before any audio delta has an item to target skips the truncate (nothing to target)', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  h.session.pttRelease();
  serverEvent(h, { type: 'response.created' }); // no output_audio_transcript.delta yet — no item_id known

  h.session.pttPress();

  const sent = lastSent(h);
  expect(sent.some((s) => s.type === 'conversation.item.truncate')).toBe(false);
});

test('VoiceSession: captions surface live transcript deltas, tagged assistant, without changing state', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  h.session.pttRelease();
  serverEvent(h, { type: 'response.created' });
  serverEvent(h, { type: 'response.output_audio_transcript.delta', delta: 'Hello' });
  serverEvent(h, { type: 'response.output_audio_transcript.delta', delta: ' there' });
  expect(h.captions).toEqual([
    { text: 'Hello', speaker: 'assistant' },
    { text: ' there', speaker: 'assistant' },
  ]);
  expect(h.session.getState()).toBe('speaking');
});

test('MINOR-10: user-side input-transcription deltas are tagged user (dormant until mint enables input transcription)', async () => {
  const h = makeHarness();
  await h.session.connect();
  serverEvent(h, { type: 'conversation.item.input_audio_transcription.delta', delta: 'user said something' });
  expect(h.captions).toEqual([{ text: 'user said something', speaker: 'user' }]);
});

test("input-transcription completed with NO prior deltas emits the full transcript as a user caption (whisper-1, the pinned model, doesn't stream)", async () => {
  const h = makeHarness();
  await h.session.connect();
  serverEvent(h, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'item-u1', transcript: 'stop the deploy' });
  expect(h.captions).toEqual([{ text: 'stop the deploy', speaker: 'user' }]);
});

test('input-transcription completed AFTER streamed deltas for the same item does NOT re-emit the utterance', async () => {
  const h = makeHarness();
  await h.session.connect();
  serverEvent(h, { type: 'conversation.item.input_audio_transcription.delta', delta: 'stop the ', item_id: 'item-u1' });
  serverEvent(h, { type: 'conversation.item.input_audio_transcription.delta', delta: 'deploy', item_id: 'item-u1' });
  serverEvent(h, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'item-u1', transcript: 'stop the deploy' });
  expect(h.captions).toEqual([
    { text: 'stop the ', speaker: 'user' },
    { text: 'deploy', speaker: 'user' },
  ]);
  // A LATER item with no deltas of its own still emits — the guard is per-item, not global.
  serverEvent(h, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'item-u2', transcript: 'and restart it' });
  expect(h.captions[h.captions.length - 1]).toEqual({ text: 'and restart it', speaker: 'user' });
});

test('VoiceSession: a full spoken turn returns to idle on response.done', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  h.session.pttRelease();
  serverEvent(h, { type: 'response.created' });
  serverEvent(h, { type: 'response.done' });
  expect(h.session.getState()).toBe('idle');
});

// =================================================================================================
// Tool dispatcher surface: function-call-ready -> toolPending -> sendFunctionOutput
// =================================================================================================

test('VoiceSession: a function call moves to toolPending and emits onFunctionCall; sendFunctionOutput acks and resumes (once the wrapping response.done arrives — CRITICAL-1)', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  h.session.pttRelease();
  serverEvent(h, { type: 'response.created', response: { id: 'resp-1' } });
  serverEvent(h, { type: 'response.function_call_arguments.done', response_id: 'resp-1', call_id: 'call-42', name: 'fleet_status', arguments: '{}' });

  expect(h.session.getState()).toBe('toolPending');
  expect(h.functionCalls).toEqual([{ callId: 'call-42', name: 'fleet_status', arguments: '{}', trigger: 'user' }]);

  const sentBeforeAck = lastSent(h).length;
  h.session.sendFunctionOutput('call-42', { agents: 3 });

  expect(h.session.getState()).toBe('awaitingResponse');
  const sentAfterAck = lastSent(h).slice(sentBeforeAck);
  expect(sentAfterAck).toEqual([
    { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'call-42', output: JSON.stringify({ agents: 3 }) } },
  ]);
  // CRITICAL-1: the continuation response.create is DEFERRED until the wrapping response's own
  // response.done arrives — not sent eagerly at ack time.
  expect(sentAfterAck.some((s) => s.type === 'response.create')).toBe(false);

  serverEvent(h, { type: 'response.done' }); // resp-1's own completion releases the deferred send
  const sent = lastSent(h);
  expect(sent[sent.length - 1]).toEqual({ type: 'response.create' });
});

test('re-review MEDIUM: the deferred-continuation path clears activeAudio so a barge-in during the continuation does not over-truncate the finished item', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  h.session.pttRelease();
  serverEvent(h, { type: 'response.created', response: { id: 'resp-1' } });
  // the wrapping response speaks, so an audio item is now tracked
  h.nowValue = 1_000;
  serverEvent(h, { type: 'response.output_audio_transcript.delta', delta: 'Hi', item_id: 'item-1', content_index: 0 });
  // a tool call resolves; its ack's continuation is deferred behind resp-1
  serverEvent(h, { type: 'response.function_call_arguments.done', response_id: 'resp-1', call_id: 'c1', name: 'fleet_status', arguments: '{}' });
  h.session.sendFunctionOutput('c1', { agents: 1 });
  serverEvent(h, { type: 'response.done' }); // fires the deferred create AND must clear activeAudio*
  const sentBefore = lastSent(h).length;

  h.nowValue = 9_999; // lots of wall-clock elapsed on the tool round-trip
  h.session.pttPress(); // barge in BEFORE the continuation's first audio delta

  // item-1 finished with resp-1; there is no live audio item to truncate → no over-reported audio_end_ms
  const afterBargeIn = lastSent(h).slice(sentBefore);
  expect(afterBargeIn.some((s) => s.type === 'conversation.item.truncate')).toBe(false);
});

test('MINOR-12: a second function call before the first is acked still fires onFunctionCall with its own distinct callId (nothing is lost)', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  h.session.pttRelease();
  serverEvent(h, { type: 'response.created', response: { id: 'resp-1' } });
  serverEvent(h, { type: 'response.function_call_arguments.done', response_id: 'resp-1', call_id: 'call-a', name: 'tool_a', arguments: '{}' });
  serverEvent(h, { type: 'response.function_call_arguments.done', response_id: 'resp-1', call_id: 'call-b', name: 'tool_b', arguments: '{}' });

  expect(h.session.getState()).toBe('toolPending'); // stays toolPending — the reducer's designated noop
  expect(h.functionCalls).toEqual([
    { callId: 'call-a', name: 'tool_a', arguments: '{}', trigger: 'user' },
    { callId: 'call-b', name: 'tool_b', arguments: '{}', trigger: 'user' },
  ]);

  // Both calls can still be acked independently — neither callId was overwritten/lost.
  h.session.sendFunctionOutput('call-a', { ok: true });
  const sent = lastSent(h);
  expect(sent.some((s) => s.type === 'conversation.item.create' && (s as { item: { call_id: string } }).item.call_id === 'call-a')).toBe(true);
});

// -------------------------------------------------------------------------------------------------
// CRITICAL-1: response.done correlation. A function-call ack sends a SECOND response.create while
// the wrapping response (the one that carried the call) hasn't itself emitted response.done yet.
// Without counting outstanding response.create sends against response.done arrivals, the wrapping
// response's own response.done would be misread as the ack response completing, dropping the
// machine to idle while the ack's response is still live.
// -------------------------------------------------------------------------------------------------

test('CRITICAL-1: a synchronous function-call ack does not desync on the wrapping response.done', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  h.session.pttRelease(); // response.create #1 (the original turn) — outstandingResponses: 1
  serverEvent(h, { type: 'response.created' });
  expect(h.session.getState()).toBe('speaking');

  serverEvent(h, { type: 'response.function_call_arguments.done', call_id: 'call-1', name: 'fleet_status', arguments: '{}' });
  expect(h.session.getState()).toBe('toolPending');

  // The dispatcher acks synchronously — response.create #2 (the ack's continuation) —
  // outstandingResponses: 2.
  h.session.sendFunctionOutput('call-1', { agents: 3 });
  expect(h.session.getState()).toBe('awaitingResponse');

  // The WRAPPING response's own response.done now arrives. Without correlation this would
  // incorrectly drop the machine to idle; the ack's response is still in flight.
  serverEvent(h, { type: 'response.done' });
  expect(h.session.getState()).toBe('awaitingResponse');
  expect(h.states).not.toContain('idle');

  // Only the ACK's own response.done actually completes the turn.
  serverEvent(h, { type: 'response.done' });
  expect(h.session.getState()).toBe('idle');
});

test('CRITICAL-1: after the desync-prone sequence, a PTT press while "still" awaitingResponse still barges in correctly', async () => {
  // Regression for the failure mode described in the finding: if the machine had wrongly dropped to
  // idle after the wrapping response.done, a PTT press here would take the idle branch (plain
  // record-start, no cancel/stopPlayback) instead of a barge-in.
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  h.session.pttRelease();
  serverEvent(h, { type: 'response.created' });
  serverEvent(h, { type: 'response.function_call_arguments.done', call_id: 'call-1', name: 'fleet_status', arguments: '{}' });
  h.session.sendFunctionOutput('call-1', { agents: 3 });
  serverEvent(h, { type: 'response.done' }); // wrapping response's response.done

  h.session.pttPress(); // must still be a barge-in (response.cancel + stop-playback), not a fresh record

  expect(h.session.getState()).toBe('userRecording');
  expect(h.stopPlaybackCalls).toBe(1);
  expect(lastSent(h).some((s) => s.type === 'response.cancel')).toBe(true);
});

// -------------------------------------------------------------------------------------------------
// CRITICAL-1 (gauntlet fix): sendFunctionOutput's ack must not send response.create WHILE the
// wrapping response is still active — the provider rejects `response.create` sent during an active
// response (`conversation_already_has_active_response`). The fix defers the actual send until the
// wrapping response's own response.done arrives, rather than sending it eagerly at ack time.
// -------------------------------------------------------------------------------------------------

describe('CRITICAL-1 (gauntlet): ack response.create is deferred until the wrapping response.done arrives', () => {
  test('an ack requested during an active response does NOT emit response.create until response.done, then does', async () => {
    const h = makeHarness();
    await h.session.connect();
    h.session.pttPress();
    h.session.pttRelease();
    serverEvent(h, { type: 'response.created' }); // wrapping response now active (outstandingResponses: 1)
    serverEvent(h, { type: 'response.function_call_arguments.done', call_id: 'call-1', name: 'fleet_status', arguments: '{}' });
    expect(h.session.getState()).toBe('toolPending');

    const sentBeforeAck = lastSent(h).length;
    h.session.sendFunctionOutput('call-1', { agents: 3 }); // the ack

    // The function_call_output item itself is sent immediately (valid mid-response) — but NOT a
    // second response.create, since the wrapping response's own response.done hasn't arrived yet.
    const sentAfterAck = lastSent(h).slice(sentBeforeAck);
    expect(sentAfterAck).toEqual([
      { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'call-1', output: '{"agents":3}' } },
    ]);
    expect(sentAfterAck.some((s) => s.type === 'response.create')).toBe(false);
    expect(h.session.getState()).toBe('awaitingResponse'); // the reducer's own state still advances

    // The wrapping response's response.done arrives — THIS is what releases the deferred send.
    serverEvent(h, { type: 'response.done' });

    const sentAfterDone = lastSent(h);
    expect(sentAfterDone[sentAfterDone.length - 1]).toEqual({ type: 'response.create' });
    expect(h.session.getState()).toBe('awaitingResponse'); // still awaiting the ack's own continuation

    // And the machine returns to idle only once the ACK's own response.done lands.
    serverEvent(h, { type: 'response.done' });
    expect(h.session.getState()).toBe('idle');
  });

  test('a barge-in before the wrapping response.done arrives cancels the deferred continuation — it never fires into the new recording', async () => {
    const h = makeHarness();
    await h.session.connect();
    h.session.pttPress();
    h.session.pttRelease();
    serverEvent(h, { type: 'response.created' });
    serverEvent(h, { type: 'response.function_call_arguments.done', call_id: 'call-1', name: 'fleet_status', arguments: '{}' });
    h.session.sendFunctionOutput('call-1', { agents: 3 }); // deferred response.create pending

    h.session.pttPress(); // barge-in — supersedes the deferred continuation
    expect(h.session.getState()).toBe('userRecording');
    const sentAtBargeIn = lastSent(h).length;

    // The wrapping response's response.done finally arrives — must NOT emit a stray response.create
    // into the new recording (that would violate rule (b)).
    serverEvent(h, { type: 'response.done' });
    expect(h.session.getState()).toBe('userRecording');
    expect(lastSent(h).slice(sentAtBargeIn).some((s) => s.type === 'response.create')).toBe(false);
  });

  test('a conversation_already_has_active_response error does not wedge the machine or tear down the call', async () => {
    const h = makeHarness();
    await h.session.connect();
    h.session.pttPress();
    h.session.pttRelease();
    serverEvent(h, { type: 'response.created' }); // outstandingResponses: 1

    // Simulate the provider rejecting a response.create sent while a response was already active
    // (belt-and-braces — the deferral above is meant to make this unreachable in normal operation).
    serverEvent(h, { type: 'error', error: { code: 'conversation_already_has_active_response', message: 'active' } });

    expect(h.errors).toEqual([]); // absorbed as benign, not surfaced as connect-failed
    expect(h.session.getState()).toBe('speaking'); // unaffected

    // The bookkeeping correction (outstandingResponses decremented) means the wrapping response's
    // own response.done still correctly returns the machine to idle — no permanent miscount.
    serverEvent(h, { type: 'response.done' });
    expect(h.session.getState()).toBe('idle');
    expect(h.errors).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------
// CRITICAL-2 (gauntlet fix): the first barge-in pauses local playback (`stopPlayback`) but nothing
// ever resumed it — every response after the first barge-in played into a permanently-paused
// element. Fix: `resumePlayback` fires whenever a fresh response starts (`response.created`).
// -------------------------------------------------------------------------------------------------

describe('CRITICAL-2 (gauntlet): playback resumes after a barge-in', () => {
  test('after a barge-in pauses playback, the next response triggers resumePlayback', async () => {
    const h = makeHarness();
    await h.session.connect();
    h.session.pttPress();
    h.session.pttRelease();
    serverEvent(h, { type: 'response.created' }); // first response — resumePlayback called here too
    expect(h.resumePlaybackCalls).toBe(1);
    expect(h.session.getState()).toBe('speaking');

    h.session.pttPress(); // barge-in: pauses playback
    expect(h.stopPlaybackCalls).toBe(1);

    h.session.pttRelease();
    serverEvent(h, { type: 'response.created' }); // the NEXT response starting

    expect(h.resumePlaybackCalls).toBe(2); // resumed — not permanently silent after the barge-in
  });

  test('resumePlayback fires on every response.created, not just after a barge-in (cheap/idempotent)', async () => {
    const h = makeHarness();
    await h.session.connect();
    h.session.pttPress();
    h.session.pttRelease();
    serverEvent(h, { type: 'response.created' });
    expect(h.resumePlaybackCalls).toBe(1);
  });

  test('re-review LOW: resumePlayback does NOT fire while userRecording (a barge-in inside the RTT window before response.created)', async () => {
    const h = makeHarness();
    await h.session.connect();
    h.session.pttPress();
    h.session.pttRelease(); // sends a response.create
    h.session.pttPress(); // user barges in again BEFORE the server's response.created arrives → userRecording, playback paused
    const before = h.resumePlaybackCalls;
    serverEvent(h, { type: 'response.created' }); // the about-to-be-cancelled response starts
    // must stay paused — un-pausing here would play its buffered frames over the user's new utterance
    expect(h.resumePlaybackCalls).toBe(before);
  });
});

// -------------------------------------------------------------------------------------------------
// HIGH-3 (gauntlet fix): hot-mic vectors — rotate/reconnect reusing a MediaStream whose tracks are
// still enabled from a held PTT, and a failed initial connect leaving the mic stream open.
// -------------------------------------------------------------------------------------------------

describe('HIGH-3 (gauntlet): hot-mic privacy across rotation/reconnect and connect failure', () => {
  test('an unexpected-drop reconnect re-mutes a mic track left enabled (e.g. a PTT held when the drop happened)', async () => {
    const h = makeHarness();
    await h.session.connect();
    h.session.pttPress(); // track.enabled -> true — simulates a PTT still held when the drop hits
    expect(lastMicTrack(h).enabled).toBe(true);

    const dc = h.dataChannels[0]!;
    dc.onclose?.(); // unexpected drop while the track is still enabled=true from the held PTT
    await flush();

    // establishConnection (called by the reconnect attempt) re-asserts the mute at its own start,
    // regardless of whatever the track's enabled state was left at — nothing else would have.
    expect(lastMicTrack(h).enabled).toBe(false);
  });

  test('rotateSession (proactive re-mint) re-mutes the reused MediaStream even if left enabled', async () => {
    const h = makeHarness({ getRecap: () => 'recap' });
    await h.session.connect();
    // Directly simulate a track left hot (e.g. a PTT release that, in some future refactor, missed
    // its own re-mute) — establishConnection must not trust the track's incoming state.
    lastMicTrack(h).enabled = true;

    const dueFn = h.timers[0]!.fn; // idle — rotates immediately
    dueFn();
    await flush();

    expect(lastMicTrack(h).enabled).toBe(false);
  });

  test('a mint failure on the initial connect() stops the mic tracks (not just a bounded-reconnect give-up)', async () => {
    const h = makeHarness();
    h.mintImpl = async () => {
      throw new Error('rate limited');
    };
    await h.session.connect();
    expect(h.errors).toEqual([{ code: 'mint-failed', message: 'rate limited' }]);
    expect(lastMicTrack(h).stopped).toBe(true);
  });

  test('a connect-failed (post-mint SDP failure) on the initial connect() also stops the mic tracks', async () => {
    const h = makeHarness();
    h.postSdpOfferImpl = async () => {
      throw new Error('voice: SDP exchange failed (500)');
    };
    await h.session.connect();
    expect(h.errors).toEqual([{ code: 'connect-failed', message: 'voice: SDP exchange failed (500)' }]);
    expect(lastMicTrack(h).stopped).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------------
// LOW batch: the SDP POST now carries a 15s timeout and is abortable by disconnect()/a superseding
// attempt — previously unbounded, so a hung provider request could strand "Connecting…" forever.
// -------------------------------------------------------------------------------------------------

describe('LOW batch: SDP POST timeout + abort', () => {
  test('the 15s timeout aborts the in-flight SDP POST; the resulting rejection surfaces as connect-failed', async () => {
    const h = makeHarness();
    let sawAbort = false;
    h.postSdpOfferImpl = (_key, _sdp, signal) =>
      new Promise<string>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          sawAbort = true;
          reject(new Error('aborted'));
        });
      });

    const connecting = h.session.connect();
    await flush();
    fireTimer(h, 15_000);
    await connecting;
    await flush();

    expect(sawAbort).toBe(true);
    expect(h.errors).toEqual([{ code: 'connect-failed', message: 'aborted' }]);
  });

  test('disconnect() mid-SDP-POST aborts the in-flight request', async () => {
    const h = makeHarness();
    let sawAbort = false;
    h.postSdpOfferImpl = (_key, _sdp, signal) =>
      new Promise<string>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          sawAbort = true;
          reject(new Error('aborted'));
        });
      });

    const connecting = h.session.connect();
    await flush();
    h.session.disconnect();
    await connecting;
    await flush();

    expect(sawAbort).toBe(true);
  });

  test('a normal, timely SDP POST clears its timeout — the 15s timer never fires stray', async () => {
    const h = makeHarness();
    await h.session.connect();
    expect(h.session.getState()).toBe('idle');
    // Only the re-mint timer (55min) should remain scheduled — the SDP-POST timeout was cleared.
    expect(h.timers.map((t) => t.ms)).toEqual([55 * 60_000]);
  });
});

// -------------------------------------------------------------------------------------------------
// LOW batch: fail-closed trigger fallback — an uncorrelated function_call_arguments.done (no
// response_id on the wire) now ALWAYS defaults to 'injection', never to whatever `currentTrigger`
// happens to hold (previously this could fail OPEN as 'user' if a user-triggered response happened
// to still be the provisionally-tracked trigger when the uncorrelated event arrived).
// -------------------------------------------------------------------------------------------------

test("LOW batch: an uncorrelated function call defaults to trigger 'injection' even when currentTrigger is 'user' (fail-closed, not fail-open)", async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  h.session.pttRelease(); // currentTrigger is 'user' at this point
  serverEvent(h, { type: 'response.created' }); // no response.id on the wire — nothing claims the trigger queue... shifts 'user' off the queue instead
  // Simulate the residual case: no response_id on the function-call event either, so this can't
  // correlate against responseTriggerById at all.
  serverEvent(h, { type: 'response.function_call_arguments.done', call_id: 'call-1', name: 'fleet_status', arguments: '{}' });

  expect(h.functionCalls[0]!.trigger).toBe('injection');
});

// -------------------------------------------------------------------------------------------------
// MAJOR-2: benign provider error codes are dropped rather than surfaced as connect-failed.
// -------------------------------------------------------------------------------------------------

test('MAJOR-2: a response_cancel_not_active error (a no-op cancel) is silently dropped', async () => {
  const h = makeHarness();
  await h.session.connect();
  serverEvent(h, { type: 'error', error: { code: 'response_cancel_not_active', message: 'no response to cancel' } });
  expect(h.errors).toEqual([]);
});

test('MAJOR-2: an input_audio_buffer_commit_empty error (an empty PTT tap) is silently dropped', async () => {
  const h = makeHarness();
  await h.session.connect();
  serverEvent(h, { type: 'error', error: { code: 'input_audio_buffer_commit_empty', message: 'buffer too small' } });
  expect(h.errors).toEqual([]);
});

test('MAJOR-2: any other provider error code still surfaces as connect-failed', async () => {
  const h = makeHarness();
  await h.session.connect();
  serverEvent(h, { type: 'error', error: { code: 'invalid_request_error', message: 'something genuinely wrong' } });
  expect(h.errors).toEqual([{ code: 'connect-failed', message: 'something genuinely wrong' }]);
});

// -------------------------------------------------------------------------------------------------
// MAJOR-3: trigger provenance on the function-call payload — 'user' at ptt-release, 'injection' at
// a queued-injection flush or a sendFunctionOutput ack.
// -------------------------------------------------------------------------------------------------

test('MAJOR-3: a function call during a queued-injection-triggered response is tagged trigger: injection', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.queueInjection([{ text: 'agent finished a background task' }]); // flushes immediately (idle)
  expect(h.session.getState()).toBe('awaitingResponse');

  serverEvent(h, { type: 'response.created' });
  serverEvent(h, { type: 'response.function_call_arguments.done', call_id: 'call-i', name: 'fleet_status', arguments: '{}' });

  expect(h.functionCalls).toEqual([{ callId: 'call-i', name: 'fleet_status', arguments: '{}', trigger: 'injection' }]);
});

test('MAJOR-3: a function call during the ack-continuation response is tagged trigger: injection (agent-chained)', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  h.session.pttRelease(); // user-triggered turn
  serverEvent(h, { type: 'response.created', response: { id: 'resp-1' } });
  serverEvent(h, { type: 'response.function_call_arguments.done', response_id: 'resp-1', call_id: 'call-1', name: 'tool_one', arguments: '{}' });
  expect(h.functionCalls[0]!.trigger).toBe('user');

  h.session.sendFunctionOutput('call-1', { ok: true }); // ack's own response.create is agent-triggered
  serverEvent(h, { type: 'response.done' }); // wrapping response ends
  serverEvent(h, { type: 'response.function_call_arguments.done', call_id: 'call-2', name: 'tool_two', arguments: '{}' }); // chained call

  expect(h.functionCalls[1]).toEqual({ callId: 'call-2', name: 'tool_two', arguments: '{}', trigger: 'injection' });
});

// -------------------------------------------------------------------------------------------------
// MINOR-4: per-response trigger correlation. Two function calls belonging to the SAME
// user-triggered wrapping response must both stay tagged 'user', even if the dispatcher acks the
// first one (which flips the single mutable `currentTrigger` field to 'injection' for the ack's OWN,
// unrelated response.create) before the second one arrives. Without correlating by response_id, the
// second call would be wrongly stamped 'injection' and fail-closed-blocked by the human-turn gate.
// -------------------------------------------------------------------------------------------------

test("MINOR-4: two function calls from the same user-triggered response are both stamped 'user', even after the first is acked", async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  h.session.pttRelease(); // response.create #1 — trigger 'user'
  serverEvent(h, { type: 'response.created', response: { id: 'resp-1' } });

  serverEvent(h, { type: 'response.function_call_arguments.done', response_id: 'resp-1', call_id: 'call-a', name: 'tool_a', arguments: '{}' });
  expect(h.functionCalls[0]).toEqual({ callId: 'call-a', name: 'tool_a', arguments: '{}', trigger: 'user' });

  // The dispatcher acks the first call — flips currentTrigger to 'injection' and sends a SECOND,
  // unrelated response.create (the ack's own continuation, a different response than resp-1).
  h.session.sendFunctionOutput('call-a', { ok: true });

  // The ORIGINAL wrapping response (resp-1) emits a second function call before its own
  // response.done — still the same user turn, must still be tagged 'user', not 'injection'.
  serverEvent(h, { type: 'response.function_call_arguments.done', response_id: 'resp-1', call_id: 'call-b', name: 'tool_b', arguments: '{}' });

  expect(h.functionCalls[1]).toEqual({ callId: 'call-b', name: 'tool_b', arguments: '{}', trigger: 'user' });
});

test('MINOR-4: response_id correlation survives interleaving with a queued-injection response', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  h.session.pttRelease(); // response.create #1 (resp-user) — trigger 'user'
  serverEvent(h, { type: 'response.created', response: { id: 'resp-user' } });

  h.session.queueInjection([{ text: 'agent finished a background task' }]); // waits — not idle
  expect(h.session.getState()).toBe('speaking');

  // resp-user's own function call still correlates to 'user' even with an injection queued behind it.
  serverEvent(h, { type: 'response.function_call_arguments.done', response_id: 'resp-user', call_id: 'call-x', name: 'tool_x', arguments: '{}' });
  expect(h.functionCalls[0]).toEqual({ callId: 'call-x', name: 'tool_x', arguments: '{}', trigger: 'user' });
});

test('MINOR-4: falls back to currentTrigger when response_id is absent from the wire event (residual, documented)', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.queueInjection([{ text: 'agent finished a background task' }]); // flushes immediately (idle)
  serverEvent(h, { type: 'response.created' }); // no response.id on the wire
  serverEvent(h, { type: 'response.function_call_arguments.done', call_id: 'call-i', name: 'fleet_status', arguments: '{}' }); // no response_id either
  expect(h.functionCalls[0]!.trigger).toBe('injection');
});

test('VoiceSession: guard (b) — if the user starts recording before the tool ack lands, sendFunctionOutput still records the output but withholds response.create', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  h.session.pttRelease();
  serverEvent(h, { type: 'response.created' });
  serverEvent(h, { type: 'response.function_call_arguments.done', call_id: 'call-7', name: 'fleet_status', arguments: '{}' });
  expect(h.session.getState()).toBe('toolPending');

  // The user barges in before the dispatcher acks — toolPending -> userRecording via rule (a).
  h.session.pttPress();
  expect(h.session.getState()).toBe('userRecording');

  const before = lastSent(h).length;
  h.session.sendFunctionOutput('call-7', { agents: 3 });

  expect(h.session.getState()).toBe('userRecording'); // unchanged — no response.create honored rule (b)
  const sent = lastSent(h).slice(before);
  expect(sent).toEqual([{ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'call-7', output: '{"agents":3}' } }]);
  expect(sent.some((s) => s.type === 'response.create')).toBe(false);
});

// =================================================================================================
// Queued injections (concern 07's async-ack completion narrations)
// =================================================================================================

test('VoiceSession.queueInjection: flushes immediately when already idle', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.queueInjection([{ text: 'agent finished the fix' }]);

  expect(h.session.getState()).toBe('awaitingResponse');
  expect(lastSent(h)).toEqual([
    { type: 'conversation.item.create', item: { text: 'agent finished the fix' } },
    { type: 'response.create' },
  ]);
});

test('VoiceSession.queueInjection: queued while userRecording waits until the session returns to idle', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();

  h.session.queueInjection([{ text: 'completion narration' }]);
  expect(h.session.getState()).toBe('userRecording');
  expect(lastSent(h).some((s) => s.type === 'conversation.item.create')).toBe(false);

  h.session.pttRelease(); // the user's own turn goes first
  expect(h.session.getState()).toBe('awaitingResponse');
  serverEvent(h, { type: 'response.created' });
  serverEvent(h, { type: 'response.done' }); // user's turn completes -> idle -> queued flush fires

  expect(h.session.getState()).toBe('awaitingResponse'); // now the injection's own turn
  const sent = lastSent(h);
  expect(sent[sent.length - 2]).toEqual({ type: 'conversation.item.create', item: { text: 'completion narration' } });
  expect(sent[sent.length - 1]).toEqual({ type: 'response.create' });
});

test('VoiceSession.queueInjection: queued while speaking waits for response.done before flushing', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  h.session.pttRelease();
  serverEvent(h, { type: 'response.created' });
  expect(h.session.getState()).toBe('speaking');

  h.session.queueInjection([{ text: 'later' }]);
  expect(h.session.getState()).toBe('speaking');

  serverEvent(h, { type: 'response.done' });
  expect(h.session.getState()).toBe('awaitingResponse');
  const sent = lastSent(h);
  expect(sent[sent.length - 2]).toEqual({ type: 'conversation.item.create', item: { text: 'later' } });
  expect(sent[sent.length - 1]).toEqual({ type: 'response.create' });
});

test('VoiceSession.queueInjection: two queued batches drain one at a time, never both in the same idle tick', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.queueInjection([{ text: 'first' }]);
  h.session.queueInjection([{ text: 'second' }]);

  // Only the first batch flushed (state moved to awaitingResponse before the second could).
  expect(lastSent(h)).toEqual([{ type: 'conversation.item.create', item: { text: 'first' } }, { type: 'response.create' }]);

  serverEvent(h, { type: 'response.created' });
  serverEvent(h, { type: 'response.done' }); // first batch's response completes -> idle -> second flushes

  const sent = lastSent(h);
  expect(sent[sent.length - 2]).toEqual({ type: 'conversation.item.create', item: { text: 'second' } });
  expect(sent[sent.length - 1]).toEqual({ type: 'response.create' });
});

// =================================================================================================
// Lifecycle: proactive re-mint quiescence gating + recap carry-over
// =================================================================================================

test('VoiceSession: proactive re-mint fires immediately from idle and injects the recap into the new session', async () => {
  const h = makeHarness({ getRecap: () => 'we fixed the ENOENT bug', agentId: 'agent-9' });
  await h.session.connect();
  expect(h.timers).toHaveLength(1);
  expect(h.timers[0]!.ms).toBe(55 * 60_000);

  const dueFn = h.timers[0]!.fn;
  dueFn(); // simulate the timer firing while idle

  await flush();

  expect(h.mintCalls).toBe(2); // original connect + rotation mint
  expect(h.reconnected).toEqual([{ recap: 'we fixed the ENOENT bug' }]);
  const sent = lastSent(h);
  expect(sent).toEqual([
    {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: '[Voice session carried over from a prior connection. Bound console agent: agent-9.]\nwe fixed the ENOENT bug' }],
      },
    },
  ]);
  // A fresh re-mint timer was scheduled for the new session.
  expect(h.timers).toHaveLength(1);
});

test('GAP-1: setAgentId lets a bootstrap call (no agentId at construction) carry the real binding into rotation, instead of a permanently blank line', async () => {
  const h = makeHarness({ getRecap: () => 'spun up a fresh console agent', agentId: undefined });
  await h.session.connect();

  // The bind happens mid-call, well after connect() — exactly the bootstrap-call shape GAP-1
  // describes: no agent was bound at construction time.
  h.session.setAgentId('agent-42');

  const dueFn = h.timers[0]!.fn;
  dueFn(); // proactive re-mint fires from idle
  await flush();

  const sent = lastSent(h);
  expect(sent).toEqual([
    {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: '[Voice session carried over from a prior connection. Bound console agent: agent-42.]\nspun up a fresh console agent' }],
      },
    },
  ]);
});

test('GAP-1: setAgentId(undefined) is also honored — a dead-agent recovery clearing the binding does not leave a stale agentId in the next carry-over', async () => {
  const h = makeHarness({ getRecap: () => 'recap', agentId: 'agent-old' });
  await h.session.connect();

  h.session.setAgentId(undefined);

  const dueFn = h.timers[0]!.fn;
  dueFn();
  await flush();

  const sent = lastSent(h);
  const text = (sent[0]!.item as { content: [{ text: string }] }).content[0].text;
  expect(text).not.toContain('agent-old');
  expect(text).toBe('[Voice session carried over from a prior connection.]\nrecap');
});

test('VoiceSession: proactive re-mint due mid-recording waits for quiescence instead of rotating immediately', async () => {
  const h = makeHarness({ getRecap: () => 'recap text' });
  await h.session.connect();
  h.session.pttPress(); // not quiescent

  const dueFn = h.timers[0]!.fn;
  dueFn(); // re-mint due while userRecording

  await Promise.resolve();
  expect(h.mintCalls).toBe(1); // NOT rotated yet — still the original connect mint
  expect(h.reconnected).toEqual([]);

  h.session.pttRelease();
  serverEvent(h, { type: 'response.created' });
  serverEvent(h, { type: 'response.done' }); // now idle — the deferred re-mint should fire

  await flush();

  expect(h.mintCalls).toBe(2);
  expect(h.reconnected).toEqual([{ recap: 'recap text' }]);
});

test('VoiceSession: proactive re-mint due mid-tool-call also waits for quiescence', async () => {
  const h = makeHarness({ getRecap: () => 'r' });
  await h.session.connect();
  h.session.pttPress();
  h.session.pttRelease();
  serverEvent(h, { type: 'response.created' });
  serverEvent(h, { type: 'response.function_call_arguments.done', call_id: 'c1', name: 'fleet_status', arguments: '{}' });
  expect(h.session.getState()).toBe('toolPending');

  h.timers[0]!.fn(); // due while toolPending
  await Promise.resolve();
  expect(h.mintCalls).toBe(1);

  // The wrapping response (the one that carried the function call) completes first — per
  // CRITICAL-1's correlation, this alone must NOT be enough to reach idle: the ack hasn't even
  // been sent yet, so the reducer stays toolPending.
  serverEvent(h, { type: 'response.done' });
  expect(h.session.getState()).toBe('toolPending');
  expect(h.mintCalls).toBe(1);

  h.session.sendFunctionOutput('c1', { ok: true });
  serverEvent(h, { type: 'response.done' }); // the ack's OWN response completes -> idle
  await flush();

  expect(h.mintCalls).toBe(2);
});

// =================================================================================================
// MAJOR-4: establishConnection resets state through dispatch, not a direct field assignment — so a
// reconnect while the machine was NOT idle fires onStateChange (fixing a stale HUD) and stops any
// local playback, instead of silently overwriting `state` with nothing observing the change.
// =================================================================================================

test('MAJOR-4: a reconnect while speaking notifies onStateChange back to idle and stops playback (no stale HUD)', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  h.session.pttRelease();
  serverEvent(h, { type: 'response.created' });
  expect(h.session.getState()).toBe('speaking');
  h.states.length = 0; // ignore the states seen so far — only care about the reconnect's own transition
  const stopPlaybackBefore = h.stopPlaybackCalls;

  const dc = h.dataChannels[0]!;
  dc.onclose?.(); // unexpected drop while speaking
  await flush();

  expect(h.states).toContain('idle'); // onStateChange fired — the HUD is told, not left stale
  expect(h.stopPlaybackCalls).toBeGreaterThan(stopPlaybackBefore);
  expect(h.session.getState()).toBe('idle');
});

test('MAJOR-4: a PTT held across a rotation is documented as silently swallowed on release', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  expect(h.session.getState()).toBe('userRecording');

  // Reconnect happens out from under the held PTT (e.g. an unexpected drop mid-recording).
  const dc = h.dataChannels[0]!;
  dc.onclose?.();
  await flush();
  expect(h.session.getState()).toBe('idle'); // reset forced the machine back to idle

  // The user finally releases the (still physically held, from their POV) button. Nothing is sent —
  // idle+ptt-release is a designated no-op (see NOOP_CELLS) — this is the documented limitation, not
  // a crash or a silently-wrong response.create.
  const before = lastSent(h).length;
  h.session.pttRelease();
  expect(h.session.getState()).toBe('idle');
  expect(lastSent(h).length).toBe(before);
});

// =================================================================================================
// MAJOR-5: generation/epoch guard — disconnect() during an in-flight connect/rotate/reconnect must
// not be resurrected by the awaited continuation.
// =================================================================================================

test('MAJOR-5: disconnect() during an in-flight connect() prevents the connection from completing', async () => {
  const h = makeHarness();
  const connecting = h.session.connect();
  // disconnect() fires before getUserMedia/mint/SDP exchange have resolved.
  h.session.disconnect();
  await connecting;
  await flush();

  expect(h.session.getState()).toBe('idle');
  // The stream acquired by the in-flight connect() was stopped, not left running.
  expect(h.micStreams[0]?.track.stopped).toBe(true);
});

test('MAJOR-5: disconnect() during a proactive rotation does not resurrect connected=true or reschedule the timer', async () => {
  const h = makeHarness({ getRecap: () => 'recap' });
  await h.session.connect();
  const dueFn = h.timers[0]!.fn;
  dueFn(); // starts rotateSession(); suspends awaiting mint()

  h.session.disconnect(); // fires while the rotation is mid-flight
  await flush();

  expect(h.reconnected).toEqual([]); // the rotation never got to report success
  expect(h.timers).toHaveLength(0); // no re-mint timer left scheduled behind a disconnected session
});

test("MAJOR-5: a straggling re-mint timer firing after disconnect() doesn't crash or report a spurious reconnect-failed", async () => {
  const h = makeHarness({ getRecap: () => 'recap' });
  await h.session.connect();
  const staleDueFn = h.timers[0]!.fn; // capture the callback reference before disconnect() clears it

  h.session.disconnect(); // clears the timer bookkeeping AND nulls micStream

  // Simulate the stale callback still firing (as if clearTimer raced an already-queued macrotask):
  // without the micStream guard, rotateSession would dereference `this.micStream!` (now undefined)
  // and throw inside establishConnection, surfacing as a spurious reconnect-failed right after a
  // clean hangup.
  staleDueFn();
  await flush();

  expect(h.errors).toEqual([]);
  expect(h.reconnected).toEqual([]);
});

// =================================================================================================
// MAJOR-6: an injection queued during a connection rotation is not destroyed — it stays queued
// until the new data channel is actually open, then flushes.
// =================================================================================================

test('MAJOR-6: an injection queued mid-rotation is NOT dropped — it flushes once the new channel is ready', async () => {
  const h = makeHarness();
  await h.session.connect();
  expect(h.session.getState()).toBe('idle');

  const dueFn = h.timers[0]!.fn;
  dueFn(); // starts rotateSession(): teardownConnection() runs synchronously, then suspends at mint()

  // At this instant the data channel is torn down (undefined) but state is still idle.
  h.session.queueInjection([{ text: 'narration queued mid-rotation' }]);
  expect(h.session.getState()).toBe('idle'); // NOT moved to awaitingResponse with no connection behind it

  await flush();

  // The new connection is up and the queued batch flushed through the NEW data channel.
  expect(h.session.getState()).toBe('awaitingResponse');
  const sent = lastSent(h);
  expect(sent[sent.length - 2]).toEqual({ type: 'conversation.item.create', item: { text: 'narration queued mid-rotation' } });
  expect(sent[sent.length - 1]).toEqual({ type: 'response.create' });
});

// =================================================================================================
// Bounded reconnect: one silent retry, then onError with fallbackToText
// =================================================================================================

test('VoiceSession: a data-channel close that recovers on the first reconnect attempt is silent (no onError)', async () => {
  const h = makeHarness();
  await h.session.connect();
  const dc = h.dataChannels[0]!;

  dc.onclose?.();
  await flush();

  expect(h.errors).toEqual([]);
  expect(h.reconnected).toEqual([{ recap: '' }]);
  expect(h.mintCalls).toBe(2); // original + the one reconnect mint
});

test('MINOR-7: a small delay separates the two bounded reconnect attempts (no back-to-back hammering)', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.postSdpOfferImpl = async () => {
    throw new Error('provider unreachable');
  };
  const dc = h.dataChannels[0]!;

  dc.onclose?.();
  await flush();

  // The first attempt has already failed; the second is waiting on the inter-attempt delay timer,
  // not on a microtask — so without firing it, we're still short of the terminal error.
  expect(h.errors).toEqual([]);
  expect(h.reconnected).toEqual([]);

  fireTimer(h, 500);
  await flush();

  expect(h.reconnected).toEqual([]);
  expect(h.errors).toEqual([
    { code: 'reconnect-failed', message: 'The voice session was lost and could not be restored.', fallbackToText: true },
  ]);
});

test('VoiceSession: bounded reconnect — first attempt fails silently, the retry also fails -> exactly one onError with fallbackToText', async () => {
  const h = makeHarness();
  await h.session.connect();
  // Every reconnect attempt from here fails.
  h.postSdpOfferImpl = async () => {
    throw new Error('provider unreachable');
  };
  const dc = h.dataChannels[0]!;

  dc.onclose?.();
  await flush();
  fireTimer(h, 500); // the inter-attempt delay (MINOR-7)
  await flush();

  expect(h.reconnected).toEqual([]);
  expect(h.errors).toEqual([
    { code: 'reconnect-failed', message: 'The voice session was lost and could not be restored.', fallbackToText: true },
  ]);
});

test('MINOR-7: incidents within 60s count as one flapping streak — past the threshold, voice gives up without re-minting forever', async () => {
  const h = makeHarness();
  await h.session.connect();

  // Three incidents in a row, each recovering cleanly on its own first attempt, all inside the 60s
  // window — none of these alone would ever hit the bounded-retry failure path.
  for (let i = 0; i < 3; i++) {
    h.nowValue += 1_000;
    h.dataChannels[h.dataChannels.length - 1]!.onclose?.();
    await flush();
  }
  expect(h.errors).toEqual([]); // still recovering silently — 3 is at (not past) the threshold

  // A 4th incident inside the window pushes the streak past MAX_CONSECUTIVE_INCIDENTS: voice gives
  // up immediately rather than attempting (and silently re-succeeding at) yet another reconnect.
  h.nowValue += 1_000;
  const mintCallsBefore = h.mintCalls;
  h.dataChannels[h.dataChannels.length - 1]!.onclose?.();
  await flush();

  expect(h.errors).toEqual([
    { code: 'reconnect-failed', message: 'The voice connection is unstable and could not be kept alive.', fallbackToText: true },
  ]);
  expect(h.mintCalls).toBe(mintCallsBefore); // no further reconnect attempt was even made
});

test('MINOR-7: incidents more than 60s apart do NOT accumulate into the same flapping streak', async () => {
  const h = makeHarness();
  await h.session.connect();

  for (let i = 0; i < 5; i++) {
    h.nowValue += 61_000; // always outside the incident window relative to the previous one
    h.dataChannels[h.dataChannels.length - 1]!.onclose?.();
    await flush();
  }

  expect(h.errors).toEqual([]); // every incident reset the streak — never reaches the threshold
});

test('MINOR-14: a terminal reconnect-failed stops the mic tracks (falling back to text, mic should go dark)', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.postSdpOfferImpl = async () => {
    throw new Error('provider unreachable');
  };
  const dc = h.dataChannels[0]!;
  dc.onclose?.();
  await flush();
  fireTimer(h, 500);
  await flush();

  expect(h.errors[0]?.code).toBe('reconnect-failed');
  expect(lastMicTrack(h).stopped).toBe(true);
});

test('MAJOR-4: disconnect() with a queued injection and a non-idle state lands cleanly on idle (no errant flush through the closing channel)', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  h.session.pttRelease();
  serverEvent(h, { type: 'response.created' });
  expect(h.session.getState()).toBe('speaking');
  h.session.queueInjection([{ text: 'never sent' }]); // queued, waiting for quiescence

  h.session.disconnect();

  // The reset->idle transition must NOT flush the queued batch through the channel being torn down.
  expect(h.session.getState()).toBe('idle');
  expect(h.dataChannels[0]!.sent.some((s) => (s as { item?: { text?: string } }).item?.text === 'never sent')).toBe(false);
});

test('VoiceSession: disconnect() never triggers the unexpected-disconnect reconnect path', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.disconnect();
  await flush();

  expect(h.errors).toEqual([]);
  expect(h.reconnected).toEqual([]);
  expect(h.mintCalls).toBe(1); // no reconnect mint attempted
});

// =================================================================================================
// ek_ hygiene: the minted secret never appears in a log call or in anything this module exposes
// =================================================================================================

test('ek_ hygiene: the minted token value never appears in a console.* call across connect, PTT, tool-call, re-mint, and reconnect', async () => {
  const logCalls: unknown[][] = [];
  const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((method) =>
    spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logCalls.push(args);
    }),
  );

  try {
    const h = makeHarness({ getRecap: () => 'recap' });
    await h.session.connect();
    h.session.pttPress();
    h.session.pttRelease();
    serverEvent(h, { type: 'response.created' });
    serverEvent(h, { type: 'response.function_call_arguments.done', call_id: 'c1', name: 'fleet_status', arguments: '{}' });
    serverEvent(h, { type: 'response.done' }); // the wrapping response completes
    h.session.sendFunctionOutput('c1', { ok: true });
    serverEvent(h, { type: 'response.done' }); // the ack's own response completes -> idle
    h.timers[0]?.fn(); // proactive re-mint, now actually idle
    await flush();
    const dc = h.dataChannels[h.dataChannels.length - 1]!;
    dc.onclose?.(); // unexpected drop -> reconnect
    await flush();

    const serialized = JSON.stringify(logCalls);
    expect(serialized).not.toMatch(/ek_fake_/);

    // Also never returned from any public method's observable surface.
    expect(JSON.stringify(h.states)).not.toMatch(/ek_fake_/);
    expect(JSON.stringify(h.reconnected)).not.toMatch(/ek_fake_/);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});

// =================================================================================================
// Wedge watchdog (live bug 2026-07-15: the HUD sat on "Thinking…" forever after a mid-call audio
// cutoff). `awaitingResponse` has no guaranteed outbound edge — a response.create silently dropped
// on a non-open channel (sendRaw drops, never queues) leaves the machine waiting for a
// response.created that can never come. The watchdog recovers it back to idle.
// =================================================================================================

test('wedge watchdog: a release whose sends were dropped (channel closed) recovers to idle AND silently reconnects', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.dataChannels[0]!.readyState = 'closing'; // sends will silently drop from here on
  h.session.pttPress();
  h.session.pttRelease(); // commit + response.create both dropped -> outstanding stays 0
  expect(h.session.getState()).toBe('awaitingResponse'); // the wedge shape: waiting on nothing

  h.nowValue = 13_000; // past AWAITING_WEDGE_MS (12s of zero server events)
  fireTimer(h, 5_000); // the watchdog poll

  expect(h.session.getState()).toBe('idle'); // recovered — the operator can talk again
  expect(h.stopPlaybackCalls).toBeGreaterThanOrEqual(1); // recovery goes through reset
  await flush();
  // The wedge is dead-connection evidence — recovery rebuilds the connection, same as a channel
  // close would (live evidence 2026-07-15: ICE death never fires dc.onclose).
  expect(h.mintCalls).toBe(2);
  expect(h.dataChannels).toHaveLength(2);
  expect(h.reconnected).toEqual([{ recap: '' }]);
});

test('wedge watchdog: a create in flight with 12s of TOTAL silence (no events at all) is also declared dead and reconnected', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  h.session.pttRelease(); // create actually sent -> outstanding = 1, but the connection is dead: nothing ever comes back
  expect(h.session.getState()).toBe('awaitingResponse');

  h.nowValue = 13_000;
  fireTimer(h, 5_000);
  expect(h.session.getState()).toBe('idle');
  await flush();
  expect(h.dataChannels).toHaveLength(2); // silently rebuilt
});

test('wedge watchdog: transcript deltas refresh liveness — a long wrapping narration behind a deferred ack is never cut off', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  h.session.pttRelease();
  serverEvent(h, { type: 'response.created' });
  serverEvent(h, { type: 'response.function_call_arguments.done', call_id: 'c1', name: 'fleet_status', arguments: '{}' });
  h.session.sendFunctionOutput('c1', { ok: true }); // ack -> awaitingResponse, create DEFERRED behind the wrapping response
  expect(h.session.getState()).toBe('awaitingResponse');

  h.nowValue = 39_000;
  serverEvent(h, { type: 'response.output_audio_transcript.delta', delta: 'still narrating…' }); // sign of life

  h.nowValue = 45_000; // 45s in, but only 6s since the last delta
  fireTimer(h, 5_000);
  expect(h.session.getState()).toBe('awaitingResponse'); // NOT recovered — the turn is demonstrably alive
});

test('wedge watchdog: leaving awaitingResponse normally disarms the poll (no stray 5s timer left behind)', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  h.session.pttRelease();
  expect(h.timers.some((t) => t.ms === 5_000)).toBe(true); // armed on entry
  serverEvent(h, { type: 'response.created' }); // -> speaking
  expect(h.timers.some((t) => t.ms === 5_000)).toBe(false); // disarmed on exit
});

test('resync end-to-end: a response.created arriving while idle moves the machine to speaking and resumes playback', async () => {
  const h = makeHarness();
  await h.session.connect();
  expect(h.session.getState()).toBe('idle');
  serverEvent(h, { type: 'response.created', response: { id: 'resp-stray' } });
  expect(h.session.getState()).toBe('speaking');
  expect(h.resumePlaybackCalls).toBe(1);
  serverEvent(h, { type: 'response.done', response: { id: 'resp-stray' } });
  expect(h.session.getState()).toBe('idle');
});

// =================================================================================================
// Diagnostic ring buffer (getDebugLog) — the live-triage flight recorder.
// =================================================================================================

test('getDebugLog records sends, receives, state transitions, ptt calls, and dropped sends', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  h.session.pttRelease();
  serverEvent(h, { type: 'response.created', response: { id: 'resp-1' } });

  const log = h.session.getDebugLog();
  const labels = log.map((e) => `${e.kind}:${e.label}`);
  expect(labels).toContain('ptt:press');
  expect(labels).toContain('ptt:release');
  expect(labels).toContain('send:input_audio_buffer.commit');
  expect(labels).toContain('send:response.create');
  expect(labels).toContain('recv:response.created');
  expect(labels).toContain('state:userRecording -> awaitingResponse');

  h.dataChannels[0]!.readyState = 'closed';
  h.session.pttPress(); // a barge-in press: its cancel + clear sends are both dropped and logged
  const dropped = h.session.getDebugLog().filter((e) => e.label.startsWith('send-dropped')).map((e) => e.label);
  expect(dropped).toContain('send-dropped response.cancel');
  expect(dropped).toContain('send-dropped input_audio_buffer.clear');
});

test('getDebugLog never contains caption/transcript text (event types and ids only)', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.pttPress();
  h.session.pttRelease();
  serverEvent(h, { type: 'response.created' });
  serverEvent(h, { type: 'response.output_audio_transcript.delta', delta: 'SECRET SPOKEN CONTENT', item_id: 'item-1' });
  serverEvent(h, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'item-u1', transcript: 'SECRET USER WORDS' });
  expect(JSON.stringify(h.session.getDebugLog())).not.toMatch(/SECRET/);
});

test('silent ICE death: connectionState "failed" triggers the same bounded silent reconnect a channel close does', async () => {
  const h = makeHarness();
  await h.session.connect();
  expect(h.dataChannels).toHaveLength(1);

  const pc = h.pcs[0]! as PeerConnectionLike & { connectionState: string };
  pc.connectionState = 'failed';
  pc.onconnectionstatechange?.();
  await flush();

  expect(h.mintCalls).toBe(2);
  expect(h.dataChannels).toHaveLength(2);
  expect(h.reconnected).toEqual([{ recap: '' }]);
});

test('connectionState "disconnected" alone does NOT reconnect (transient flaps) — only "failed" does', async () => {
  const h = makeHarness();
  await h.session.connect();
  const pc = h.pcs[0]! as PeerConnectionLike & { connectionState: string };
  pc.connectionState = 'disconnected';
  pc.onconnectionstatechange?.();
  await flush();
  expect(h.mintCalls).toBe(1);
  expect(h.dataChannels).toHaveLength(1);
});

// =================================================================================================
// Context brief + silent context updates (live gap 2026-07-15: "tell me about this repository" ->
// "which repository?" — the voice model knew nothing about the project/screen).
// =================================================================================================

test('getContextBrief is injected as a system item on connect, before anything else is sent', async () => {
  const h = makeHarness({ getContextBrief: () => '[Session context]\nActive project: omp-squad' });
  await h.session.connect();
  const sent = lastSent(h);
  expect(sent[0]).toEqual({
    type: 'conversation.item.create',
    item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: '[Session context]\nActive project: omp-squad' }] },
  });
});

test('a silent reconnect re-injects a FRESH context brief into the new session', async () => {
  let brief = '[Session context]\nActive project: alpha';
  const h = makeHarness({ getContextBrief: () => brief });
  await h.session.connect();

  brief = '[Session context]\nActive project: beta'; // the world moved while the call was live
  const dc = h.dataChannels[0]!;
  dc.onclose?.(); // unexpected drop -> silent reconnect
  await flush();

  expect(h.dataChannels).toHaveLength(2);
  const sentOnNew = h.dataChannels[1]!.sent;
  expect(sentOnNew[0]).toEqual({
    type: 'conversation.item.create',
    item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: '[Session context]\nActive project: beta' }] },
  });
});

test('an empty getContextBrief injects nothing', async () => {
  const h = makeHarness({ getContextBrief: () => '' });
  await h.session.connect();
  expect(lastSent(h)).toEqual([]);
});

test('updateSystemContext sends a bare system item immediately on an open channel — and never a response.create', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.updateSystemContext('[Context update]\nView: tasks');
  const sent = lastSent(h);
  expect(sent).toEqual([
    { type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: '[Context update]\nView: tasks' }] } },
  ]);
  expect(h.session.getState()).toBe('idle'); // silent — no turn was started
});

test('updateSystemContext queues while the channel is not yet open and flushes on dc.onopen', async () => {
  const h = makeHarness();
  await h.session.connect();
  const dc = h.dataChannels[0]!;
  dc.readyState = 'connecting';
  h.session.updateSystemContext('[Context update]\nView: fleet');
  expect(dc.sent).toEqual([]); // parked, NOT silently dropped

  dc.readyState = 'open';
  dc.onopen?.();
  expect(dc.sent).toEqual([
    { type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: '[Context update]\nView: fleet' }] } },
  ]);
});

test('updateSystemContext with blank text is a no-op', async () => {
  const h = makeHarness();
  await h.session.connect();
  h.session.updateSystemContext('   ');
  expect(lastSent(h)).toEqual([]);
});
