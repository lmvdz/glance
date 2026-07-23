# State-projection contract tests (executable litmus)
STATUS: done — merged via PRs #201/#212 (concern 08: 0bf3389, src/land-assessment/hook.ts); verified on main, 2026-07-21 reality audit
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 01, 11
TOUCHES: src/land-assessment/projection.test.ts, src/land-assessment/replay/synthetic-timeline.ts

## Goal
The litmus test as executable contract tests, existing BEFORE any live land integration (ADR phase gate) — not deferred to "after several hundred assessments." These are state-engine unit tests, not product analytics.

## Approach
`synthetic-timeline.ts`: a scripted fixture repository timeline exercising every epistemic seam:
```text
A: module exports Foo
B: Foo signature changes (accepted landing)
C: candidate removes Foo — REJECTED
D: candidate renames Foo → Bar — LANDED (R differs from C: squash)
E: main gains a new consumer of Bar (external transition — not through glance)
F: an earlier inferred belief is superseded by a deterministic observation
```
Build the fixture as real git history in-test plus the corresponding events/snapshots/observations/manifest records written through the real store writer (07) and schema (01).

`projection.test.ts` proves, via the lineage projector (11), that the accumulated data answers:
- What did A export? (manifest + projection)
- What changed A→B? (ChangeObservations)
- Was C ever accepted? (must be NO — attemptDisposition rejected; its deterministic observations still queryable as counterfactual history)
- Which rejected attempt removed Foo? (episodic query)
- Which landed result introduced Bar? (C→R transition edge; accepted state from R, not C)
- What did glance believe before D, and which observation superseded that belief? (observation-time query + support: superseded)
- Does E flip continuity to `unknown` until reconciled? (external-transition detection)

Also the **second-producer contract check** (ADR gate, testable now): write a mock verification-execution observation (test command, exact commit/tree, result, covered entities) through the SAME schema types — the test fails if any schema change is needed to accommodate it.

## Cross-Repo Side Effects
None.

## Verify
`bun test src/land-assessment/projection.test.ts` green — every litmus query answered from stored records only (no re-extraction of the fixture repo permitted inside the queries); concern 08 must not start until this is green (BLOCKED_BY enforces it).
