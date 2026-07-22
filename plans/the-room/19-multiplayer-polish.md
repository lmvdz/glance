# Multiplayer polish — typing, read cursors, concurrent-steer visibility, live smoke
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp hub components, src/server.ts (ephemeral presence events), src/channels.ts (read cursors), tests
BLOCKED_BY: 09, 18
MODE: afk

## Goal
The room feels alive with more than one human in it: typing indicators (ephemeral, never stored),
per-user read cursors (unread counts in the rail), concurrent-steer awareness polish (both echoes
visible with clear attribution/ordering), and the standing two-browser DB-mode live smoke that
proves multiplayer end-to-end.

## Approach
1. Typing: ephemeral WS events (not channel entries — never persisted), debounced, per-channel.
2. Read cursors: per-user per-channel last-read seq (DB rows); rail unread badges; no read
   receipts shown to others in v1 (privacy default).
3. Concurrent steer: when two steers hit one agent within a turn window, the later echo card
   references the earlier ("follows A's steer") — rendering the stated last-write-wins stance.
4. Two-browser smoke codified as a repeatable scratch-daemon + agent-browser recipe (extends the
   voice-loop fake-mic/CDP rig precedent) and attached to the love-gate protocol.

## Cross-Repo Side Effects
None.

## Verify
- The codified smoke passes: two identities chat, steer, see typing + unread counts; nothing
  persists typing events (store inspected); unread math survives reload.
