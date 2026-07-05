# Confidence-threshold tuner

STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural
ISLEAF: false
BLOCKED-BY: Epic 5 (HITL safeguards) — confidence field + confidence cap in maxEffectiveMode
NEEDS-DEEPER: yes — decompose into leaves once Epic 5's confidence seam exists

TOUCHES: src/autonomy.ts, src/metrics.ts, src/model-outcomes.ts

## Why this is a branch, not a Sonnet-ready leaf

The tuner refines the propose-only (`assist`) confidence threshold — and decomposition granularity —
using Epic 5's per-run confidence signal correlated against landed-vs-rejected outcomes. That signal
does not exist yet:

- `src/autonomy.ts` models `observe|assist|autodrive` and `maxEffectiveMode` (`:24`) caps the mode by
  approval/autoLand only — **no confidence input**. `grep -n confidence src/autonomy.ts` returns
  nothing today.
- Epic 5 (HITL safeguards) is the sibling epic that authors (a) a confidence score on the run record
  and (b) a confidence *cap* rule inside `maxEffectiveMode` (parallel to the existing
  `blockedReason → observe` rule). The meta-plan dependency graph makes Epic 6 blocked-by Epic 5 for
  exactly this reason.

Tuning a threshold that has not been created is an unresolved design dependency. Per the recursion
contract, this stays a leaf-shaped stub until Epic 5 ships, then gets its own sub-plan.

## Intended goal (for the future sub-plan)

Close the loop: observe the correlation between Epic 5's confidence score at spawn/land and the actual
landed-vs-rejected outcome (from concern 06's `modelOutcomes` and concern 01's metrics), and nudge the
`assist`-cap confidence threshold so the propose-only gate fires when — and only when — low confidence
actually predicts rejection. Bounded step size; boost-only framing (never ratchet the threshold into
blocking a class of work that has been landing cleanly).

## Approach seed (verify against Epic 5's real seam before decomposing)

- Read the confidence field Epic 5 adds to the run record + concern 06's per-`(model,tier)` outcome
  rates + concern 01's escalation/first-try-green metrics.
- Fit a single scalar threshold (and optionally a per-tier one) that maximizes agreement between
  "low-confidence" and "rejected"; adjust by a small bounded step per rollup, floored/ceilinged.
- Feed the threshold into Epic 5's confidence cap in `maxEffectiveMode` — the tuner writes the
  threshold; `maxEffectiveMode` reads it. Gate behind `OMP_SQUAD_THRESHOLD_TUNER` (default off).

## Preconditions to re-check before turning this into leaves

- `grep -n "confidence" src/autonomy.ts` returns the confidence field/cap (Epic 5 leaf shipped).
- The run record carries a persisted confidence score readable at rollup time.
- Concern 06 (`src/model-outcomes.ts`) and concern 01 (`src/metrics.ts`) are merged.

## Verify (deferred)

No acceptance test until Epic 5's confidence seam exists. Once it does, the future sub-plan's leaves get
concrete `bun test` targets over the threshold-fitting function and an A/B metric on escalation
precision.
