# Epic 3 — Independent validator + compliance
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/proof.ts, src/workflow/verify-workflow.ts, src/squad-manager.ts, src/server.ts, src/types.ts, src/validator.ts (new), src/compliance.ts (new)
SUBPLAN: plans/meta-autonomous-fleet/epic-3-independent-validator/

## Goal

A **separate** validator agent with veto power that scores a unit's output against its *declared* `acceptanceCriteria` — never the executor grading its own self-authored test. Plus a compliance agent that evaluates policy adherence over the existing append-only ledgers. This is the critical path: it's the oracle every other trust guarantee (confidence, propose-only, the convergence loop) depends on.

## Approach

There are four verification mechanisms today and **none is an independent semantic judge**: `proofGate` (`src/proof.ts:323`) vetoes on a deterministic exit code and is human-overridable ("or force"); `verifyAgentWork` re-runs the same command (self); `validateWorker` is mechanical; and `buildTddVerifyWorkflow` has the *same* agent author the test and implement against it. Nobody independent checks whether the self-authored test actually covers the declared criteria — the structural root of truth-lies.

Declared criteria already exist as data: `FeatureCriterion` / `defaultTaskProps.acceptanceCriteria` (`webapp/src/data.ts:16`). Insert an **independent validator node** between `verify` and `exit` in the verify-workflow (`src/workflow/verify-workflow.ts`), or at the `proofGate` boundary (`src/proof.ts:323`, called from `land.ts`), fed the declared criteria + the diff + the proof — running as a *different* agent lineage (fable/opus) that must pass before land. Unlike the deterministic gate, its veto is **not** part of the human-overridable "or force" path (or force requires an explicit, logged override with a distinct reason class).

**Compliance agent** attaches to `governancePayload` (`src/server.ts:1448`, today RBAC + capacity only) as a real policy evaluator reading `audit.ts` / `land-ledger.ts` / `dispatch-ledger.ts`, and into the `Observer.collect` audit-check array as an additional finding source. `grep veto|compliance` returns zero hits today — all net-new.

## Decomposition seed (candidate leaves for the sub-plan)

- New `src/validator.ts`: `scoreAgainstCriteria(criteria, diff, proof) → {verdict, perCriterion, confidence, rationale}` with a schema; independent agent lineage; unit-tested on pass/fail fixtures.
- Validator node wired into the verify-workflow between `verify` and `exit`, gating `exit` on verdict.
- Non-overridable veto path at `proofGate`: separate the validator veto from the deterministic "or force" override; force requires a logged `override` reason class.
- Emit the validator's per-run agreement/confidence signal onto the run record (this is Epic 5's confidence input — coordinate the field).
- New `src/compliance.ts`: policy evaluator over the ledgers; surface findings in `governancePayload` + Observer.
- Adversarial refute-before-land: N independent skeptics per land, majority-refute kills (compose with the validator).

## Verify

Feed the validator a diff that passes a weak self-authored test but misses a declared criterion; confirm it vetoes and blocks land. Confirm a human `force` still works but is logged with a distinct override reason. Confirm `governancePayload` surfaces a real policy finding (e.g. a land without fresh proof) rather than only RBAC state.
