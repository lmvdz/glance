# Validator core — scoreAgainstCriteria + schema + independent judge
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/validator.ts, tests/validator.test.ts, src/omp-call.ts, src/proof.ts, src/types.ts

## Goal (what is built)

A new pure module `src/validator.ts` exporting `scoreAgainstCriteria(criteria, diff, proof, judge?)`
that returns a `ValidationRecord` (see DESIGN §5): a verdict plus per-criterion satisfaction, an
agreement fraction, the judge's own confidence, and a short rationale. The judge is an **injected**
producer so the module unit-tests headless; the default judge runs a one-shot `omp -p` with an
independent model lineage. No land path is touched in this leaf — this is the scorer + its schema +
fixture tests only.

## Approach (how — cite real file:symbol attach points)

- Reuse the one-shot LLM primitive `decideTyped` / `ompOneShot` / `extractJsonObject`
  (`src/omp-call.ts:16,35,53`) — do NOT hand-roll a spawn. The default judge builds a prompt from
  `criteria` (the `FeatureCriterion[]` texts) + `diff` + the proof tail, and calls
  `decideTyped({ args: ["-p","--model", model, "--system-prompt", SYS, user], parse, fallback })`.
  `model` = `process.env.OMP_SQUAD_VALIDATOR_MODEL ?? "opus"` (independent of the sonnet executor;
  `--model` is a real omp flag, see `src/rpc-agent.ts:140`).
- Type `Judge = (input: { criteria: FeatureCriterion[]; diff: string; proof?: Proof }) => Promise<RawVerdict | undefined>`.
  Import `FeatureCriterion` from `./types.ts` (`src/types.ts:306`) and `Proof` from `./proof.ts`
  (`src/proof.ts:24`).
- `scoreAgainstCriteria`:
  - empty `criteria` ⇒ `{ verdict:"skipped", agreement:1, confidence:0, perCriterion:[], rationale:"no declared criteria" }` (DESIGN §4).
  - call the judge; `undefined`/unparseable/empty ⇒ `{ verdict:"abstain", confidence:0, agreement:0, ... }` (fail-open, DESIGN §3).
  - else coerce the raw judge JSON into `perCriterion` (one entry per input criterion id, defaulting
    unmentioned ones to `satisfied:false`), compute `agreement = satisfied/total`, and set
    `verdict = "veto"` iff any criterion is unsatisfied, else `"pass"`. Never throw.
- Add the `ValidationRecord` interface to `src/types.ts` exactly as frozen in DESIGN §5 (leaf 04 also
  needs it; define it here so 01 can return it, and 04 wires it onto `AgentDTO`/`RunReceipt`).
- `tests/validator.test.ts`: pass a **fake judge** (no real omp). Fixtures:
  1. a diff that satisfies all criteria ⇒ `verdict:"pass"`, `agreement:1`;
  2. a diff that passes a weak self-authored test but misses one declared criterion (fake judge marks
     that criterion `satisfied:false`) ⇒ `verdict:"veto"`, `agreement < 1`;
  3. judge returns `undefined` ⇒ `verdict:"abstain"`;
  4. empty criteria ⇒ `verdict:"skipped"`.

## Scope boundary

Do NOT touch `src/land.ts`, `src/squad-manager.ts`, `src/server.ts`, or `src/workflow/verify-workflow.ts`
in this leaf. Do NOT add the `validation` field to `AgentDTO`/`RunReceipt` (that is leaf 04) — only add
the `ValidationRecord` interface. Do NOT implement caching or the N-skeptic ensemble (leaves 02/07).

## Verify (concrete command + expected observable outcome)

`bun test tests/validator.test.ts` — all four fixtures pass; specifically the "weak test but misses a
declared criterion" fixture asserts `result.verdict === "veto"`. `bunx tsc --noEmit` (or the repo's
typecheck) is clean.
