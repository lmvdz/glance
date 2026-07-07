# Model-identity key coherence — record must equal read

STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/model-outcomes.ts, src/smart-spawn.ts, src/attribution-scoreboard.ts

## Goal
Make the model identity used at RECORD time and at READ time provably identical, so a candidate/incumbent can actually match a recorded row. Today they cannot: the shift can never fire by construction.

## Evidence it's broken
- Record: `squad-manager.ts:2494` → `recordModelOutcome(this.stateDir, dto.model, tier, ok)`. `dto.model` for a default-config run is backfilled by `applyState` to the `provider/id` form (e.g. `anthropic/claude-opus-4-8`); a claude-code receipt carries the bare id `claude-opus-4-8`.
- Read: `smart-spawn.ts:36` `SHIFT_CANDIDATES = ["opus","default"]`; the incumbent the scorer subtracts is the label `"default"`.
- `"default"` and `"opus"` never appear as recorded keys ⇒ `outcomes("default", tier)` is always `{0,0}` ⇒ `shiftedModel:64` early-returns. The scoreboard (`attribution-scoreboard.ts`) folds keys by the same `modelKey`, so it inherits the same identity question.

## Approach
Pick ONE canonical model-identity function and route BOTH record and read through it.
- Define a `modelFamily(model?: string): string` normalization: strip provider prefix and version suffix to a stable family (`anthropic/claude-opus-4-8` → `opus`; `claude-fable-5` → `fable`; `anthropic/claude-sonnet-5` → `sonnet`; empty/undefined → the resolved default family, NOT a phantom `"default"`). Reuse `model-lineage.ts`'s parsing if it already extracts family/provider — do not add a second parser that can drift.
- The phantom-incumbent problem: `"default"` is a spawn-time concept that never survives into the ledger. Resolve the *actual* family the default routes to (omp's configured default model → its family) so the incumbent is a real recorded row, or redefine the incumbent as "the family the current heuristic would pick for this tier" and ensure that family is what gets recorded.
- Update `SHIFT_CANDIDATES` / candidate enumeration to families, and `buildScoreboard`'s `modelKey` usage to the same `modelFamily`, so the scoreboard rows and the scorer candidates share one namespace.
- Guard the cross-provider leak (red-team MINOR 5): candidates must be restricted to families compatible with the spawn's provider/harness — never let a well-landing `openai/gpt-5.5` row become the chosen model for an Anthropic-subscription omp unit.

## Cross-Repo Side Effects
None. Concerns 03/04/05 depend on this namespace; the scoreboard UI (`ScoreboardPanel.tsx`) will render family keys instead of raw ids — confirm that reads acceptably.

## Verify
Unit test: record an outcome for a `provider/id` model, then read it back via the candidate/incumbent path and assert a hit (not `{0,0}`). Assert `modelFamily` round-trips the real on-disk shapes (`anthropic/claude-opus-4-8`, bare `claude-opus-4-8`, undefined). Assert a cross-provider family is excluded from an omp spawn's candidate set.
