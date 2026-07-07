# Thread author lineage into the validator
STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts, src/convergence-run.ts

## Goal
The validator learns who authored the change, at both judge sites.

## Approach
- `src/squad-manager.ts` `runValidatorGate(opts)`: the unit record `rec = this.agents.get(opts.agentId)` is already fetched. Read `rec?.dto.model` and `rec?.dto.harness` and pass them into the `validatorGate({ ... })` call as `authorModel`/`authorHarness`. (The poll loop backfills `rec.dto.model` = `provider/id` — see applyState ~:5784 — so this is the real vendor-prefixed model on the common omp/pi path.) Order matters: `rec` is fetched AFTER the gate call today — move the fetch above the `validatorGate(...)` call, or read the model from `this.agents.get(opts.agentId)` inline before the call. Keep the existing `rec.dto.validation = record` stamp.
- `src/convergence-run.ts` (~:287, `realValidate` calling `scoreAgainstCriteria`): it operates on a plan dir, not an agent DTO, so there is no author model — pass `authorModel: undefined`. This keeps the labeling consistent (honest `unknown` there) with zero behavior change.

## Cross-Repo Side Effects
None.

## Verify
`bun test` (squad-manager land + validator suites). Add/extend a squad-manager test: a landed unit whose `dto.model` is `anthropic/claude-sonnet-4-5` produces `validation.sameLineage === true` (reviewer opus). `bunx tsc --noEmit` clean. Live drive (audit phase): spawn one omp unit, let it poll, land it, inspect the emitted `validation` record carries `authorLineage`.
