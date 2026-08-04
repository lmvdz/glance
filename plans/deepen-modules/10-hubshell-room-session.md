# Room-session module behind HubShell
STATUS: in-progress
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: moderate
TOUCHES: webapp/src/components/hub/HubShell.tsx (877 lines, 25 recent touches), webapp/src/lib/channelTimeline.ts
MODE: afk

## Goal
HubShell does transport wiring (resync-since, read cursors, subscription pruning, optimistic
cards) inline in effects — the pure view-model libs are tested but the wiring where the
stale-claim bugs actually lived has no test surface. Deepen: a room-session module (ports &
adapters — WS adapter in prod, scripted adapter in tests) so the wiring becomes testable through
its interface and HubShell becomes a view.

## Slice ledger
- Slice 1 done (2026-08-04, iteration 33): RoomSessionCursor (webapp/src/lib/roomSession.ts) —
  the seq-cursor discipline extracted framework-free, decisions-as-data; HubShell's four wiring
  effects became appliers. 9 table-driven tests now cover the PR #216 incident class (replay
  no-ops, once-ever unread counting, switch reset, overlap gating, stale-closure rejection).
  Three hardenings over the inline refs: cursor reset on switch, client-side resync seq gate,
  and CHANNEL-TAGGED resync (self-caught pre-review: an in-flight old-channel response could
  corrupt the new session's cursor — the old code had the same hole). Codex round: CRITICAL
  (TDZ read in the ref initializer — my own check-run was misread as green; the reviewer + the
  suite both caught it), HIGH (live-ingest effect ordering on switch renders — synchronous
  idempotent beginChannel guard), MEDIUM (snapshot replace flickering out raced-ahead live
  entries + cursor regression — merge + Math.max). grok flaked (gap row). Remaining: transport
  port + scripted adapter (slice 2), optimistic-card reconciliation (slice 3).

## Provenance
Whole-repo report candidate 5 (Worth exploring); the stale-running-claims incident class
(PR #216) is the recurring bug this seam would have caught.
