# One wire-contract module for daemon and webapp
STATUS: needs-lars
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

## needs-lars (2026-08-04, iteration 32)
OPEN QUESTION FOR LARS: merge the deepen PR train (at minimum #315, the concern-06 types-split
carrying src/core-types.ts) so this concern's remaining slices can proceed. The dto.ts
hand-mirror slices are DESIGNED on the 06 kernel: dto's head mirrors (AgentStatus,
PendingRequest, IssueRef, the transcript cluster) are field-compatible with core-types.ts and
become type-only re-exports the moment that file exists on main — iteration 32 verified the
compatibility and prepared the WorkLane→core-types dependency flip (core-types must be a
ZERO-import leaf so the webapp's tsc program footprint stays one file), then found the kernel
absent from main. Working the slices on a branch stacked on #315 would recreate the
stacked-PR wrong-base trap; blocking on the merge is the recorded discipline (concern 14's
precedent). Slice 1 (event kinds, PR #317) is complete and independently mergeable.

## Provenance
Whole-repo report candidate 3 (Strong).
