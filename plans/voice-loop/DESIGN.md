# Design: voice-loop — away-from-keyboard half of the voice workflow

## Outcome

Speak a task into a call, hang up, walk away. When the dispatched work finishes, your devices get a
tap-on-the-shoulder push (no work product in the notification). Come back, start a call on that
session, and the agent opens with "while you were away, X finished — here's the summary", spoken,
and you reply by voice. The human stays in the loop exactly where it matters.

## Approach

Two independent lanes, deliberately decoupled so each fails soft:

- **Push lane (daemon).** The daemon is the only party awake when the tab is closed. A per-agent
  `voicePushArmed` latch — set only by daemon-observed voice-sourced dispatches, persisted with the
  agent record, disarmed after one push (and by a voice interrupt) — fires a completion push from
  the existing `maybePushAlert` hook on the working→idle edge. One push per voice dispatch, never a
  per-turn firehose. The push carries the agent's name only ("finished — call back for the
  debrief"), never transcript content: lock screens are not viewer-tier.
- **Debrief lane (webapp).** A per-session `ts`-based cursor persisted in the session store. At
  call start the webapp fetches each tracked agent's transcript over REST (not the WS mirror, which
  is empty on a cold page load) and collects finished assistant turns newer than the cursor. They
  are spoken via the injection lane as fenced untrusted DATA with an explicit "summarize only, call
  no tools" instruction. The cursor commits **only after the debrief's own response completes
  uncancelled** — a barge-in, an early hang-up, or a dev StrictMode remount leaves it unadvanced,
  and the next call simply re-debriefs. Push is best-effort; **the cursor is the guarantee**.

The daemon-side live-call beacon from the draft design is **cut**. Its job (don't buzz mid-call) is
done more cheaply by a service-worker visibility gate — skip the OS notification when a glance
window is visible — which also fixes today's buzz-while-watching for input/error escalations.

## Key decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Completion detection for push | Daemon, at `maybePushAlert` (working→idle edge) | Webapp sweep | Only the daemon is awake with the tab closed |
| Push eligibility | `voicePushArmed` latch per voice dispatch, disarm on push/interrupt, persisted on the agent record | Permanent `voiceRelevant` flag; per-turn `source` check | Red team: a permanent latch pushes on every future turn forever; `source` isn't on transcript entries; arm/disarm gives one push per ask and survives restarts |
| Mid-call suppression | Service-worker visibility gate (no daemon state) | `POST /api/voice/live` heartbeat + TTL map | Beacon can't be keyed correctly (no agent pre-bootstrap, unrelated agents buzz mid-call), adds a spoofable suppression surface; SW gate is zero-API and helps the escalation lane too |
| Debrief cursor key | Wall-clock `ts` (completion re-stamps `ts`) | `seq` with restart heuristics | `seq` is assigned at stream start, mutated in place, resets per restart — three independent ways to drop the flagship "finished while away" turn |
| Debrief data source | REST `GET /api/agents/:id/transcript` per tracked agent at call start | WS `transcripts` mirror | The mirror is empty on cold load and replay has no completion marker; REST is the durable truth |
| Cursor commit point | When the debrief injection's response completes uncancelled (two-phase) | Advance at call end / effect cleanup | Barge-in, terminal errors, and StrictMode's synthetic cleanup all lose the debrief forever if the cursor advances unconditionally |
| Push body | Agent name + "finished" only | Truncated completion summary | Transcript content on every subscribed lock screen is a real privacy widening; the spoken debrief is the content channel |
| Push tag/debounce | `done:<id>` namespace, separate from escalations | Reuse `tag: a.id` + shared 3s key | A "finished" toast must never replace or debounce-eat an unactioned "needs you" |
| Deep link | `/#/agent/<id>` (existing SW handler) | Session-scoped URL | Sessions are device-local; an agent link works on every receiving device |
| Multi-tenant | New push category asserts file-mode (`!registry`); DB-mode delivery is a named prerequisite (per-org PushService) | Wire into `broadcastTo` now | One global subscription file = instant cross-org broadcast the day it's wired; refuse to create the trap |

## Risks

- **Restart seeding**: `pushSeeded` can never become true from the React webapp (only the legacy
  client sends `snapshot`), so the whole push lane is dead after a daemon restart — a live bug in
  the existing escalation lane too. Fixed here by seeding from `manager.list()` at startup.
- **Tab-hidden-while-talking**: with the beacon cut, a push can buzz the device mid-call if the
  glance tab is hidden. Accepted for v1 (rare; the notification is redundant, not wrong). Revisit
  with a beacon only if it stings.
- **Per-device cursor**: the session store is localStorage; each device debriefs what *it* hasn't
  relayed. Documented as per-device by design; cursor writes bump `updatedAt` so cross-tab merges
  don't clobber them.
- **Transcript caps**: 800-entry caps can evict away-window entries; the debrief says "history was
  truncated — partial report" when the oldest surviving entry is newer than the cursor.
- **Workflow-unit flapping**: spawned units cycle working→idle per node; their arm point is the
  terminal `workflow_done`/stopped signal, not the first idle.

## Red team concerns addressed

| Concern | Severity | Resolution |
|---|---|---|
| seq-cursor drops mid-stream/post-restart completions | critical | ts-based cursor; seq abandoned entirely |
| WS store empty at cold-load debrief; cursor advance destroys evidence | critical | REST fetch at build time; cursor commits only from fetched+spoken content |
| `pushSeeded` never seeds from webapp → lane dead post-restart | critical | Seed at server start from `manager.list()` (fixes existing lane too) |
| Per-turn working→idle = push storm; interrupt = false "finished" | significant | Arm-per-dispatch/disarm-on-push; disarm on voice interrupt; spawn arms on terminal signal |
| Cursor advance at call end loses barged/errored debriefs; StrictMode double-cleanup | significant | Two-phase commit on the debrief response's uncancelled completion; never advance in cleanup |
| agentId-keyed liveness wrong-shaped; beacon spoofable/suppression DoS | significant | Beacon cut from v1; SW visibility gate instead |
| Push body privacy (lock-screen work product) | significant | Name-only body |
| Voice spawns invisible to the debrief (no durable record) | significant | Voice spawn path writes a durable SpawnedUnitRecord to the bound session |
| Debrief chains blocked tool calls (MAJOR-3 gate refusals as first impression) | significant | Injection text instructs summarize-only, no tools, ask the operator |
| Tag/debounce collision hides "needs you" | significant | `done:` namespace for tag and debounce |
| DATA fence newline forgery | minor | Strip `[\r\n]` in debrief (and completion) DATA payloads |
| No-cursor fallback unbounded; dead-agent cursor entries | minor | No cursor → "first call, no backlog"; 24h clamp; prune ids against roster at commit |

## Out of scope (v1)

- DB-registry push delivery (prerequisite: per-org PushService + org-scoped subscriptions).
- Cross-device debrief cursor (server-owned session state).
- Auto-starting a call from a notification click (mic needs a real user gesture).
- Coalescing simultaneous completion pushes.
- Live-call suppression beacon (see decision table).
