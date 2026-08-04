# types.ts split — a minimal core, lane-owned types
STATUS: done
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

- Slice 2 done (2026-08-04, iteration 19): FeatureDecision → src/memory/decision-ledger.ts (via
  the barrel — codex caught the deep import my own boundary test would have flagged; row
  recorded) and RunReceipt/ReceiptRollup → src/receipts.ts; types.ts keeps import-then-re-export
  because it uses both internally. Room/channel types turned out ALREADY migrated (types.ts
  imports ChannelEntry from the lane). Remaining: land types (mostly lane-resident already),
  then the AgentDTO split (the hard one) + the minimal core extraction.

- Land-types disposition (2026-08-04, iteration 25): NO MOVE. The audit found exactly one land
  type left in types.ts — the `LandReadiness` alias — and it is feature-lane vocabulary
  (FeatureWorktreeStatus.readiness, features.ts ranking), not land-lane machinery; the land
  cluster (land.ts, land-ledger.ts, land-assessment/) already owns its own types. Moving one
  alias would churn importers for zero depth. Recorded so the checklist item doesn't read as
  forgotten.

- Slice 3 done (2026-08-04, iteration 25): the AgentDTO split — six facet interfaces
  (RosterCore/Harness/Workflow/Work/Land/Attention) with AgentDTO = their extends-intersection.
  Wire-identical (types erase; tsc across all 112 importers is the proof), 72 fields in/out
  verified by script, every doc comment moved with its field. tests/agent-dto-facets.test.ts
  freezes the decomposition at compile time: mutual assignability both directions + pairwise
  key disjointness (each field has exactly one home). Consumers can now name the slice they
  read — attention-ladder.ts's Pick<> idiom promoted to the declaration site. Remaining: the
  minimal core extraction (last slice).

- Slice 4 done (2026-08-04, iteration 26) — CONCERN COMPLETE: src/core-types.ts is the shared
  kernel (Role/Actor/Availability, AgentStatus, PendingRequest, ScopeSource, IssueRef, the
  seven-type transcript grammar) — 14 types, one import (lane.ts's WorkLane), moved verbatim
  with import-then-re-export in types.ts. The kernel passes its own deletion test: every lane
  depends on it, it depends on none. codex CLEAN (byte-identical blocks, 160 type-only
  bindings, cycle proven erased under isolatedModules, ratchet-simulation pinning the +1 to
  pre-existing reconcileWorkosOrgs); grok flaked (gap recorded). types.ts: 1,723 → 1,454 over
  the concern; feedback/decision/receipt/land/room domains lane-owned; AgentDTO faceted.

## Provenance
Memory-lane report candidate 6; whole-repo report concurs via its wire-contract candidate (08).
