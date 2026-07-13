# Research Brief: Speech-to-Speech Voice Agents for the glance Web UI

- **Date**: 2026-07-10
- **Trigger**: `/research https://developers.openai.com/api/docs/guides/voice-agents for speech to speech on webui`, widened by user request to survey all speech-to-speech alternatives ranked by pricing and voice quality.
- **Target project**: glance (omp-squad) — daemon-orchestrated agent fleet; React 19/Vite/Tailwind webapp (`webapp/`) talking to the daemon over one WebSocket (`/ws`) + flat REST (`/api/*`) in `src/server.ts`.
- **Sources**: all fetched 2026-07-10. Primary: developers.openai.com voice-agents/realtime/pricing guides, openai.github.io Agents SDK (JS + Python), ai.google.dev Gemini Live + pricing, docs.x.ai voice-agent + pricing, elevenlabs.io/pricing/agents, hume.ai/pricing, deepgram.com/pricing, cartesia.ai/pricing, livekit.com/pricing, vapi.ai/pricing, retellai.com/pricing, daily.co/pricing/pipecat-cloud, learn.microsoft.com voice-live, AWS Nova Sonic model card, github.com/kyutai-labs/unmute, assemblyai.com voice-agent pages. Quality evidence: arXiv 2603.13686 (τ-voice, Sierra), arXiv 2605.13841 (EVA-Bench), artificialanalysis.ai/speech-to-speech, AA Speech Arena Elo (via 2026-05 snapshot; AA's own page is JS-rendered and unfetchable), sesame.com CMOS blog, HN thread 46235131, TechCrunch 2026-07-08 GPT-Live launch coverage. Full per-claim provenance in the scout sections below.
- **Confidence flags**: WebFetch summarizes pages via a small model, so exact figures are best-effort extractions. OpenAI realtime model version labels were inconsistent across their own pages (`gpt-realtime-2.1` vs `-2` vs `-1.5`) — spot-check before shipping. Vendor-authored benchmarks (Deepgram VAQI, Amazon Nova Sonic report) are flagged, not trusted.

---

## 1. The landscape, ranked

The user's ask: list speech-to-speech options by pricing and how well the voice agent sounds. Two quality axes matter and they diverge: **(a) raw voice naturalness** and **(b) conversational competence** (turn-taking, barge-in, latency feel, task completion). Best independent evidence: τ-voice (Sierra, arXiv 2603.13686), EVA-Bench (arXiv 2605.13841), Artificial Analysis arenas.

Sorted by approximate cost per conversation-minute:

| # | Option | Architecture | ~$/min | Voice naturalness | Conversational competence | Browser story |
|---|--------|-------------|--------|-------------------|---------------------------|---------------|
| 1 | Self-hosted: Kyutai Moshi/Unmute (MIT), Sesame CSM-1B (Apache 2.0) | Native S2S / chained wrapper | ~$0 + GPU (≥16GB VRAM) | NO independent data; Sesame's own CMOS study shows a real gap vs humans once context matters | No independent data (vendor: Moshi ~200ms) | None — self-host everything |
| 2 | Amazon Nova Sonic | Native S2S | ~$0.015 (LOW-conf) | Vendor-only claims | Vendor-only claims | None (server-side Bedrock) — **and EOL 2026-09-14, do not build on it** |
| 3 | Google Gemini Live (2.5 Flash native audio / 3.1 Flash Live) | Native S2S | ~$0.023 (derived from $3/$12 per 1M audio tokens @ ~25 tok/s) | **Top tier, HIGH conf** — Gemini TTS #2 on AA Elo (1205.8); practitioners: natural, no "artificial uptalking" | Most "considerate" (selectivity 54%, best at ignoring non-addressed speech) but slowest (1.14s) and lowest task pass@1 (26–31%) of the three majors | WebSocket only, no official JS SDK found; ephemeral tokens supported |
| 4 | Hume EVI 3 / 4 mini | Native S2S (empathic) | $0.04–0.07 by tier | LOW conf — plausibly strong on emotional expressiveness, no reproducible eval | No independent data | Unverified this pass |
| 5 | **xAI Grok Voice** (`grok-voice-think-fast-1.0`) | Native S2S, **OpenAI-Realtime-API-compatible** | **$0.05 flat** ($3/hr) | No independent naturalness data | **#1 task completion** (τ-voice 51% clean / 38% realistic), 97% Big Bench Audio, 0.78s latency — **but interrupts the user 84% of the time**, worst barge-in discipline measured | WebSocket + WebRTC + SIP; MCP + parallel tool calls |
| 6 | OpenAI Realtime (`gpt-realtime-2.1`; mini ≈⅓ cost; full-duplex "GPT-Live" launched 2026-07-08, unbenchmarked) | Native S2S | $0.05–0.46 token-based; ~$0.096 naive full-duplex; caching cuts to $0.05–0.10 | MED — most improved (new `marin`/`cedar` voices), practitioner consensus still #3 of the majors on pure sound | **#1 turn-taking discipline** — lowest interrupt rate (14%), fastest realistic latency (0.90s); weakness: low selectivity (6%), mid task completion | **Best in class**: WebRTC + ephemeral client secrets (`POST /v1/realtime/client_secrets`), data-channel events, JS Agents SDK, MCP execution server-side |
| 7 | Cartesia (Sonic 3.5 TTS + Line agents) | TTS/STT legs + orchestrator | $0.06 agent-min | **Sonic 3.5 near top of AA arena** (~1218–1220 Elo, later snapshot); weak on long-form narration | Not benchmarked as a full agent | Via LiveKit integration, no first-party WebRTC |
| 8 | AssemblyAI Voice Agent API | Chained (transparent) | $0.075 flat all-inclusive | No independent data | Vendor-claimed ~1s e2e; no independent data | Unverified this pass |
| 9 | ElevenLabs Agents | Orchestrator (their STT/TTS + your LLM) | $0.08 overage **+ separate LLM bill**; plans bundle minutes | **Top tier, HIGH conf** — Eleven v3 #3 AA Elo (1178), the practitioner reference for "least synthetic" | Structurally taxed by cascade latency vs native S2S | WebRTC (2026) + WebSocket, server-issued tokens, React SDK |
| 10 | Deepgram Voice Agent | Chained (Deepgram-owned stack) | $0.041–0.163 tiered | Aura explicitly trades naturalness for speed/cost — not competitive on sound | Vendor's own VAQI benchmark (self-serving, discount it) | Unverified this pass |
| 11 | Azure AI Voice Live | Managed orchestrator, OpenAI-Realtime-compatible events | Tiered Pro/Basic/Lite, exact rates LOW-conf | Depends on chosen model | Depends on chosen model | WebSocket, server-to-server oriented |
| 12 | Orchestrators: LiveKit ($0.01/min + models, ~$0.077 loaded), Pipecat ($0.01–0.03 + providers), Vapi ($0.05 platform + providers), Retell (~$0.09–0.31 blended) | BYO-model pipelines | headline × 2–5 in practice | = whichever TTS you wire in | Cekura: tight field on interruption (Pipecat 4.90/5 … Vapi 4.63/5) | WebRTC-first (LiveKit/Daily/Vapi/Retell) |
| — | Anthropic Claude | **No speech-to-speech API exists** (confirmed absence, 2026-07-10) | — | — | — | Voice exists only in Claude consumer apps + Claude Code `/voice`; a Claude-reasoning voice agent requires a chained pipeline |

**Cross-cutting findings:**
- EVA-Bench: no system yet exceeds 0.5 on accuracy AND experience simultaneously; native S2S beats cascades on turn-taking, cascades beat S2S on clean-audio accuracy; accents hurt cascades (~10pts), barely hurt S2S.
- The naturalness leaders (ElevenLabs, Gemini TTS, Cartesia Sonic 3.5) are NOT the conversational-competence leaders (OpenAI, Grok). No single vendor wins both axes.
- WebRTC is table stakes in 2026; Gemini Live and Azure are the notable WebSocket-only holdouts.
- xAI's OpenAI-compatibility means one client implementation covers two lineages at a flat, predictable price.

## 2. Scout brief: OpenAI voice-agents guidance (condensed)

**Two architectures.** (1) *Speech-to-speech*: the realtime model consumes/produces audio directly over a persistent connection — natural latency, native barge-in, real-time tool use. (2) *Chained STT→LLM→TTS*: app owns each stage — controllable, reuses an existing text agent, full transcripts. OpenAI frames it as a tradeoff, no universal recommendation. A hybrid "chat-supervisor" pattern (realtime agent fronts the conversation, heavier text model consulted for hard turns via tool calls) exists in OpenAI's sample repos but is secondary-source only.

**Browser auth flow (WebRTC).** Backend holds the API key, mints an ephemeral client secret via `POST /v1/realtime/client_secrets`; browser fetches the secret from the backend, creates `RTCPeerConnection`, negotiates SDP with OpenAI directly; audio tracks flow natively, all JSON events ride the data channel. WebSocket transport is for trusted backends only (standard API key). Sessions max 60 minutes; voice fixed once audio is generated.

**Turn detection.** `server_vad` (silence-threshold; `threshold`/`prefix_padding_ms`/`silence_duration_ms`) or `semantic_vad` (classifier on the words; eagerness low/auto/high), each with `create_response`/`interrupt_response`; `null` = push-to-talk. Barge-in: `input_audio_buffer.speech_started` cancels the in-flight response; client truncates local playback (`conversation.item.truncate`) — WebRTC auto-truncates server-side, WebSocket clients must do it themselves.

**Tools.** Function tools declared in `session.update`; model emits `function_call` items with `call_id`; client executes, returns `function_call_output`, then `response.create` to continue. Separately, **remote MCP servers are executed by the Realtime API itself** (`type:"mcp"`, `server_url`, `allowed_tools`, `require_approval` with `mcp_approval_request` round-trip). Stated guidance: function tools when your app owns business logic/approvals/private access.

**SDK layer.** `@openai/agents/realtime`: `RealtimeAgent`, `RealtimeSession`, `RealtimeTransportLayer` (WebRTC/WebSocket/SIP implementations), output guardrails (run on debounced transcripts; a trip cancels the response). Handoffs documented are voice-to-voice specialist transfers only.

**Pricing/models.** `gpt-realtime-2.1` $32/$64 per 1M audio tokens in/out ($0.40 cached), mini tier $10/$20. User audio ≈600 tok/min, assistant ≈1,200 tok/min → ~$0.096/min naive; third-party measured $0.05–0.46/min, caching-dominated. Version labels inconsistent across OpenAI's own pages (moderate confidence). Latency guidance: spoken preambles ("I'll check that now") to mask tool-call latency; start reasoning-capable realtime models at `reasoning: low`.

## 3. Scout brief: glance attachment points (verified paths)

- **Transport**: everything live rides one WS (`/ws`), `ClientCommand` in / `SquadEvent` out — `webapp/src/lib/ws.ts` (`connectSquad`), server upgrade+dispatch `src/server.ts:774-882`, broadcast `src/server.ts:1944`. REST is a flat route table in `SquadServer.handle()` (`src/server.ts:846+`), client helpers `webapp/src/lib/api.ts`.
- **Chat surface**: `webapp/src/components/AssistantChat.tsx` — `handleSend` (line 707) → `sendConsoleCommand({type:'prompt', id, message, displayText, clientTurnId})` (line 760); console agent minted via `POST /api/console` (`src/server.ts:1725`). Rendering: `components/chat/TranscriptTimeline.tsx` + `Composer.tsx`.
- **Steer path**: WS/REST → `SquadManager.applyCommand` (`src/squad-manager.ts:4815`; `prompt` case 4891) → `RpcAgent.prompt/steer` (`src/rpc-agent.ts:379-391`, `streamingBehavior:"steer"` retry at 384).
- **Prior art + scar**: `WorkbenchPane.tsx:355-371` uses browser Web Speech API (`webkitSpeechRecognition`) for voice-to-task — the only real voice input. The chat composer's mic button was removed as a "misleading no-op"; `AssistantChat.test.tsx:533` asserts `aria-label="Voice input"` is absent. Voice-in-chat was wanted; it lacked a backend.
- **Token minting home**: add `POST /api/voice/token` to the `src/server.ts` route table (next to `/api/console` at 1725, `/api/push/key` at 1095) — `manager`, `actor`, RBAC already in scope. Provider key as `OMP_SQUAD_*` env via `src/config.ts` (`.env.example` must list it — enforced by `tests/env-example.test.ts`).
- **Greenfield**: zero LLM/audio SDKs in either package.json; all model access goes through harness CLIs. No AudioContext/MediaRecorder/RTCPeerConnection anywhere. A voice lane is the repo's first direct provider integration — keep it thin.
- Webapp stack: React 19.2, Vite 6, Tailwind v4, Context+hooks (no Redux); live state via `useSquad` → `TaskContext`.

## 4. Strategist: ranked transferable concepts

**Concept 1: Voice as the mouth/ears, the fleet as the brain (chat-supervisor inverted onto glance)** — HIGHEST impact
**Pattern**: the realtime voice model never does the real work; it is a conversational front-end whose function tools ARE the existing command surface. Complex turns are delegated to the text-agent system the app already has.
**Mechanism**: declare function tools mirroring `ClientCommand` — `prompt_agent(id, message)`, `spawn_agent(spec)`, `fleet_status()`, `interrupt(id)`. The voice model emits `function_call` → browser (or daemon) executes via the existing WS `{type:"prompt"}` / `applyCommand` path → agent output streams back as the same `SquadEvent` frames `TranscriptTimeline` already renders → summary injected as `function_call_output` → voice model speaks it. The voice model speaks a preamble ("dispatching that to the fleet") while the fleet runs — OpenAI's documented latency-masking pattern, and glance fleet operations take seconds-to-minutes, so this is load-bearing, not cosmetic.
**Value for glance**: voice control of the fleet with zero change to the trust architecture — every mutation still flows through `applyCommand`'s actor/RBAC checks; the voice model holds no credentials and no business logic. Claude-class reasoning stays on the fleet; the $0.05–0.10/min voice bill covers only the thin conversational surface.
**Where**: `AssistantChat.tsx` (reuse `handleSend`/console-agent machinery), `src/server.ts` route table, `src/squad-manager.ts` untouched.
**Build vs buy**: borrow the pattern. No dependency needed beyond the transport client.

**Concept 2: Daemon-minted ephemeral voice tokens** — required enabler
**Pattern**: backend holds the provider key; browser gets a short-lived, session-scoped client secret and connects to the provider directly over WebRTC — media never transits your server.
**Mechanism**: `POST /api/voice/token` in `SquadServer.handle()` → daemon calls provider's client-secret endpoint (`/v1/realtime/client_secrets` for OpenAI; xAI compatible) with key from `OMP_SQUAD_VOICE_API_KEY` → returns secret + config to the authed browser. Mirrors the existing `access-token`/better-auth pattern; RBAC-gate to operator tier.
**Where**: `src/server.ts`, `src/config.ts`, `.env.example`, `webapp/src/lib/api.ts`.
**Build vs buy**: build — it's one route + one fetch.

**Concept 3: Provider-agnostic realtime seam (the AgentDriver move, again)** — strategic
**Pattern**: code against the OpenAI Realtime event schema as a de-facto wire standard; the provider becomes a base-URL + token-mint config.
**Mechanism**: xAI's Grok Voice is explicitly OpenAI-Realtime-compatible (`wss://api.x.ai/v1/realtime`); Azure Voice Live speaks the same event family. A `VoiceProvider` config (mint endpoint, base URL, model, voice) makes the webapp client provider-blind — same shape as the harness registry that made units run on any harness.
**Value for glance**: a second lineage for the voice lane at flat $0.05/min (vs OpenAI's caching-dependent $0.05–0.46), price competition, and consistency with the repo's cross-lineage doctrine. Grok's measured flaw (84% interrupt rate) matters less in tool-delegation use where turns are short.
**Where**: the new voice client module in `webapp/src/lib/`, provider table in `src/config.ts`.
**Build vs buy**: build the seam; it's a config object, not a framework.

**Concept 4: Turn-detection and barge-in as explicit product decisions** — quality floor
**Pattern**: VAD mode, eagerness, and interruption behavior are configuration you choose per surface, not model magic. Push-to-talk (`turn_detection: null`) is a legitimate first ship for a noisy-desk dev tool; `semantic_vad` for hands-free. WebRTC handles barge-in truncation server-side — one more reason to prefer it over WebSocket in the browser.
**Where**: voice client config + a settings toggle in the chat composer.

**Concept 5: Resurrect the composer mic as chained STT first (cheap, decoupled)** — quick win
**Pattern**: chained input (STT → existing text lane) delivers most of the utility of "talk to the fleet" at near-zero cost and no new trust surface; full S2S adds spoken output + naturalness later.
**Mechanism**: restore the removed mic button on `Composer.tsx` backed by the same Web Speech API already proven in `WorkbenchPane.tsx:355` (free, on-device) — transcript feeds `handleSend` verbatim. Flip `AssistantChat.test.tsx:533` from asserting absence to asserting presence-with-function. This de-risks the UX before any provider bill exists.
**Build vs buy**: build; zero dependencies.

**Concept 6 (anti-recommendation): don't adopt an orchestrator platform.** LiveKit/Pipecat/Vapi/Retell earn their 2–5× blended cost when you need telephony, contact-center scale, or BYO-model pipelines. glance needs one browser session talking to its own daemon — the orchestrator layer duplicates what `SquadServer` already is. Likewise skip `@openai/agents/realtime` initially: the raw WebRTC + data-channel flow is ~100 lines, and the SDK would be the repo's first heavyweight provider dependency for marginal gain (revisit if guardrails/handoffs become real requirements).

**Recommended shape** (if this chains to /plan): Concept 5 first (mic revival, free, ships alone) → Concepts 2+1 (token mint + WebRTC voice lane with fleet-delegation tools, OpenAI first) → Concept 3 (xAI as second provider) → Concept 4 knobs. Voice provider choice: OpenAI Realtime primary (best browser story + best turn-taking discipline), Grok Voice as the compatible fallback/price hedge, Gemini Live noted as the cheap/naturalness option but blocked on WebSocket-only browser story (would need a daemon audio relay — meaningful extra work).

## 5. What we did NOT verify

- Exact OpenAI realtime model IDs (page-inconsistent) and Azure Voice Live rates.
- Whether Grok Voice's ephemeral-token mint mirrors OpenAI's endpoint shape exactly (its docs confirm compatibility for the session protocol; mint flow unconfirmed).
- Hume/AssemblyAI/Deepgram browser SDK specifics.
- Any hands-on audio listening — all quality rankings are third-party evidence, not our ears.
