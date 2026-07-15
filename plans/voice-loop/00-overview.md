# voice-loop — away-from-keyboard voice workflow

## Outcome
- Voice-dispatched work finishing while the operator is away produces a name-only push; the next
  voice call on that session opens with a spoken, fenced debrief the operator answers by voice.

## Work
| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 completion push lane | Daemon is the only party awake tab-closed; today completions never push and the lane is dead post-restart | architectural | src/push.ts, src/server.ts, src/squad-manager.ts, tests/ |
| 02 SW visibility gate | Don't buzz the device the operator is looking at (fixes escalations too) | mechanical | src/web/sw.js |
| 03 injection completion callback | The debrief cursor may only commit when its narration actually completed uncancelled | mechanical | webapp/src/lib/voice/voiceSession.ts (+test) |
| 04 debrief lane | Cursor + REST transcript fetch + fenced spoken debrief + durable voice-spawn records | architectural | webapp/src/lib/chat/sessionStore.ts, webapp/src/lib/voice/tools.ts, webapp/src/hooks/useVoiceDispatcher.ts, webapp/src/context/VoiceCallContext.tsx, webapp/src/lib/api.ts (+tests) |
| 05 push-enable nudge | The loop is dead if the operator never granted notification permission | mechanical | webapp/src/components/chat/VoiceCallPill.tsx (+callHud helper/test) |

## Order
| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01, 02, 03, 05 | Fully disjoint TOUCHES (daemon / sw.js / voiceSession / pill) |
| 2 | 04 | Depends on 03's callback; owns all shared webapp stores end to end |

## Dependency graph
| Concern | Blocked by | 30s check |
|---|---|---|
| 04 | 03 | `grep -n "onDone" webapp/src/lib/voice/voiceSession.ts` shows queueInjection's completion callback |

## Not yet specified
- (none)

## Out of scope
- DB-registry push delivery — needs per-org PushService; wiring the current global subscription file into `broadcastTo` would be a cross-org broadcast — see DESIGN.md
- Cross-device debrief cursor — server-owned sessions rejected for v1 (Approach B in DESIGN.md)
- Live-call suppression beacon — replaced by the SW visibility gate (red-team finding)
- Auto-start call from notification click — mic capture requires a real user gesture

## Decisions so far
- (populated at close)

## Notes
- Phase 0 snapshot: proceeded over 275 plans with open work (oldest: meta-plan-autonomous-fleet, 2026-07-05); user explicitly pre-authorized plan+execute ("do it").
- Adversarial design ran: sonnet designer, 2 fable red-teamers (25 code-verified findings), fable arbiter. Liveness-beacon half of the draft was cut in arbitration.
- Execution deviation: concerns implemented by the orchestrator/sonnet implementers on the working branch in place (sequential; batch-1 concerns are file-disjoint) because the feature builds on a large uncommitted session base that worktree isolation (fresh from origin/main) would not see. Base committed to branch `voice-loop` before execution.
