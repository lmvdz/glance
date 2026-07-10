# Design: Speech-to-Speech Voice Lane (glance webapp)

Origin: plans/research-voice-agents/BRIEF.md (PR #163). Adversarial design 2026-07-10: sonnet designer, two fable red teams (security/cost + realtime-session correctness), fable arbiter. Draft decisions D1–D11 amended per red-team findings below.

## Approach

Voice is a second input modality onto the existing chat thread — never a second brain. The browser connects **directly** to the voice provider over WebRTC using a daemon-minted ephemeral token (audio never transits the daemon). The voice model's only powers are four function tools that mirror operator-tier `ClientCommand`s, executed browser-side over the tab's own authed WS — so the voice model can never exceed the human operator's tier, enforced at `applyCommand`'s existing chokepoint, verified by both red teams against source.

Ship order: (1) composer mic revival via browser STT — free, default-on, restores the deliberately-removed mic affordance with the error handling its predecessor lacked; (2) shared send/mint helper extraction + audit `source` field + env-catalog test — enablers that stand alone; (3) token mint endpoints; (4) the voice session state machine + WebRTC transport; (5) the tool dispatcher with an async-ack contract; (6) in-call UI. xAI as second provider is explicitly deferred (see Out of scope in 00-overview).

## Key decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Architecture | Browser-executed tools, WebRTC-direct, voice bound to the existing console agent | Daemon-side voice relay (v2 candidate); tools via new REST endpoint (rejected) | Zero new authz site (authz.ts doctrine: "no second authz site"); media never transits the daemon; same chokepoint as typed commands |
| Tool contract | **Async-ack**: mutating tools return an acknowledgment immediately; completion is narrated later by injecting a summary when the console agent's `message_end` arrives (if the session is still up) | Await-completion `function_call_output` (draft) | Fleet ops take minutes; a pending realtime tool call causes re-issued tools — and a re-issued prompt becomes a **steer** of live work (rpc-agent.ts retry). Ack-now dissolves duplicate calls, dead air, and re-mint orphans |
| Injection defense | Human-turn gating: mutating tools (`prompt_agent`, `spawn_agent`, `interrupt`) execute only from responses triggered by user speech, never from injected completion narrations; completion summaries are structured status + clearly-delimited data, never raw agent transcript | Trust the model's judgment | Fleet transcripts are untrusted (agents read repos/web). Without the gate, injected content could auto-chain the voice model's next tool call with no human in between |
| Tool surface | `prompt_agent(message)` (no id param — dispatcher fills the pinned binding), `spawn_agent(prompt)`, `fleet_status()`, `interrupt()`. Admin verbs (kill/restart/remove/fork) omitted from the schema entirely | Expose more of ClientCommand | Omission beats blocking; tier ceiling holds regardless because the socket's actor is gated, not the model |
| Token mint | `POST /api/voice/token` → daemon calls provider mint with `OMP_SQUAD_VOICE_OPENAI_API_KEY`, pins model/voice/turn_detection/instructions **server-side** in the mint body's `session`; browser never chooses them. Per-actor mint **rate cap** (429, feedbackRateAllowed shape). Refused in DB/org mode in v1 | Unpinned session (xAI's only option); no rate cap with budget knob later | One shared key + no cap + invisible spend (audio bypasses daemon) is the uncapped-shared-dollar shape; org mode needs per-org keys/enables before voice ships there |
| RBAC | No new authz branch: `restActionTier`'s default already yields GET=viewer / POST=operator for `/api/voice/*`; pinned by a regression test | New explicit branch | Both red teams traced the full match order and confirmed the fall-through is safe; the test guards future drift |
| Audit | `ClientCommand` gains an optional schema-carried `source` field ("voice") threaded into the audit log | Tack a field on client-side | Effect Schema strips unknown keys — an unschema'd tag would be silently dropped and the audit stays blind to the first unrecorded input modality |
| Session state | Explicit state machine: idle / userRecording / awaitingResponse / speaking / toolPending. PTT-press while speaking → `response.cancel` + playback stop; no `response.create` while userRecording (completions queue) | "PTT sidesteps barge-in" (draft claim — false) | The interrupt gesture and async completions both collide with recording; the two arbitration rules ARE the barge-in machinery, so they must be designed, not discovered |
| Session binding | Pinned at call start (session id + console agentId), shown in the HUD; session/project switch mid-call keeps the pin with a banner; session delete ends the call | Binding follows the active session | `openedConsoleAgentId` force-switches sessions from background events — "follows current" would let a background event silently retarget a live voice call |
| Session ownership | Voice session owned above the chat panel (provider-level), HUD as a floating in-call pill that survives panel close | Owned by Composer/AssistantChat (draft) | AssistantChat unmounts on Back/close/delete; the call must not die (or leak) by unmount semantics |
| Lifecycle | 60-min provider cap; proactive re-mint at ~55 min **at a quiescent state only**, carrying a rolling summary + bound agentId into the new session's instructions, with an HUD notice | Blind timer re-mint (draft) | New session = amnesia; re-mint mid-sentence or mid-tool is a designed failure |
| Transcript coherence | Voice prompts ride the shared send helper: durable Message + clientTurnId + a "spoken" marker, user's caption as displayText; spoken summaries persisted as model messages; non-tool voice chit-chat is ephemeral **by documented decision** | Voice turns bypass persistence (draft's implicit default) | Otherwise voice is the first unrecorded surface in a replay-as-truth system, and reload loses half the conversation |
| Providers | v1 = OpenAI only (`gpt-realtime-2.1`, mini as env override). `VoiceProviderConfig` type ships with transport + pinnedAtMint axes; unpinned transport only permitted for flat-price providers | xAI in v1 as config entry (draft) | Scouts contradict on Grok WebRTC support; browser-WS header auth is unverified; the WS audio path is a hidden DSP subsystem. Verify live, then add |
| Turn detection | Push-to-talk only (`turn_detection: null`) | semantic_vad | Deferred with the state machine built to accept it later |
| Flagging | `envBool("OMP_SQUAD_VOICE_ENABLED", false)` at the mint handler + `GET /api/voice/config` capability probe (viewer sees `{enabled}` only; provider list at operator+) | FEATURE_FLAGS registry | Verified: no webapp code consumes `/api/settings` flags; the config probe is the only honest discovery channel |
| Mic revival (chained STT) | Default-ON, feature-detected, with an `onerror` map (no-speech / not-allowed / network / aborted → distinct toasts), unmount abort, and an explicit privacy callout (Chrome ships audio to Google) — WorkbenchPane's identical gaps fixed in the same pass | Copy WorkbenchPane verbatim (draft) | The predecessor's silent failures are exactly the "misleading no-op" scar that got the old mic removed; and the default-ON path must state its cloud-audio posture, not just the gated one |

## Risks

- The realtime state machine is the repo's first provider-direct client surface; highest implementation risk. Mitigation: it ships as its own concern with a narrow live probe before the dispatcher lands on top.
- Provider idle-timeout during minutes-long silent waits is unverified (only the 60-min cap is documented). One live probe during implementation; the async-ack design reduces the blast radius to "reconnect and continue".
- Per-minute spend budget is a fast-follow; v1's guards are the mint rate cap, file-mode-only, and the 60-min cap.
- ek_ ephemeral tokens: memory-only, never logged; exfiltration is bounded to cost abuse (cannot drive the fleet — tools need the glance bearer token).
- SSRF: provider→base-URL resolution is a closed switch over static constants; unknown provider 400s before any fetch, pinned by test.

## Red team concerns addressed

| Concern | Severity | Resolution |
|---|---|---|
| Pending tool calls can't survive fleet latency (re-issued call = steer incident; re-mint orphans) | critical | Async-ack contract + single-flight dispatcher guard |
| PTT doesn't eliminate barge-in machinery | critical | Explicit state machine + two arbitration rules |
| Shared key, no mint cap, invisible spend in org mode | significant (ship-blocking for org mode) | Mint rate cap; voice refused in DB/org mode v1 |
| Audit can't distinguish voice-originated commands; naive tag silently stripped | significant | Schema-carried `source` field threaded to audit |
| function_call_output re-feeds untrusted agent output → autonomous injection loop | significant | Human-turn gating + structured status outputs |
| Two-minters race (voice + typed both mint console agents) | significant | Shared single-flight `ensureConsoleAgent` used by both paths |
| Dispatcher placement: `connectSquad` is a factory; a lib module would open a second socket | significant | Dispatcher is a hook under TaskContext; lib keeps pure schemas only |
| Silent no-op prompts to dead agents; voice reports success | significant | Roster-liveness before send + echo timeout → honest failure output |
| Voice session dies/leaks on panel unmount | significant | Provider-level ownership + floating pill |
| xAI transport contradiction + unverified feasibility | significant | Deferred; live probe filed as its own concern |
| Voice turns unrecorded; paraphrase rendered as user's words; summaries unpersisted | significant | Shared helper + spoken marker + persisted summaries + documented-ephemeral chit-chat |
| Re-mint amnesia | significant | Quiescent-state re-mint + rolling summary carry-over |
| Mic revival inherits WorkbenchPane's silent error paths; privacy posture inverted | significant | onerror map, unmount abort, privacy callout, WorkbenchPane fixed same pass |
| Unpinned providers = client-controlled session params | significant | pinnedAtMint gated to flat-price providers, asserted at mint |
| `/api/voice/config` leaks provider posture to viewers | minor | Viewer gets `{enabled}` only |
| env test may fail on pre-existing drift | minor | Drift check first; prep commit if needed |
| Static-markup tests can't assert handlers | minor | Test scope stated honestly: presence+enabled on Composer markup; handler covered by unit tests |

## Open questions

None blocking. All five draft questions closed at arbitration (local-heuristic summaries; xAI deferred pending live probe; async-ack replaces preamble-only masking; hardcoded model + env override; semantic_vad deferred). Remaining research item — provider idle-timeout behavior — is embedded in concern 05's verify.
