# Speech-to-Speech Voice Lane

## Outcome
- Talk to the fleet from the webapp: a working mic on the chat composer (free, browser STT) and a full voice-call lane where a realtime voice model speaks, listens, and drives the fleet through the same commands, tiers, and audit trail as typing — never around them.

## Work
| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| [01 composer mic revival](01-composer-mic-revival.md) | Restore the removed mic as a real feature, with the error handling whose absence killed its predecessor | mechanical | Composer.tsx, AssistantChat.test.tsx, WorkbenchPane.tsx, webapp/src/lib/voice/speech.ts |
| [02 env-example test](02-env-example-test.md) | `.env.example` claims a completeness test that has never existed; voice adds new vars that need a real gate | mechanical | tests/env-example.test.ts, .env.example |
| [03 audit source field](03-audit-source-field.md) | Voice-originated commands must be distinguishable in the audit log; schema strips unschema'd tags | mechanical | src/types.ts, src/schema/client-command.ts, src/squad-manager.ts, tests |
| [04 shared send/mint helper](04-shared-send-mint-helper.md) | Two future callers (typed + voice) of console-mint and prompt-building; single-flight kills the two-minters race | architectural | AssistantChat.tsx, webapp/src/lib/chat/sendCore.ts (new), tests |
| [05 voice token endpoints](05-voice-token-endpoints.md) | Daemon mints ephemeral provider tokens so the browser never holds the real key | architectural | src/voice-token.ts, src/server.ts, src/schema/http-body.ts, .env.example, tests/voice-token.test.ts |
| [06 voice session state machine](06-voice-session-state-machine.md) | The WebRTC session with explicit states, PTT arbitration, quiescent re-mint | architectural | webapp/src/lib/voice/* |
| [07 voice tool dispatcher](07-voice-tool-dispatcher.md) | Async-ack tools, human-turn gating, liveness checks, transcript coherence | architectural | webapp/src/hooks/useVoiceDispatcher.ts, webapp/src/lib/voice/tools.ts, TaskContext.tsx |
| [08 voice call UI](08-voice-call-ui.md) | The call affordance, floating in-call pill, pinned-binding banner | architectural | webapp/src/components/chat/VoiceCallButton.tsx, Composer.tsx, App.tsx |
| [09 xAI second provider](09-xai-second-provider.md) | Deferred second lineage; feasibility must be live-verified first | research | webapp/src/lib/voice/provider.ts, src/voice-token.ts |

## Order
| Batch | Concerns | Why together |
|---|---|---|
| 1a | 01, 02, 03 | Independent enablers, disjoint files |
| 1b | 04 | Shares AssistantChat.test.tsx with 01 — sequential after it (same-file rule), no logical dependency |
| 2 | 05 | Needs 02's env gate in place (.env.example overlap) |
| 3 | 06 | Needs 05's mint to connect |
| 4 | 07 | Needs 03 (source field), 04 (shared helper), 06 (session) |
| 5 | 08 | Needs 06+07 (something to render) |
| post-v1 | 09 | Blocked on live verification |

## Dependency graph
| Concern | Blocked by | 30s check |
|---|---|---|
| 01, 02, 03, 04 | — | — |
| 05 | 02 | `bun test tests/env-example.test.ts` passes on main |
| 06 | 05 | `curl -X POST :PORT/api/voice/token` returns a token with `OMP_SQUAD_VOICE_ENABLED=1` + key set |
| 07 | 03, 04, 06 | `source` field visible in audit.jsonl for a tagged command; sendCore exports exist; voiceSession connects live |
| 08 | 06, 07 | dispatcher + session hooks exported |
| 09 | 07 | v1 lane works end-to-end with OpenAI |

## Not yet specified
- (none)

## Out of scope
- **Daemon-side voice relay** (architecture B) — v2 candidate for non-browser clients; contradicts build-thin v1 — see DESIGN.md
- **semantic_vad / hands-free** — deferred until PTT usage exists; state machine is built to accept it
- **Per-minute spend budget knob** — fast-follow; v1 guards are mint rate cap + file-mode-only + 60-min cap
- **DB/org-mode voice** — refused at the mint handler in v1; needs per-org keys/enables and per-org attribution first (red-team finding)
- **GPT-Live models** — ChatGPT-only as of 2026-07-10, no API

## Status: v1 EXECUTED (8/8 concerns done; 09 deferred)
Concerns 01–08 shipped on the branch (commits 5c8fc5f → 75e7768) — full suite green (root 2588, webapp 1116, 0 fail; both typechecks clean). Every concern passed its inline review, then the whole lane went through a 4-reviewer AUDIT gauntlet (native cross-batch + blind-zero-framing + gpt-5.6-sol + grok-4.5) that found 2 confirmed end-to-end breaks (concurrent `response.create`; barge-in muted playback forever) and ~20 trust/spend/resource residuals — all fixed in 593bc16, with a focused re-review (75e7768) of the two critical protocol fixes that PASS'd on a counter-integrity proof.

**⚠️ LIVE-VERIFICATION OWED (the one gap):** no OpenAI key in the build env, so nothing on the provider-direct realtime path was driven live — concerns 05/06/07/08's live-probe steps are unrun. Highest-value owed check: concern 06's ≥10-min idle-timeout probe (calibrates reconnect) + real WebRTC SDP/mic/barge-in timing. The protocol changes are the conservative-correct shape (defer-until-response.done never sends a concurrent create regardless of provider behavior) but a live pass is needed before trusting the lane in production. Run via the scratch-daemon skill with a real `OMP_SQUAD_VOICE_OPENAI_API_KEY`.

## Decisions so far
- [DESIGN.md](DESIGN.md) — browser-executed tools over WebRTC with daemon-minted pinned tokens; async-ack tool contract; voice = mouth/ears only
- [01](01-composer-mic-revival.md) done · [02](02-env-example-test.md) done · [03](03-audit-source-field.md) done · [04](04-shared-send-mint-helper.md) done · [05](05-voice-token-endpoints.md) done · [06](06-voice-session-state-machine.md) done · [07](07-voice-tool-dispatcher.md) done · [08](08-voice-call-ui.md) done · [09](09-xai-second-provider.md) deferred (needs live feasibility probe)

## Notes
- EXECUTED on user "execute" go. Batches ran 1a(01/02/03)→1b(04)→05→06→07→08, worktree-isolated for the parallel batch, review-gated between each, then the AUDIT gauntlet. xAI (09) stays deferred per DESIGN — scouts contradict on Grok WebRTC support; it needs a live probe first.
- Auto-approved: headless (background job). EXPLORE/DESIGN/DECOMPOSE gates recorded, not user-blocked.
- WIP snapshot at plan start: 9 plans with open work, 22 open concerns (oldest 2026-07-10) — proceeded per headless rule.
- Origin: plans/research-voice-agents/BRIEF.md (PR #163). Verified API facts (2026-07-10): OpenAI mint `POST /v1/realtime/client_secrets` → `{value: "ek_...", expires_at, session}`, SDP to `POST /v1/realtime/calls`; models `gpt-realtime-2.1` / `-2.1-mini`. xAI mint mirrors the path but takes only `expires_after.seconds` (no session pinning) and its browser story is WebSocket-with-subprotocol-token; WebRTC support contradicted between scouts → concern 09.
- DECOMPOSE assumption: concern 04's helper extraction is a pure refactor of AssistantChat.tsx behavior (no user-visible change); if implementation finds coupled behavior, report rather than force.
