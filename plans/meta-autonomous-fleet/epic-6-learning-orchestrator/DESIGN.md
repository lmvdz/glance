# Epic 6 sub-plan — design decisions

This file records the judgment calls the NEW leaves (06/07/08) depend on, and the freshness
corrections for the pass-through leaves (01–05). The `agentic-learning-loop` DESIGN.md holds the
substrate's own decisions and cut list — read it first; this file only adds the model-assignment layer.

## Freshness re-check of the pass-through concerns (01–05)

All five concerns' `TOUCHES` files were verified to exist (or to be correctly marked new). Line
numbers cited inside them drifted since they were written — apply these corrections when you open each:

| Concern | Cited | Actual (this tree) | Note |
|---|---|---|---|
| 01 | `src/metrics.ts` (new), `src/proof.ts` `isFresh` exported | `isFresh` at `src/proof.ts:111` | `metrics.ts` confirmed absent. `isFresh` moved 103→111. |
| 02 | `FabricSearchResult` at `src/fabric-search.ts:34` | `interface FabricSearchResult` at `:34` | Correct. `buildContextPrimer` at `:191`; "Caller is responsible for fencing" docstring at `:188` (grep target still valid). |
| 03 | `buildDigest` `src/digest.ts:49`; `isFresh` `src/proof.ts:103`; weight fold `src/fabric-search.ts:162` | `buildDigest` at `:49`; `isFresh` at `:111`; `doc.weight` fold at `src/fabric-search.ts:163` (inside `searchFabric`, `:137`) | Update the two proof.ts:103 refs to :111. `fenceUntrusted` exported from `src/digest.ts:90`. |
| 04 | `src/reflection.ts` (new); graph `verify→codefix→fixup` in `verify-workflow.ts`; `resolver.ts` pure | `reflection.ts` confirmed absent; `src/orchestrator.ts` present; `recordLandOutcome` used at land site | No correction needed; attach points hold. |
| 05 | `observer.ts` fingerprint streak + `LandLedger` `≥3`; `loadScoutFacts` scope pattern | `LandLedger` type in `src/land-ledger.ts:28`; streak cap via `landFailureCount` / `recordLandOutcome` | No correction; `loadScoutFacts` is the scope-filter template to copy. |

These are pass-throughs: execute them from `plans/agentic-learning-loop/NN-*.md`. Do NOT rewrite those
files — the corrections above are the only deltas.

## New layer — outcome-driven model assignment

### Decision: a NEW per-`(model, tier)` ledger, not a field on `land-ledger.ts`

The epic seed says "read landed-vs-rejected per `model × complexity tier` from `land-ledger.ts`." Ground
truth: `src/land-ledger.ts` keys purely on **branch** and stores only a consecutive-failure streak
(`LandFailure { fails, lastDetail, at }`) — it carries no model and no complexity, and a success
*deletes* the entry. It cannot answer `modelOutcomes(model, tier)`. So concern 06 authors a **new**
`src/model-outcomes.ts` that mirrors `land-ledger.ts`'s proven shape (sync read-modify-write of one JSON
file under `stateDir`, corrupt ⇒ empty, best-effort write) rather than overloading the failure streak.

### Decision: record at the existing land site, event-driven — no timer loop

The parent epic mentions "two continuous-improvement loops as siblings in `SquadManager.start()`." The
concrete mechanism does not need a timer: outcomes are **recorded on every land** and **read at spawn
time**. Recording attaches at `src/squad-manager.ts` land(), right beside the existing
`recordLandOutcome(this.stateDir, dto.branch, result.ok, ...)` call (~`:2190`), under the *same* guard
`if (!result.retryable && (auto || result.ok))`. No `setInterval`, no new `start()` sibling — this
matches how `land-ledger`, `done-proof`, and `automation-log` already work. (If a periodic rollup is
ever wanted, it can read the ledger later; the data layer does not depend on it.)

### Decision: the complexity tier is derived from the run's thinking level

There is no first-class "complexity" on a live agent. The reachable proxy at the land site is
`rec.options.thinking` (a `ThinkingLevel`, `CreateAgentOptions.thinking`), which intake/spawn already
set from task difficulty. Bucket it into three coarse tiers so the ledger stays dense:

```
minimal | low        -> "light"
medium               -> "mid"
high | xhigh         -> "heavy"
undefined            -> "mid"   (default thinking is "low" in create(), so undefined is rare)
```

Model key = `rec.dto.model ?? "default"` (the default-model runs bucket together under `"default"`).
Ledger key = `` `${model}::${tier}` ``. Put both the `tierOf(thinking)` bucketer and the `MODEL_KEY`
normalizer as exported helpers in `src/model-outcomes.ts` so concern 07 reuses the *same* bucketing at
spawn time (symmetry is load-bearing — record and read must agree on the tier).

### Decision: recording is always-on; only the *shift* is flag-gated

Recording is a cheap, harmless statistic (like `land-ledger`), so it runs unconditionally — this keeps
the baseline populated even while the consumer is off, so A/B has data on day one. The **consumer**
(concern 07's default-shift) is gated behind `OMP_SQUAD_MODEL_OUTCOMES` (default **off**). Concern 06
also emits a metric tag via concern 01's helper so the ledger's effect is attributable.

### Decision: the shift is boost-only, floored, and never overrides an explicit choice

Concern 07 applies the shift inside `planSpawn` (`src/smart-spawn.ts`). Rules, in order:

1. If the model planner already returned an explicit `model` (LLM said "opus"), **never override it.**
2. Compute the tier from the plan's resolved `thinking` (same `tierOf`).
3. Read `modelOutcomes(model, tier)` for each candidate model that has data in this tier.
4. **Exploration floor:** ignore any candidate with fewer than `MIN_SAMPLES` (=8) total outcomes — a
   cold model is *not eligible to win*, but is *never demoted below baseline* either (it still gets the
   base heuristic's traffic; the shift only ADDS a preference toward a proven winner).
5. Shift the default to the best-landed-rate candidate **only if** its landed-rate beats the incumbent
   default by ≥ `MIN_EDGE` (=0.15). Otherwise leave the default unchanged.

This is the reconciliation with the substrate's cut: it is *outcome statistics biasing a default*, not
*capability matching*, never a land gate, and structurally incapable of starving a cold model.

### Note: `planSpawn` is currently dormant (like `buildTddVerifyWorkflow`)

`planSpawn` / `discoverRepos` are referenced only by `tests/smart-spawn.test.ts` — no live caller wires
them into `create()` (the live path just passes `opts.model` through). Concern 07 therefore targets the
*designated model-heuristic seam* named by the epic and is **unit-test verified**; wiring `planSpawn`
into the live spawn path is explicitly out of scope (a separate concern, parallel to Epic 2 wiring the
dormant TDD workflow). To keep concern 07 testable without a live caller, `planSpawn` gains an injected
optional `outcomes?` reader (dependency injection, exactly like `routeIntake`'s injected `classify`).

## Concern 08 is a branch, not a leaf

The confidence-threshold tuner consumes "Epic 5's confidence + landed-vs-rejected." Epic 5 (HITL) is a
*sibling* epic that authors the confidence field on the run record and the confidence *cap* inside
`maxEffectiveMode` (`src/autonomy.ts`). Neither exists yet — `grep -n confidence src/autonomy.ts`
returns nothing. Tuning a threshold that has not been created is an unresolved design dependency, so 08
stays a leaf-shaped **stub** (`isLeaf: false`) and is flagged for a deeper sub-plan to be authored once
Epic 5 has shipped its confidence seam. It is included here only to hold the scope and the dependency
edge.
