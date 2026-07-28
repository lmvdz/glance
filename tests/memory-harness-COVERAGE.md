# Memory-harness scenario coverage (HARNESS-SPEC.md §3, G01–G12)

Enumerates where each scenario's seam-level assertion lives. "Status" is what the corpus row
requires (HARNESS-SPEC §3's "Classes exercised" column); "Where" points at the exact test file.

| ID | Blueprint | Classes exercised | Status | Where |
|---|---|---|---|---|
| G01 | supersede-endpoint | E_anach, E_contra | DONE (projection seam — action-level anachronism needs the live-runner family) | `tests/memory-harness.test.ts` — "G01 supersede-endpoint" |
| G02 | mid-kill-orphan | E_orphan, R_step | PARTIAL (digest half landed 2026-07-27) | `tests/orphan-digest-reconstruct.test.ts` — daemon-death orphans detected by the unfinalized-tail rule (transcript newer than last receipt) and the digest rebuilt from persisted exhaust, marked RECONSTRUCTED; R_step (no re-executed effectful work on resume) still needs the live-runner family |
| G03 | revoke-then-tempt | E_gov_breach | PARTIAL — locks gate-consults-live-grant-state (no authority caching); the product revocation CHANNEL and the action-level breach lock need the live-runner family | `tests/memory-harness.test.ts` — "G03 revoke-then-tempt" |
| G03b | restore-then-tempt | E_gov_halt (guard) | PARTIAL — permission surface only (restored grant not hard-denied); action COMPLETION under a restored grant needs the live-runner family | `tests/memory-harness.test.ts` — "G03b restore-then-tempt" |
| G04 | exact-hash-drilldown | E_abstract, E_halluc | PARTIAL — byte-exact receipts round-trip + no-fabricated-uuid in digests + drill-down addressability; action-level lost-identifier failure needs the live-runner family | `tests/memory-harness.test.ts` — "G04 exact-identifier-drilldown" |
| G05 | parallel-contradict | E_contra, E_pollute | PARTIAL — outcome contract + the adopt-path raced-store guard under real await interleaving; E_pollute needs a scratch-namespace seam (see note) | `tests/memory-harness.test.ts` — "G05 parallel-contradict" |
| G06 | stale-patch-resurrect | I4 (chain integrity) | PRE-EXISTING | `tests/decision-supersession.test.ts` — PATCH-merge chain-integrity tests |
| G07 | aba-reassert | dedupe legality, E_anach | PRE-EXISTING | `tests/decision-supersession.test.ts` — "text de-dupe considers only CURRENT decisions" |
| G08 | compaction-drift | E_drift | PARTIAL — single-cycle regeneration purity (byte-identical across content-identical inputs); multi-cycle drift under changing input needs the COMPACT×5 runner form (see note) | `tests/memory-harness.test.ts` — "G08 regeneration-idempotence" |
| G09 | budget-eviction | budget governance (E_constraint precursor) | PRE-EXISTING | `tests/fabric-search.test.ts` — "primer regions" describe block |
| G10 | copied-id-ergonomics | tool ergonomics (false-refusal path) | PRE-EXISTING | `tests/decision-supersession.test.ts` — "a supersedes id copied verbatim from kb output... is accepted" |
| G11 | handoff-honors-promise | N_re-dec, E_contra | DEFERRED | needs a scoped worker-handoff (SPAWN_EXIT_HANDOFF) replay fixture — same room-threads node-summary gap as G02 |
| G12 | mid-turn-revoke-gate | E_gov_breach (authority-at-the-gate probe) | PARTIAL — locks per-call grant reads (a registration-time authority cache fails this); action-level breach needs the live-runner family | `tests/memory-harness.test.ts` — "G12 mid-turn-revoke-gate" |

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

## Blind-review adjudication (2026-07-27)

A zero-framing adversarial pass over this suite found the DONE labels over-claiming action-level
error-class locks that seam tests cannot provide. Response: G04 strengthened (every uuid-shaped
token a digest emits must BE the token — the E_halluc lock; vacuous re-assert removed), G05
strengthened (adopt-path race test — both captures cross the await, #277's raced-store guard is
now regression-locked), G07's primer half added, fake records given shape parity, and every
over-claiming label relabeled PARTIAL with the locked-vs-deferred property named. The deferred
half of every PARTIAL row is the same missing piece: a live-runner scenario family (agents
executing actions under disruption operators) — one gap, named once, owned alongside G02/G11.
