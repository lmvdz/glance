# Epic 3 design decisions (resolved — leaves inherit these, do not re-litigate)

## 1. Attach point: the land boundary, NOT a verify-workflow node

The parent epic offered two attach points ("insert a validator node between `verify` and `exit`
in the verify-workflow, OR at the `proofGate` boundary"). **Decision: the land boundary.** The
single choke point every land funnels through is `SquadManager.landBranch` (src/squad-manager.ts:2381),
the mode-dispatch seam that routes to `landAgent` (local merge) or the PR path. Gating there:
- catches **forced** lands (`land(id,{force:true})` → `requireProof:false`), which bypass the
  workflow entirely but must still be validated — the whole point of a non-overridable veto;
- gates both the local-merge and PR "worlds" in one place;
- runs after the cheap deterministic `proofGate`, so the LLM judge only fires on units that
  already passed the exit-code gate (cost control, DESIGN risk row).

The verify-workflow-node variant is **explicitly rejected** to avoid double-gating and to keep the
veto reachable on the force path. Do not add a validator node to `verify-workflow.ts`.

## 2. The judge is an injected producer; default is an independent `omp -p` lineage

`scoreAgainstCriteria(criteria, diff, proof, judge?)` takes an injected `judge` so the core unit-tests
headless on fixtures (mirrors `observer.ts` injected `ObserverDeps` and `vision.ts` injected
`VisionProducer`). The default judge is a one-shot `decideTyped`/`ompOneShot` call (src/omp-call.ts)
with `--model ${OMP_SQUAD_VALIDATOR_MODEL ?? "opus"}` — a **different lineage** from the executor
(which defaults to sonnet). Independence is by model + by process (fresh one-shot, no shared session).

## 3. Fail-open on judge unavailability, fail-closed on a real veto

If the judge is unreachable (no `omp` on PATH, timeout, unparseable output), `scoreAgainstCriteria`
returns `{verdict:"abstain", confidence:0}` — the gate then **allows** the land (fail-open) but stamps
`validation.verdict="abstain"` so the run record shows the judge did not run. Rationale: a missing
`omp` binary must never brick every land in the fleet. A judge that ran and returned `veto` **blocks**
(fail-closed). Only an explicit `validator-override` (leaf 03) bypasses a real veto.

## 4. Criteria come from the unit's declared feature; empty criteria ⇒ skip

Criteria are `PersistedFeature.acceptanceCriteria` (`FeatureCriterion[]`, src/types.ts:738), looked up
via `agent.featureId` (src/types.ts:562) → `this.featureStore.get(featureId)`. **If a unit has no
declared criteria, the validator is skipped** (verdict `"skipped"`, allow) — it scores *declared*
criteria, and inventing them would reintroduce the self-grading it exists to prevent. This is a real
coverage gap the compliance evaluator (leaf 05) reports ("landed with zero declared criteria"), not
something the validator papers over.

## 5. Field coordination with Epic 5

Epic 5 computes a run's aggregate `confidence` at the `buildDigest` seam (src/squad-manager.ts:4375)
from **validator agreement**, coverage, and impact (see `plans/meta-autonomous-fleet/05-hitl-safeguards.md`).
Epic 3 owns and populates a **separate** `validation` object on `AgentDTO` and `RunReceipt`; Epic 5
reads `validation.agreement`. Do **not** compute or name the aggregate `confidence` field here — that
is Epic 5's. The contract between them is the `validation` shape frozen in leaf 04.

```ts
// src/types.ts — added by leaf 04, populated by leaf 02
export interface ValidationRecord {
  verdict: "pass" | "veto" | "abstain" | "skipped";
  agreement: number;        // 0..1 fraction of declared criteria the judge marked satisfied
  confidence: number;       // 0..1 the judge's own confidence
  perCriterion: { id: string; satisfied: boolean; note?: string }[];
  rationale: string;        // short; truncate to ~600 chars
  model?: string;           // the judge lineage that ran
  ranAt: number;
}
```

## 6. Override reason class (leaf 03)

A proof-force is logged today via `recordForcedLand` (src/land-ledger.ts:112) into `land-forced.json`.
A **validator-override** is a strictly stronger act (bypassing a semantic veto, not a stale exit-code)
and gets its **own** record type `ValidatorOverride` in `land-validator-verride.json` via a new
`recordValidatorOverride(stateDir, branch, actor, reasonClass, detail)`. `reasonClass` is a required
non-empty enum-ish string (`"criteria-wrong" | "judge-hallucination" | "emergency"`); an empty reason
class refuses the override (the veto stands). Never reuse the proof-force record — the two override
classes must be separately auditable by the compliance evaluator.
