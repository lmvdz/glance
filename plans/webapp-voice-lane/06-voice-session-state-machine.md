# Voice session state machine + WebRTC transport (OpenAI)
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/lib/voice/provider.ts, webapp/src/lib/voice/voiceSession.ts, webapp/src/lib/voice/voiceSession.test.ts, webapp/src/lib/api.ts
BLOCKED_BY: 05

## Goal
The realtime voice session as an explicitly-modeled state machine over a browser-direct WebRTC connection to OpenAI. This is the repo's first provider-direct client surface and the highest-implementation-risk piece — it ships alone, before the tool dispatcher lands on top.

## Approach
- `webapp/src/lib/voice/provider.ts`: `VoiceProviderConfig {id, transport: 'webrtc'|'websocket', pinnedAtMint: boolean, flatPrice: boolean}` — type + the single `openai` entry (webrtc, pinned). The websocket variant of the type exists but has no implementation in v1 (concern 09).
- `webapp/src/lib/api.ts`: `mintVoiceToken()` / `getVoiceConfig()` helpers beside `apiJson`.
- `webapp/src/lib/voice/voiceSession.ts` — framework-free class/closure (React wiring comes in 07/08):
  - **Connect**: mint via daemon → `RTCPeerConnection` + mic track + data channel → `createOffer()` → POST raw SDP to `https://api.openai.com/v1/realtime/calls` with `Authorization: Bearer <ek_>` + `Content-Type: application/sdp` → `setRemoteDescription(answer)`. Remote audio via `ontrack` → `<audio>` element. (GA flow, verified 2026-07-10; model/voice/instructions are pinned at mint, NOT sent from the browser.)
  - **States**: `idle | userRecording | awaitingResponse | speaking | toolPending` with two arbitration rules that ARE the barge-in machinery: (1) PTT-press while `speaking` → `response.cancel` + local playback stop (WebRTC truncates server-side); (2) no `response.create` is ever emitted while `userRecording` — queued injections wait for PTT release.
  - **PTT** (`turn_detection: null`, pinned at mint): press → capture; release → `input_audio_buffer.commit` + `response.create`.
  - **Event surface**: emits typed events (state changes, live captions from transcription deltas, `function_call` items, errors) for 07/08 to consume; owns no fleet logic.
  - **Lifecycle**: 60-min provider cap → proactive re-mint at ~55 min, **only from a quiescent state** (not speaking/userRecording/toolPending — wait, then rotate). Carry-over: a rolling summary + the bound console agentId injected into the new session's opening context (mint instructions are static, so inject via `conversation.item.create` on the new session); emit a `reconnected` event for the HUD notice. Token expiry mid-session: one silent re-mint-and-reconnect, second consecutive failure within a short window → surface fallback-to-text (bounded retry, never silent-forever).
  - **Failure modes**: mic `getUserMedia` denied → distinct error event, no re-prompt loop; mint 4xx/5xx → error event (UI falls back to text composer); data-channel close → same bounded reconnect as expiry.
  - **`ek_` hygiene**: memory-only, never localStorage, never console.log.

## Cross-Repo Side Effects
None.

## Verify
- Unit tests: state transitions (all events against all states — especially the two arbitration rules), reconnect bounding, re-mint quiescence gating (fake timers), no `response.create` during `userRecording`.
- Live probe (real key, scratch daemon): hold a session ≥10 minutes fully silent to observe **provider idle-timeout behavior** — the one open research item from design; record the finding in this concern's Resolution (it calibrates the reconnect logic). Then: speak → hear reply; press PTT mid-reply → playback stops immediately; session survives a forced re-mint with context recap.

## Resolution
Shipped (commits 921447a, 593bc16, 75e7768). Pure 5-state reducer + DI'd impure shell; both barge-in arbitration rules structural. Audit gauntlet hardened the protocol: tool-ack `response.create` deferred until the wrapping `response.done` (a concurrent create is rejected by the Realtime API), playback resumes after barge-in, comprehensive hot-mic guards, trigger fails closed on absent `response_id`, SDP timeout/abort. Focused re-review PASS'd with a proof that `outstandingResponses ∈ {0,1}`.
**Live-verification 2026-07-13 (real key, scratch daemon, headless Chrome with fake-mic-from-WAV):**
- **SHIP-BLOCKER found live and fixed**: the daemon's CSP served `connect-src 'self'`, so the browser
  could NEVER post the SDP offer to the provider — every call died silently right after a successful
  mint. Nothing in four reviews caught it because nothing drove the served page against the real
  endpoint. Fixed in `securityHeaders()`: the keyed provider's origin joins `connect-src` only while
  `OMP_SQUAD_VOICE_ENABLED` AND a key are both present (`voiceConnectSrcOrigins()`), regression-pinned
  in both directions (tests/ws-auth.test.ts).
- **Verified live**: capability probe (`{enabled:true, providers:[openai/webrtc/gpt-realtime-2.1]}`),
  `POST /api/voice/token` through the real route → 200 + real `ek_`; the `ek_` is ACCEPTED by
  `POST /v1/realtime/calls` (a malformed probe offer draws `400 invalid_offer`, not 401 — auth and
  session config are sound).
- **"Silent SDP failure" — RETRACTED as an instrumentation artifact**: the earlier watch required
  `position:fixed/absolute` leaf nodes and TaskContext's toast text sits in a statically-positioned
  child, so it was invisible to that probe. A later position-agnostic watch caught the idle-cap toast
  on the SAME channel (`showToast`), and code-reading shows the connect-failed emit (`voiceSession`
  catch → `onError` → `errorToastMessage`) is sound. No product defect established here.
- **FUNDED LIVE PASS (2026-07-13, $10 credit added) — the owed probes ran:**
  - **Idle probe (the design's open research item), ANSWERED**: a fully-silent live session stayed up
    for the entire observable window — the provider NEVER closed it. Our own MEDIUM-6 10-min PTT-idle
    cap fired first, exactly on schedule (`dc:close` at +635s, correct "ended automatically after 10
    minutes of inactivity" toast, clean teardown). In production the client cap is the binding
    constraint; idleness will practically never exercise reconnect. (Caveat: the ek_ TTL ≈ the cap ≈
    10 min, so provider-close-at-ek_-expiry is indistinguishable in-window — moot, since the ek_ is a
    handshake credential and rotation mints fresh.)
  - **Speak → reply, HUMAN-VERIFIED**: fake-mic WAV ("count slowly to thirty") → server VAD → real
    assistant audio reply — the operator physically heard it. `audio:play` fired 1s after PTT lock;
    bidirectional RTP confirmed flowing (outbound mic ~1.6KB/s, inbound assistant ~3.1KB/s).
  - **Mid-session reconnect, VERIFIED LIVE (unplanned but real)**: after a data-channel drop during a
    turn-arbitration stress sequence, the session silently re-minted and reconnected with **zero
    user action and the call pill LIVE throughout** (+247s: mint 200 → SDP 201 → connected, no
    visible flicker). The expiry/drop→re-mint lane works end-to-end against the real provider.
  - **Barge-in: machinery exercised live, clean capture still open.** The looped fake-mic speech
    continuously re-triggered turns, so cancel/stopPlayback/resumePlayback all ran (post-barge-in
    `resumePlayback` on `response.created` observed as repeated `audio:play`), but a surgical
    "PTT-down mid-reply → `audio:pause` within N ms" trace was not isolated — the loop file makes
    the state ambient. Both arbitration rules remain structurally unit-pinned; a 30-second human
    test with a real mic (now trivially possible — the lane audibly works) closes this.
  - **55-min proactive rotation**: not soaked (our 10-min idle cap requires periodic activity through
    an hour-long call). `reMintAfterMs` is DI-injected and fake-timer unit-tested; the observed live
    mid-session re-mint covers the same mint→reconnect mechanics the rotation uses.
