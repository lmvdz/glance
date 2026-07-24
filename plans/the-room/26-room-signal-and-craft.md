# Room signal + card craft — the room was a firehose of the least interesting fact it has

STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts (needs-you worthiness + face), src/server.ts (webapp cutover default), webapp/src/lib/channelTimeline.ts, webapp/src/lib/hub.ts, webapp/src/components/hub/*, tests
BLOCKED_BY: none (defect against landed 12/08)
MODE: afk

## Goal
The room's contents are worth looking at. Found by booting the room for the first time against real
fleet data — a step nothing in waves 1–3 had done, and every finding below was invisible from the
diff.

## What the room actually looked like (2026-07-24, scratch daemon on a copy of ~/.glance-room-fleet)

`#fleet` held **544 cards. 100% of them were `needs-you` tool-approval prompts** — `Allow tool: bash
Command: bun run check`, `Allow tool: bash Command: git add …` — each one paired with a second
`needs you resolved · …` card seconds later. Zero gate verdicts. Zero land cards. Zero plan cards.
Zero human messages. Every card also rendered the same sentence twice (title, then body) and a third
time in a pinned "why stopped" field.

That is the exact firehose DIRECTION.md's near-empty needs-you law forbids, and it is what the love
gate (concern 23) would have opened onto. The shell, the doors, the messaging and the dead-door
fallback all worked — the *contents* were the failure.

## Root causes (three, independent)

1. **No card-worthiness rule.** `emitNeedsYouProjection` projected every `PendingRequest`, and the
   fleet's pendings are overwhelmingly routine tool approvals that a supervisor answers in seconds.
   The system already had the right predicate — `gateClassOf`, "a decision no supervisor may
   auto-answer" — and the room ignored it. Concern 12 specified the emit site as "the
   PendingRequest/attention path", so the noise was designed in: nobody asked which pendings deserve
   permanent history.
2. **The signal cards fire on paths the real workflow rarely takes.** land/gate/plan/token-burn emits
   sit on the land and gate flows; the fleet's actual trains land by hand, so in twelve hours of
   real work not one of those kinds fired. Noise on a hot path, signal on a cold one.
3. **Card craft was never seen.** Duplicated body text, no timestamps anywhere in a *chat* surface,
   cards capped at `max-w-2xl` inside a 1030px column (half-empty rows), a door button hardcoded to
   "Open plan DAG" for every kind (a token-burn card offering to open a plan DAG), and a
   `Message ##fleet` composer placeholder (`#${channel.name}` where the name already carries the `#`).

## Approach — what this concern changed

1. **`isRoomWorthyPending`** (src/squad-manager.ts, next to `gateClassOf`): only gate-class pendings
   become room cards, applied symmetrically so a pending that never became a card can never emit an
   orphan "resolved" card. The lane and the rail are untouched — they read `AgentDTO.pending`
   directly, so nothing is hidden; the room simply stops writing permanent history for routine
   approvals. Documented division: **the lane is "act now", the room is "what happened."**
2. `needsYouFace` prints each fact once: body only when it differs from the title, and the redundant
   pinned "why stopped" dropped.
3. Client-side de-duplication as defense in depth (`cardBody`/`repeatsTitle` in channelTimeline.ts) —
   the old `face.body || entry.text` fallback printed the title's own source string as the body.
4. `doorLabel(kind)` replaces the hardcoded "Open plan DAG".
5. `entryTimeLabel` (lib/hub.ts) — wall-clock on every card and message; same-day entries print the
   clock, older ones carry the date. The internal `#seq` badge is gone from the reader-facing header.
6. Cards fill a centered `max-w-4xl` column instead of stopping at 55% width; GateVerdictCard
   matched to the same width.
7. **Cutover**: `OMP_SQUAD_WEBAPP` now defaults ON. It was `false`, so a daemon with no explicit flag
   served the legacy `src/web/index.html` dashboard — meaning the room, the ratified home screen, was
   invisible by default for the entire program. The `existsSync(webapp/dist/index.html)` half of the
   guard is unchanged, so an install with no built SPA behaves exactly as before. **Reverse with
   `GLANCE_WEBAPP=0` if this is not the call you want.**

## Cross-Repo Side Effects
None.

## Verify
- `bun test tests/projection-routing.test.ts` — the new worthiness test pins both edges: a
  non-gate `Allow tool: bash` pending produces zero channel entries on raise AND on resolve; a
  `GATE:`-titled pending still produces its card.
- `bun test webapp/src/lib` — body de-duplication, pinned-field de-duplication, per-kind door labels,
  timestamp formatting incl. the invalid-timestamp case.
- Live: scratch daemon seeded via `plans/the-room/seed-room.py`, room rendered in agent-browser —
  every card one sentence, timestamped, full width, correct door label. Screenshots in the PR.
- `bun run check` clean; 1456 webapp tests, 195 daemon tests in the affected set, all green.

## Known gaps, deliberate
- With BOTH supervisors off, a non-gate prompt blocking a unit writes no room card. It remains in the
  lane and the rail. The stronger rule — project a non-gate pending that survives a grace period,
  i.e. "the machine did not handle it, so it is a human's problem after all" — needs per-pending
  scheduling and is follow-up, not smuggled in here.
- Root cause 2 (signal kinds fire on cold paths) is NOT fixed by this concern. The room needs unit
  lifecycle cards — spawned, turn finished, PR opened, tests failed — which are the facts a human
  actually wants and which no current kind covers. Filed as the next concern rather than widened
  into this one.

## Resolution
Implemented 2026-07-24 on `fix/room-signal-and-craft`, verified live in a scratch daemon against
both real fleet data and a seeded realistic history.
