# Validator land-gate — non-overridable veto at the landBranch seam
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/validator.ts, src/squad-manager.ts, src/land.ts, src/types.ts

## Goal (what is built)

Wire the validator into the land path so a real `veto` blocks the merge — on both the normal and the
forced (`requireProof:false`) paths — and stamps a `validation` record onto the agent. The veto is
**not** on the "or force" override; only an explicit `validator-override` (leaf 03) can bypass it. A
`skipped`/`pass`/`abstain` verdict allows the land. Results are cached by proof fingerprint so the
judge fires once per (commit,tree), not per land retry.

## Approach (how — cite real file:symbol attach points)

- Add `validatorGate(opts)` to `src/validator.ts`: given `{ criteria, repo, worktree, branch, proof }`,
  compute the diff with a hardened git call (`git diff <baseCommit>...HEAD` in the worktree — reuse the
  `GIT_HARDEN_ARGS`/`GIT_HARDEN_ENV` pattern from `src/proof.ts:70`), call `scoreAgainstCriteria`
  (leaf 01), and return `{ record: ValidationRecord; veto?: string }` where `veto` is a human-readable
  reason ONLY when `record.verdict === "veto"`. Cache keyed by `${proof.commit}:${proof.tree}` in a
  module-level `Map` (mirrors `proofRoot` module state in proof.ts) so repeated land attempts on the
  same tree reuse the verdict.
- Attach in `SquadManager.landBranch` (`src/squad-manager.ts:2381`) — the mode-dispatch seam every land
  funnels through (DESIGN §1). BEFORE it calls `landAgent(opts)` (`:2394`):
  1. resolve criteria: `const pf = opts.featureId ? this.featureStore.get(opts.featureId) : undefined;`
     `const criteria = pf?.acceptanceCriteria ?? []`. Thread `featureId` into `LandOpts` at the two
     build sites (`land()` at `src/squad-manager.ts:2155`, `landFeature()` at `:2070`) — the DTO already
     carries `featureId` (`src/types.ts:562`).
  2. load the proof: `await proofFor(opts.repo, opts.worktree)` (already imported, `src/proof.ts:101`).
  3. call `validatorGate`; on `veto`, unless `opts.validatorOverride` is set (leaf 03 supplies it),
     return `{ ok:false, committed:false, merged:false, message: opts.message, detail: veto }` — same
     shape `landAgent` uses (`src/land.ts:356`). Run this **regardless of `opts.requireProof`** so a
     forced land is still validated.
  4. always stamp `rec.dto.validation = record` on the agent record and `emitAgent(rec)` (leaf 04
     serializes it; add the assignment here so the field is populated at the veto/pass moment).
- Add `criteria?`/`featureId?` and `validatorOverride?` fields to `LandOpts` (`src/land.ts:86`) so the
  types line up even though the gate itself lives in squad-manager (land.ts stays criteria-agnostic).
- Env kill-switch: `OMP_SQUAD_VALIDATOR=0` disables the gate entirely (verdict `skipped`), mirroring
  `OMP_SQUAD_STALE_GATE`/`staleGateEnabled()` in `src/land.ts` — so the fleet can be run with the
  validator off during rollout.

## Scope boundary

Do NOT modify `scoreAgainstCriteria` (leaf 01). Do NOT add the override reason-class ledger record —
this leaf only reads `opts.validatorOverride` as a boolean-ish gate; the logged reason class is leaf 03.
Do NOT add the `validation` field to `AgentDTO`/`RunReceipt` type (leaf 04); just assign `rec.dto.validation`
(cast if needed) so runtime works — 04 makes the type real. Do NOT gate the PR-mode path in
`src/land-pr.ts` beyond what routing through `landBranch` already covers.

## Verify (concrete command + expected observable outcome)

Add `tests/validator-land-gate.test.ts` (or extend an existing squad-manager land test): construct a
`landBranch`/`validatorGate` call with a fixture feature whose criteria include one the diff misses and
a fake judge that vetoes it; assert the land returns `{ ok:false }` with the veto reason in `detail`,
AND that a forced call (`requireProof:false`, no `validatorOverride`) is **also** blocked. Assert a
call with `OMP_SQUAD_VALIDATOR=0` lands. Run: `bun test tests/validator-land-gate.test.ts`.
