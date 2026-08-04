# One wire-contract module for daemon and webapp
STATUS: in-progress
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

## Slice ledger
- Slice 1 done (2026-08-04, iteration 31): the transcript-event-kind space has ONE author —
  src/transcript-event-kinds.ts exports its canonical list; the webapp derives ChannelCardKind
  and POINTER_EVENT_KINDS exhaustiveness from a TYPE-ONLY cross-tree import (codex bundle-graph
  probe: zero daemon modules, zero react in the browser bundle; vite build green). A new daemon
  kind is now a webapp compile error at the POINTER map, then at iconClass — the old two-file
  text-scrape sync test is replaced by tsc + a 3-check runtime test (local: namespace rule,
  duplicate-free list, constants ⊆ list — codex caught the rewrite dropping that last proof).
  Excess-key protection IMPROVED: satisfies rejects stale webapp-only keys, which the old text
  test never proved. DOOR_LABELS/toneFor stay deliberate fallbacks (codex's walk names them).
  grok quota-flaked (gap row). Remaining: the dto.ts hand-mirror (893 lines) — decide shared-vs-
  generated per-domain; transcript-event PAYLOAD schemas.

## Provenance
Whole-repo report candidate 3 (Strong).
