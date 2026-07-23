# Mention grammar — @agent steers and spawns from chat, safely (supersedes buzz-borrows 05)
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/chat/Composer.tsx, webapp/src/hooks/chat/useTriggerMenu.ts, webapp/src/lib/chat/sendCore.ts, webapp/src/lib/agent-control.ts, src/squad-manager.ts (queue-or-confirm), src/channels.ts (steer echo), tests
BLOCKED_BY: 03, 08
MODE: afk

## Goal
@mentioning an agent in the room is the control-plane verb: idle/input agents get a direct steer
with ack; working agents get a queue-or-confirm card (propose→confirm, SpawnConfirmSheet
precedent) — never raw mid-turn injection (B-F12/A-S4); non-resident targets produce a
spawn-proposal card (the shipped /api/spawn flow relocated into the room). Every mention-steer is
ALSO appended to the channel as an entry — attribution + visibility for other members (A-S4);
concurrency stance: last-write-wins, both steers visible in-channel.

## Approach
1. One `@` trigger, two sectioned picker groups (agents, issues) via useTriggerMenu's multi-trigger
   machinery — no second sigil, no hand-rolled matching. Serialize mentions in the markdown-link
   format from the R3 research (string-canonical composer stays).
2. Steer path: mention resolve → steerCommand with fresh clientTurnId (concern 03 reversal) →
   ack/nack drives pending/failure UI; nack on missing/denied/duplicate renders visibly.
3. Working-agent guard: daemon-side status check in applyCommand path returns a confirm-required
   response (or the webapp renders confirm before send when DTO status is working — pick
   daemon-side so multi-tab is covered); confirm card mirrors SpawnConfirmSheet.
4. Spawn-from-mention: non-resident mention → spawn-proposal card in the channel (prompt-only
   /api/spawn + channelId from concern 05); confirm → spawn; SpawnStatusCard tracks. Reserved
   extension point (name only, no shape — federation provenance amendment, DESIGN.md
   2026-07-23): a federated `@vendor-capability` mention enters here as a non-resident target
   whose spawn is a contract; don't design the resolver so residency is the only axis.
5. Channel echo: accepted steer appends a manager-authored entry to the channel naming actor,
   target, and the steer text (redacted/neutralized).
6. Reply routing: agent replies render in the target unit's room; the channel gets the echo +
   result cards — cross-unit reply cards inline in the channel are follow-on polish (note in
   00-overview if deferred at execution time — do not silently drop).

## Cross-Repo Side Effects
None.

## Verify
- Mention idle agent → steered (its transcript shows prompt), ack renders, channel shows echo.
- Mention working agent → confirm card, no injection until confirmed.
- Mention nonexistent name → spawn-proposal card → confirm → unit spawns bound to the channel.
- Two humans steer the same agent concurrently → both echoes visible, last-write-wins, no silent
  drop. Task-mention behavior unregressed (Composer tests).
