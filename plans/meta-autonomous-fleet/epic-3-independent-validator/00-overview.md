# Epic 3 — Independent validator + compliance (sub-plan)

Parent: `plans/meta-autonomous-fleet/03-independent-validator.md`
Design decisions for this epic: `DESIGN.md` (read it before starting any leaf).

## Outcome

Every land is gated by a **separate** agent lineage that scores the unit's diff against its
*declared* `acceptanceCriteria` (`FeatureCriterion[]`) — never the executor grading its own
self-authored test. Its veto is **not** on the human-overridable "or force" path: skipping it
requires an explicit, logged `validator-override` reason class distinct from a proof-force. A
compliance evaluator reads the three append-only ledgers and surfaces real policy findings in
`governancePayload` and the Observer loop. The validator's per-run agreement/confidence is emitted
onto the run record as the `validation` field that Epic 5's confidence scorer consumes.

## Work table

| # | Concern | Complexity | Leaf | Touches (verified) |
|---|---------|-----------|------|--------------------|
| 01 | Validator core — `scoreAgainstCriteria` + schema + independent judge + fixtures | architectural | yes | src/validator.ts (new), tests/validator.test.ts (new), src/omp-call.ts, src/proof.ts, src/types.ts |
| 02 | Validator land-gate — non-overridable veto at the `landBranch` mode-dispatch seam | architectural | yes | src/validator.ts, src/squad-manager.ts, src/land.ts, src/types.ts |
| 03 | Override reason class — force ≠ validator-override; distinct logged ledger record | mechanical | yes | src/land-ledger.ts, src/squad-manager.ts, tests/land-ledger.test.ts |
| 04 | Validation signal on the run record — the Epic 5 confidence input | mechanical | yes | src/types.ts, src/squad-manager.ts, tests/squad-manager (existing) |
| 05 | Compliance evaluator — `evaluateCompliance` over the ledgers + `governancePayload` | architectural | yes | src/compliance.ts (new), tests/compliance.test.ts (new), src/server.ts, src/audit.ts, src/land-ledger.ts |
| 06 | Compliance findings in the Observer loop | mechanical | yes | src/observer.ts, src/squad-manager.ts, src/compliance.ts |
| 07 | Adversarial refute-before-land (N skeptics, majority-refute kills) | research | **no** | src/validator.ts, src/squad-manager.ts |

## Batch order

- **Batch A (parallel, no deps):** 01 validator-core, 05 compliance-evaluator.
- **Batch B (parallel):** 02 validator-land-gate (needs 01), 06 compliance-observer-check (needs 05).
- **Batch C (parallel):** 03 override-reason-class (needs 02), 04 validation-signal (needs 02).
- **Batch D (deferred, flagged):** 07 adversarial-refute — needs its own sub-plan (see `flaggedNeedsDeeper`).

## Dependency graph

```
01 ──▶ 02 ──▶ 03
        └───▶ 04
        └───▶ 07 (deferred; own sub-plan)
05 ──▶ 06
```

30-second check per edge:
- **01 → 02**: leaf 02 imports `scoreAgainstCriteria` from `src/validator.ts`; grep `scoreAgainstCriteria` resolves. If 01 isn't merged, 02 won't compile.
- **02 → 03**: leaf 03's override path only matters once `landBranch` can veto; the veto-bypass call site added in 02 is what 03 makes require a reason class. Grep `validator-override` hits both.
- **02 → 04**: leaf 04 emits the `validation` object the gate in 02 produces; if 02 doesn't populate `rec.dto.validation`, 04 has nothing to serialize. Grep `dto.validation` hits both.
- **05 → 06**: leaf 06's Observer check calls `evaluateCompliance` from 05; grep `evaluateCompliance` resolves in observer wiring.
- **02 → 07**: 07 composes N skeptics around the single-judge gate 02 installs; it replaces the judge call, so 02 must exist first.
