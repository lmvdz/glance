# Model-identity key coherence — record must equal read

STATUS: in-review
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/model-outcomes.ts, src/smart-spawn.ts, src/attribution-scoreboard.ts, src/cost-gate.ts, src/model-lineage.ts

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

## Resolution — SHIPPED (2026-07-07, feat/sirvir-02-key-coherence)

**One namespace, both directions.** `model-outcomes.ts` gained `modelFamily(model?: string): string` — the ONE function now used at record time (`recordModelOutcome`/`recordModelOutcomeBlocked`) and every read time (`modelOutcomes`, `readModelOutcomes`, `smart-spawn`'s candidate scan, `attribution-scoreboard`'s daemon-cost fold, `cost-gate`'s projection join). It delegates the actual keyword parsing to `omp-graph/attribution.ts`'s existing `modelFamily()` (no second parser — provider prefixes and version suffixes are already substring-matching-agnostic there) and adds exactly one rule: empty/undefined resolves to `DEFAULT_MODEL_FAMILY` (`"sonnet"`, mirroring `model-route.ts`'s `ROUTE_CHEAP_FAMILY` — a drift-guard test asserts the two constants stay equal), never the base function's own `"unknown"` and never the old phantom `"default"` string.

**Mapping table** (every shape the receipts audit found, `plans/orchestration/reports/receipts-audit-2026-07-07.md` §3):

| raw shape observed | → family |
|---|---|
| `<missing>` / undefined / empty (422/543 receipts) | `sonnet` (`DEFAULT_MODEL_FAMILY`) |
| `openai-codex/gpt-5.5`, bare `gpt-5.5` | `openai` |
| `claude-opus-4-8`, bare alias `opus`, `anthropic/claude-opus-4-8` | `opus` |
| `claude-fable-5` | `fable` |
| `claude-sonnet-5`, `claude-sonnet-4-6` | `sonnet` |
| `claude-haiku-*` | `haiku` |
| anything unrecognized (non-empty) | `other` |

**Migration story:** read-time normalization, not a one-shot script. `readLedger` folds every on-disk `${rawKey}::${tier}` entry through `migratedFamilyOf` (same `modelFamily`, plus one migration-only rule: the literal `"default"` key — the OLD `modelKey()`'s own phantom bucket-name, never a real model id — folds to `DEFAULT_MODEL_FAMILY`). Two old keys colliding onto the same family+tier are SUMMED (`landed`/`rejected`/`blocked`), never shadowed or dropped. The fold is idempotent (a fixed-point test asserts every real family name maps to itself) and persists automatically: the next `recordModelOutcome`/`recordModelOutcomeBlocked` call writes back the already-folded shape as a side effect of its normal read-modify-write — no separate migration step to run or forget.

**Cross-provider guard (red-team MINOR 5):** `smart-spawn.ts` exports `eligibleCandidates(candidates, provider = DEFAULT_PROVIDER)`, filtering via `model-lineage.ts`'s `modelLineage`. `shiftedModel`'s eligibility loop runs `eligibleCandidates(SHIFT_CANDIDATES)` instead of the raw array, so a cross-vendor family can never win an Anthropic-subscription omp unit's shift even if a future/wider candidate set includes one. Fixing this exposed a real bug in `model-lineage.ts`: `modelLineage("openai")` resolved to `"unknown"` (its own base `modelFamily` doesn't recognize the literal string `"openai"` as itself — same fixed-point gap) — added a family-literal fast path there too, with a regression test.

**Deferred/out of scope:** none — the concern's stated scope (`model-outcomes.ts`, `smart-spawn.ts`, `attribution-scoreboard.ts`) is fully implemented; `cost-gate.ts` (consumer import rename) and `model-lineage.ts` (fixed-point bugfix) were necessary, minimal spillover, not scope creep — neither touches `dispatch.ts`/`rate-limit.ts`/`receipts.ts` (this wave's forbidden files). `squad-manager.ts` needed NO changes: its `recordModelOutcome(this.stateDir, dto.model, ...)` call site already passes the raw model through, and `modelFamily` normalizes it transparently.

**Proof:** `bun run check` clean. Full `bun test` 1993 pass / 0 fail across 249 files. Effect-ratchet baselines untouched (no bump). New/updated tests: `tests/model-outcomes.test.ts` (modelFamily normalization + drift guard + migration fold, 32 tests total), `tests/smart-spawn.test.ts` (family-namespaced SHIFT_CANDIDATES + `eligibleCandidates` guard, 18 tests), `tests/attribution-scoreboard.test.ts` (raw-shape-joins-family-row proof, 6 tests), `tests/model-lineage.test.ts` (family-literal fixed point, 11 tests).
