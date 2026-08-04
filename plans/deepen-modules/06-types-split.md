# types.ts split — a minimal core, lane-owned types
STATUS: in-progress
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/types.ts (1,723 lines, ~90 types, 12+ domains, 112 importers), per-lane types modules
MODE: afk

## Goal
Per-lane type modules next to their lane's code (memory/, voice, land, feedback, room), a
genuinely minimal `core-types.ts` (Actor, AgentStatus, IssueRef, TranscriptEntry…), and the
210-line `AgentDTO` split into a slim roster projection + lane detail views. Deletion test today
fails hard: removing types.ts breaks 112 files across every lane — coupled by proximity alone.
Best done incrementally as lanes gain directories (01's recipe); FeatureDecision already wants to
live in src/memory/.

## Slice ledger
- Slice 1 done (2026-08-04, iteration 18): the nine feedback domain types moved into
  src/feedback.ts (their lane), type-only re-exports left in types.ts so all 112 importers keep
  compiling; feedback.ts now imports only IssueRef from types.ts. codex clean; grok flaked twice
  (quota-shaped, noted — no coverage pretended). Next slices: room/channel types → channels
  lane, memory types → src/memory, land types, then the 210-line AgentDTO split (the hard one).

## Provenance
Memory-lane report candidate 6; whole-repo report concurs via its wire-contract candidate (08).
