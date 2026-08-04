# Decision ledger — the lane's write path as a deep module
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/memory/decision-ledger.ts, src/squad-manager.ts (delegations), src/server.ts (routes thin), tests/decision-ledger.test.ts
MODE: afk

## Goal
capture → persist → supersede behind one interface (`record`/`capture`/`supersede`/
`sanitizePatchDecisions`) over a 3-method store port (get/adopt/changed); two adapters (manager
Map in prod, bare Map in tests) make the seam real. Ends the era of 13 test files casting
`(mgr as unknown as { featureStore: Map })`.

## Done
PR #310 commit c6c9ea25. Semantics verbatim (concurrency contract preserved — codex live-probed
the two-writer adopt race: one winner). Follow-up: migrate the 13 reach-through test files to the
ledger interface and delete the casts (they still pass via the delegation today).
