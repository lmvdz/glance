# xAI Grok Voice as second provider (deferred — verify feasibility first)
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: research
TOUCHES: webapp/src/lib/voice/provider.ts, src/voice-token.ts, webapp/src/lib/voice/voiceSession.ts
BLOCKED_BY: 07

## Goal
Grok Voice (`grok-voice-latest`, flat $0.05/min, OpenAI-Realtime-compatible events) as the second lineage behind the VoiceProvider seam. Deliberately deferred from v1: two research passes contradict each other on transport, and the fallback path is a large subsystem.

## Approach
Live-verify BEFORE building anything (an API key and an evening, not a sprint):
1. **Does Grok Voice speak WebRTC from a browser?** The vendor sweep said "WebSocket + WebRTC"; the API-shape scout found only the WebSocket flow documented (`wss://api.x.ai/v1/realtime?model=...` with the ephemeral token as subprotocol `xai-client-secret.<token>` — browsers can't set WS headers). If WebRTC works: xAI becomes a mint-shape variant of the existing transport, and the websocket transport axis is DELETED from the seam. If not, decide whether the WS path is worth it (see 3).
2. **Mint shape**: `POST https://api.x.ai/v1/realtime/client_secrets` confirmed to take only `expires_after.seconds` — NO session pinning. That makes xAI an unpinned provider: the browser sets model/voice/instructions via the first `session.update`. Permitted only because Grok's pricing is flat (the seam's `pinnedAtMint:false` ⇒ `flatPrice:true` assertion from concern 05); response schema unconfirmed — capture it live.
3. **If WS-only**: the browser WS path is a real subsystem — AudioContext/worklet capture, PCM16@24kHz resample, base64 `input_audio_buffer.append`, jitter-buffered playback, client-side barge-in truncation (`conversation.item.truncate`) + local buffer flush. Cost it honestly against the value of a second lineage before committing; a daemon-side relay (DESIGN.md architecture B) may be the cheaper route to xAI and non-browser clients at once.
4. Event-naming diffs are documented as minor (e.g. `input_audio_transcription.updated` vs `.delta`) — map them in the provider config, not with conditionals through voiceSession.

## Cross-Repo Side Effects
None.

## Verify
- A recorded feasibility note in this concern (WebRTC yes/no, mint response schema, any event diffs observed live) — that's the research deliverable; implementation follows as its own scoped work once the transport question is settled.
