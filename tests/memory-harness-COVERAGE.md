# Memory-harness scenario coverage (HARNESS-SPEC.md §3, G01–G12)

Enumerates where each scenario's seam-level assertion lives. "Status" is what the corpus row
requires (HARNESS-SPEC §3's "Classes exercised" column); "Where" points at the exact test file.

| ID | Blueprint | Classes exercised | Status | Where |
|---|---|---|---|---|
| G01 | supersede-endpoint | E_anach, E_contra | DONE | `tests/memory-harness.test.ts` — "G01 supersede-endpoint" |
| G02 | mid-kill-orphan | E_orphan, R_step | DEFERRED | needs a scoped worker-kill/resume replay fixture (room-threads node summaries) this repo has no deterministic unit-test seam for yet |
| G03 | revoke-then-tempt | E_gov_breach | DONE | `tests/memory-harness.test.ts` — "G03 revoke-then-tempt" |
| G03b | restore-then-tempt | E_gov_halt (guard) | DONE | `tests/memory-harness.test.ts` — "G03b restore-then-tempt" |
| G04 | exact-hash-drilldown | E_abstract, E_halluc | DONE | `tests/memory-harness.test.ts` — "G04 exact-identifier-drilldown" |
| G05 | parallel-contradict | E_contra, E_pollute | DONE (E_contra/I5 only — see note) | `tests/memory-harness.test.ts` — "G05 parallel-contradict" |
| G06 | stale-patch-resurrect | I4 (chain integrity) | PRE-EXISTING | `tests/decision-supersession.test.ts` — PATCH-merge chain-integrity tests |
| G07 | aba-reassert | dedupe legality, E_anach | PRE-EXISTING | `tests/decision-supersession.test.ts` — "text de-dupe considers only CURRENT decisions" |
| G08 | compaction-drift | E_drift | DONE (single-cycle regeneration idempotence; see note) | `tests/memory-harness.test.ts` — "G08 regeneration-idempotence" |
| G09 | budget-eviction | budget governance (E_constraint precursor) | PRE-EXISTING | `tests/fabric-search.test.ts` — "primer regions" describe block |
| G10 | copied-id-ergonomics | tool ergonomics (false-refusal path) | PRE-EXISTING | `tests/decision-supersession.test.ts` — "a supersedes id copied verbatim from kb output... is accepted" |
| G11 | handoff-honors-promise | N_re-dec, E_contra | DEFERRED | needs a scoped worker-handoff (SPAWN_EXIT_HANDOFF) replay fixture — same room-threads node-summary gap as G02 |
| G12 | mid-turn-revoke-gate | E_gov_breach (authority-at-the-gate probe) | DONE | `tests/memory-harness.test.ts` — "G12 mid-turn-revoke-gate" |

## Notes on partial coverage

- **G05** exercises E_contra/I5 (two concurrent supersessions of the same decision never both win)
  at the `recordAgentDecision` seam. E_pollute (worker-B reading worker-A's *uncommitted scratch*
  namespace) is a different seam this repo has no in-process scratch-namespace partition to unit-test
  against yet — not attempted here rather than faked.
- **G08** exercises E_drift's regeneration-idempotence property (`buildDigest` is a pure function of
  its input; two calls on identical — but not object-identical — input produce byte-identical output)
  as a single-cycle property. The full HARNESS-SPEC blueprint is 5×(COMPACT + TIME_JUMP(24h)) with a
  probe-set question after each cycle; that requires a probe-set fixture and a COMPACT-cycle harness
  this repo doesn't have yet, so this test locks down the seam-level guarantee the multi-cycle version
  would depend on (if regeneration isn't idempotent on ONE cycle, it can't be idempotent across five).
- **G02 / G11** are deferred, matching the task's brief: both need a scoped worker-kill/handoff replay
  fixture keyed off room-threads node summaries, which isn't wired into this repo's deterministic
  test seams yet.
