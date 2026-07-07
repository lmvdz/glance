# Confidence integration — advisory lens verdict into the auto-land hold lever
STATUS: in-review
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/confidence.ts, src/squad-manager.ts, tests/confidence.lens.test.ts

RE-LAND NOTE (2026-07-07): code cherry-picked back from orphaned worktree-research-recursive-orchestration (was merged in PR #96 as plan-only, code never reached main) — see reland/pr96-review-lens; STATUS held at in-review until that PR merges. Also fixed: its `*.test.ts` files lived under `src/`, outside bunfig.toml's `[test] root = "tests"` scope — the "48 lens tests" never actually ran in the gating `bun test`; moved to `tests/` so they do.

## Goal

Feed the lens's advisory verdict into `scoreConfidence` so a lens objection lowers a run's
confidence — which, when the operator has enabled the confidence floor, **holds the auto-land for
operator approval** instead of auto-merging. This is the feature's real behavioral lever, verified
to reach a live gate.

## Approach

In `src/confidence.ts`:

- Extend `ConfidenceInput` (`:16-24`) with `lensAdvisory?: "clean" | "objected" | "confirmed"`.
- In `scoreConfidence` (`:27`), add a delta below the primary validator's magnitude: `clean`
  +0.05, `objected` −0.15, `confirmed` −0.25 (primary is ±0.1 / veto −0.4). Absence → neutral
  (preserve the existing "absence = unknown, never penalize" doctrine at `:19-23`).
- **Clamp the final score to [0,1].** Same-lineage (+0.05) plus a lens penalty can otherwise drive
  the score out of range (RT1 minor). Add the clamp if `scoreConfidence` does not already have one.

In `src/squad-manager.ts` `finalizeRun` (`:4945`):

- Derive the `lensAdvisory` bucket from `rec.dto.validation?.lensAdvisory` (+ `lensVerify` from
  concern 05 when present): any `confirmed` high-severity → `"confirmed"`; else any `object` →
  `"objected"`; else if lenses ran and all `accept` → `"clean"`; else omit (undefined/neutral).
- Pass it into the existing `scoreConfidence({ ... })` call. No new plumbing — `conf` already flows
  to `receipt.confidence` (`:4946`) and `rec.dto.confidence` (`:4973`), and `confidenceBelowFloor`
  (`:685`, called at `:2430`) already reads `dto.confidence`.

The behavioral effect is **only active when the operator sets `OMP_SQUAD_CONFIDENCE_FLOOR`** (the
floor read is flag-gated). With no floor, the penalty is recorded but inert — the correct shadow
posture.

## Cross-Repo Side Effects

None beyond the confidence score. The auto-land hold path (`:2430-2436`) is unchanged — it already
consumes `dto.confidence`; this concern only changes how that number is computed.

## Verify

- `src/confidence.test.ts`: `objected`/`confirmed` lower the score by the stated deltas; `clean`
  raises by +0.05; absence is neutral; result never leaves [0,1] even with `sameLineage` stacked.
- Integration check: with `OMP_SQUAD_CONFIDENCE_FLOOR=0.5`, a run whose lens `confirmed` an
  objection drops below floor → `land(auto:true)` returns `staged: true` ("auto-land held") rather
  than merging (drive the `confidenceBelowFloor` branch at `:2430`).
- `bun test src/confidence.test.ts` green; `tsc` clean.
