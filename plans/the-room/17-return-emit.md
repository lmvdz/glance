# Return-emit — layer 2 never happens silently, both directions tested
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: door surfaces (IntervenceView steer path, plan editor save, kill/restart controls), src/channels.ts, src/squad-manager.ts, tests
BLOCKED_BY: 12
MODE: afk

## Goal
Every action taken in a depth surface emits a card back into the routed channel: steer from
IntervenceView, design revision from the plan surface, kill/restart/park from any control. The
"complete live projection" invariant is built and tested, not asserted (B-F9).

## Approach
1. Daemon-side, at the applyCommand audit point (single chokepoint, src/squad-manager.ts:6975-6980)
   — not per-UI-surface — project accepted mutating commands (prompt/steer, kill, restart, fork,
   set-model) as manager-authored channel entries via concern 05 routing. UI surfaces need no
   individual wiring; anything that goes through applyCommand echoes automatically (this also
   captures CLI/TUI actions — the room reflects ALL control planes, not just the webapp).
2. Plan-surface saves (not applyCommand-mediated) get an explicit design-revised emit (with 14).
3. Filter: routine automation-loop commands may be excluded by kind filter to protect
   signal (same mechanism as #fleet filtering); operator-actor actions always project.

## Cross-Repo Side Effects
None.

## Verify
- Steer from IntervenceView → channel shows the echo card naming actor + target; kill from
  cockpit route → card; CLI steer against the daemon → card (proves the chokepoint placement);
  automation heartbeat commands do NOT flood the channel.
