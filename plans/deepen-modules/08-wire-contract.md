# One wire-contract module for daemon and webapp
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/types.ts, webapp/src/lib/dto.ts (893 lines, hand-mirrors types.ts), src/transcript-event-kinds.ts (duplicated in webapp/src/lib/channelTimeline.ts)
MODE: afk

## Goal
The daemon↔webapp wire contract stops being two hand-maintained mirrors held together by comments
and one sync test: a single shared contract module (or generated pair) so a DTO/event-kind change
is one edit, not shotgun surgery across 3–5 files. Coordinate with 06 (types split) — the wire
contract IS the natural core the split orbits.

## Provenance
Whole-repo report candidate 3 (Strong).
