# VERIFY re-check — one narrow second look at a high-severity objection
STATUS: in-review
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/validator.ts, src/types.ts

RE-LAND NOTE (2026-07-07): code cherry-picked back from orphaned worktree-research-recursive-orchestration (was merged in PR #96 as plan-only, code never reached main) — see reland/pr96-review-lens; STATUS held at in-review until that PR merges.

## Goal

The missing ACCEPT/REJECT/VERIFY middle branch: when a lens raises a high-severity objection,
don't blindly trust it and don't ignore it — fire **one** narrow re-check scoped to exactly that
claim, and record whether it was confirmed. Bounds the cost to ≤1 extra call and only when
warranted.

## Approach

In `src/types.ts`, extend `ValidationRecord` with
`lensVerify?: { lens: LensId; claim: string; confirmed: boolean };`.

In `src/validator.ts`, after aggregating `lensAdvisory` (concern 03):

- Trigger **only** when some `LensVerdict` has `severity === "high"` && `disposition === "object"`.
  A `low` objection is confidence-only (no re-check).
- Fire one `decideTyped` call (same machinery, guarded parser, fail-open → treat failure as
  `confirmed: false` = do not escalate on an unreachable re-check) with a prompt scoped to the
  single claim: *"A reviewer flagged this specific concern about the diff: `<claim>`. Inspect the
  diff and decide: is the concern substantiated? Answer confirmed / refuted / inconclusive."*
  Map confirmed→`true`, refuted/inconclusive→`false`.
- **Structural flag nesting.** The re-check code path must be reachable only from inside the
  already-fired panel (which is itself behind the master `OMP_SQUAD_LENS_REVIEW` flag). The
  sub-flag `OMP_SQUAD_LENS_VERIFY` only toggles the re-check *within* an enabled panel — it must
  NOT be read at a seam that runs when the master flag is off. Concretely: check for the existence
  of a high-severity objection (which requires the panel ran) *before* reading `OMP_SQUAD_LENS_VERIFY`.
- A `confirmed: true` result maximizes the confidence penalty (concern 04 maps it to the
  `"confirmed"` bucket) and — deferred — flags review-needed in the UI. It **never** vetoes; do not
  wire it to `validatorGate`'s `veto` return. This is the #3 hard-constraint line, enforced in code.

## Cross-Repo Side Effects

`finalizeRun` (concern 04) reads `lensVerify` to pick the `"confirmed"` confidence bucket. Field is
optional — no consumer breaks if absent.

## Verify

- Test: a high-severity `object` verdict triggers exactly one re-check call; a `low` objection
  triggers none; an `accept` triggers none.
- Test: **master flag off + `OMP_SQUAD_LENS_VERIFY=1` ⇒ zero re-check spawns** (default-off
  integrity — the re-check is unreachable without a fired panel).
- Test: re-check process failure → `confirmed: false`, land proceeds, no escalation.
- Test: a `confirmed: true` never changes `validatorGate`'s `veto` return.
- `bun test` green; `tsc` clean.
