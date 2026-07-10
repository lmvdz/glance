# Voice token mint + config endpoints
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/voice-token.ts, src/server.ts, src/schema/http-body.ts, src/config.ts, .env.example, tests/voice-token.test.ts
BLOCKED_BY: 02

## Goal
The daemon mints short-lived provider tokens so the browser can connect to the voice provider directly without ever holding the real API key. Two routes in `SquadServer.handle()`'s flat table: `POST /api/voice/token` (operator) and `GET /api/voice/config` (viewer capability probe).

## Approach
- New `src/voice-token.ts` — `mintVoiceToken(provider)`:
  - Provider resolution is a **closed switch over static constants** (v1: only `openai` → `https://api.openai.com/v1/realtime/client_secrets`); unknown provider → 400 **before any fetch** (SSRF doctrine; pin with a test).
  - OpenAI mint body pins the session **server-side**: `{session: {model, voice, turn_detection, instructions}, expires_after: {anchor:"created_at", seconds: 3600}}`. Model from `OMP_SQUAD_VOICE_MODEL` (default `gpt-realtime-2.1`), voice from `OMP_SQUAD_VOICE_VOICE` (default `marin`). Instructions include the latency-narration guidance and the mouth/ears framing. The browser never chooses model/voice/instructions.
  - Response shaped to `{provider, value, expiresAt, transport: "webrtc", pinnedAtMint: true}`. Never log the `ek_` value or the raw provider response.
  - Seam contract for future providers: `pinnedAtMint: false` is only permitted for providers marked flat-price in the config — assert it at mint time (red-team: unpinned = client-controlled session params).
- Route handlers in `src/server.ts` (next to `/api/console` at 1725):
  - Both behind `envBool("OMP_SQUAD_VOICE_ENABLED", false)` (mirrors the `OMP_SQUAD_MODEL_OUTCOMES` check at server.ts:1716).
  - **Refuse mint in DB/org mode** (single shared key across tenants + no per-org attribution is the red-team ship-blocker) — 403 with a clear message.
  - **Per-actor mint rate cap** reusing the `feedbackRateAllowed` shape (server.ts:916, `OMP_SQUAD_FEEDBACK_RATE_LIMIT_PER_MIN` analog → `OMP_SQUAD_VOICE_MINT_RATE_PER_MIN`, default ~6) → 429. The mint count is the daemon's ONLY spend signal (audio never transits it), so the cap is load-bearing, not hygiene.
  - `GET /api/voice/config`: viewer tier gets `{enabled: boolean}` only; operator+ additionally gets `providers: [...]` computed from which keys are configured (red-team: don't leak provider posture to viewers).
  - RBAC: no new authz branch — `restActionTier`'s default yields GET=viewer/POST=operator for `/api/voice/*` (verified by both red teams against src/authz.ts:62-88). Pin with a regression test so a future authz edit can't silently change it.
- `src/schema/http-body.ts`: `VoiceTokenBodySchema` following the neighboring `ConsoleBodySchema` pattern (line ~329).
- `.env.example`: new voice section — `OMP_SQUAD_VOICE_ENABLED`, `OMP_SQUAD_VOICE_OPENAI_API_KEY`, `OMP_SQUAD_VOICE_MODEL`, `OMP_SQUAD_VOICE_VOICE`, `OMP_SQUAD_VOICE_MINT_RATE_PER_MIN` (gated by concern 02's test).

## Cross-Repo Side Effects
None.

## Verify
- `bun test tests/voice-token.test.ts`: mint-shape mapping (fetch mocked), envBool gate off→404/disabled, DB-mode refusal, rate cap 429 on burst, unknown provider 400s without fetch, restActionTier regression (GET=viewer/POST=operator for /api/voice/*), `ek_` never in any log output.
- Live (scratch daemon, real key): `curl -X POST :PORT/api/voice/token -H "Authorization: Bearer <op-token>"` → `{value:"ek_...", expiresAt,...}`; viewer token on config gets `{enabled}` only.

## Resolution
Shipped (commit fc17601; audit hardening 593bc16). `POST /api/voice/token` + `GET /api/voice/config` with every red-team guard, each pinned: envBool gate, DB-mode 403, per-actor mint rate cap (rate<=0 no longer disables it), closed provider registry (400-before-fetch), viewer-scoped config, ek_ never logged, 15s fetch timeout, key trim, malformed-body 400, `input_audio_transcription` enabled at mint, `session.tools` pinned. Both foreign lineages confirmed no SSRF / no secret leak / operator-tier enforced.
**Live-verification OWED**: the real-key `curl` against OpenAI's `client_secrets` endpoint was not run (no key in the build env). Unit-verified against a mocked provider.
