# Record fields + scorer
STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/types.ts, src/validator.ts

## Goal
`ValidationRecord` carries the author/reviewer lineage pair and a `sameLineage` flag; the scorer computes them honestly.

## Approach
- `src/types.ts` `ValidationRecord` — add optional fields (all additive, back-compat):
  ```ts
  authorLineage?: ModelLineage;
  reviewerLineage?: ModelLineage;
  /** true = author and reviewer share a vendor lineage (correlated blind spots → weaker signal).
   *  undefined = one side's lineage is unknown; we do NOT assert same-lineage we can't substantiate. */
  sameLineage?: boolean;
  ```
  Import `ModelLineage` from `./model-lineage.ts`. Keep the existing `model?: string` (raw reviewer model) untouched.
- `src/validator.ts`:
  - `ValidatorGateOpts` + a new param on `scoreAgainstCriteria` for the author's model and harness: `authorModel?: string; authorHarness?: string`.
  - In `scoreAgainstCriteria`, compute `reviewerLineage = modelLineage(validatorModel())`; `authorLineage = modelLineage(authorModel) or harnessLineage(authorHarness)` when the model is unknown; `sameLineage = (both known && not "unknown") ? authorLineage === reviewerLineage : undefined`.
  - Stamp all three on EVERY returned `ValidationRecord` branch that already sets `model` (the pass/veto branch, the abstain branches) — but on the `"skipped"`/empty-criteria and empty-diff branches leave them off (nothing was judged). Keep the existing behavior otherwise; never throw.
  - Thread `authorModel`/`authorHarness` from `validatorGate(opts)` → `scoreAgainstCriteria(...)`.

## Cross-Repo Side Effects
None. Consumers (03, 04) read the new optional fields.

## Verify
`bun test src/validator.test.ts` (extend it): author `sonnet` + reviewer default `opus` → `sameLineage: true`, both `anthropic`. Author `gpt-5` + reviewer `opus` → `sameLineage: false`. Author unknown (`undefined`, harness `omp`) → `sameLineage: undefined`. Author unknown but harness `gemini` → `authorLineage: "google"`, `sameLineage: false`. `bunx tsc --noEmit` clean.
