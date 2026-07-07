# Perspective-diversified review (out-of-criteria lens)

## Outcome

The land gate gains an advisory second review axis that catches regressions the declared
acceptance criteria never named (security / scope / perf-shaped problems the criteria judge is
structurally told to ignore). It fires only on risky diff surfaces, lowers a run's confidence
(holding the auto-land for operator approval when the floor is enabled), and never touches the
single authoritative veto. Default-off, fail-open, shipped in shadow mode so its value is
measured before any pool is built.

## Work

| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 lens selector | Pure, no-LLM `selectLenses(files, criteriaText?)` — decides *whether* a lens fires from the diff surface, reusing existing risk classifiers. The affordability gate. | mechanical | `src/lens-select.ts` (new), `src/lens-select.test.ts` (new) |
| 02 lens judge machinery | `LensJudge` seam + `ompLensJudge` on the same `decideTyped`/`omp -p` path; guarded parser; fail-open contract (`throw|timeout|garbage → undefined`). One out-of-criteria lens. | architectural | `src/validator.ts`, `src/types.ts`, `src/validator.lens.test.ts` (new) |
| 03 gate wiring + aggregation | Fire the lens **sequentially after** the criteria judge, only on non-veto/non-abstain/non-docs; cache-miss-only with a criteria-scoped key; write `lensAdvisory` onto the record. | architectural | `src/validator.ts` |
| 04 confidence integration | `ConfidenceInput.lensAdvisory` weighted + clamped; threads through `finalizeRun` → `dto.confidence` → the auto-land hold gate. | mechanical | `src/confidence.ts`, `src/squad-manager.ts`, `src/confidence.test.ts` |
| 05 VERIFY re-check | `severity:high` + `object` → one narrow re-check scoped to the claim; `lensVerify` field; structurally nested under the master flag. | architectural | `src/validator.ts`, `src/types.ts` |
| 06 flags + default-off + shadow log | Flag surface via `config.ts`; a test proving zero extra spawns when the master flag is off; catch-logging so shadow value is measurable. | mechanical | `src/config.ts`, `src/validator.ts`, `src/validator.flags.test.ts` (new) |

## Order

| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01 | Standalone pure module; 02/03 import it. |
| 2 | 02 | Lens judge machinery; needs 01's `LensId`. |
| 3 | 03 | Wiring; needs 01 + 02. Sole owner of the `validatorGate` edits this pass. |
| 4 | 04, 05 | Both consume 03's `lensAdvisory` field. 05 also touches `src/validator.ts` — sequence 05 after 03 in the same worktree; 04 is disjoint (`confidence.ts`/`squad-manager.ts`). |
| 5 | 06 | Flags + default-off test; lands last so the test asserts the fully-wired feature stays dark by default. |

## Dependency graph

| Concern | Blocked by | 30s check |
|---|---|---|
| 01 | — | — |
| 02 | 01 | `grep -q "export type LensId" src/lens-select.ts` |
| 03 | 01, 02 | `grep -q "ompLensJudge" src/validator.ts` |
| 04 | 03 | `grep -q "lensAdvisory" src/types.ts` |
| 05 | 03 | `grep -q "lensAdvisory" src/types.ts` |
| 06 | 03 | `grep -q "lensAdvisory" src/validator.ts` |

## Notes

- **Adversarial design** (sonnet designer → 2 opus red teams → orchestrator arbiter): the draft
  shipped a concurrent panel that RT1 showed could starve the authoritative judge into a
  fail-open abstain, and RT2 attacked the premise (lens split = theater; confidence path = inert
  telemetry). The orchestrator **verified against code** that the confidence path *does* reach a
  real gate (`confidenceBelowFloor` reads the `scoreConfidence`-derived `dto.confidence`), and
  reworked the design: sequential-not-concurrent, one out-of-criteria lens shadow-first, advisory
  into the confidence-hold lever. See DESIGN.md.
- **The premise is on trial.** v1 exists to *measure* whether a focused lens catches what the
  monolithic judge misses. Concern 06's shadow log is the evidence gate for the deferred pool.
- **WIP snapshot at plan time (headless research→plan pipeline):** 107 plans with open concerns
  (oldest `meta-plan-autonomous-fleet:meta-autonomous-fleet` at 2026-07-05; ~half are
  `console-agent-tooling` scanner phantoms). Proceeded per the research→plan greenlight.
- Source: `plans/research-recursive-orchestration/BRIEF.md` (draft PR #96) → this plan.
