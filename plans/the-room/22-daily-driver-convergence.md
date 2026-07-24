# Daily-driver convergence — the room serves the terminal-first driver
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp hub rail, src/server.ts (push path), src/squad-manager.ts (glance-here thread surfacing), tests
BLOCKED_BY: 05, 07
MODE: afk

## Goal
Room leads; daily-driver converges into it (Lars, design gate): `glance here` terminal sessions
appear as threads in the room's rail (terminal work and room work are one projection), and
needs-you-grade cards ride the existing web-push latch so the room's attention surface reaches
Lars off-screen exactly like the ladder does today. The room must move the daily-driver adoption
counters, not compete with them (B-F8).

## Approach
1. Rail: glance-here-originated units (console/casual lane) listed under an "active work" group
   with their channel routing (concern 05's channelId or #fleet).
2. Push: needs-you card projection triggers the same push path the attention ladder uses (one
   substrate — reuse maybePushAlert's transition keying, src/server.ts:3269, extended to the
   needs-you kind if not already covered); no second push pipeline.
3. Adoption counters: room-surface usage feeds the existing GET /api/adoption counters so the
   dogfood-drain sees convergence, not divergence.

## Cross-Repo Side Effects
None.

## Verify
- `glance here` session appears in the rail live; a pending request raises exactly ONE push (no
  double-fire from lane + room); adoption counters tick from room interactions.

## Resolution
Landed in train wave3: glance-here units in the rail, needs-you push single-fire via shared tag keys, room interactions in adoption counters.
