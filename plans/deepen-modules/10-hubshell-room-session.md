# Room-session module behind HubShell
STATUS: open
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

## Provenance
Whole-repo report candidate 5 (Worth exploring); the stale-running-claims incident class
(PR #216) is the recurring bug this seam would have caught.
