# VerifySpec.mode + 3-way driver selection

STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/types.ts, src/squad-manager.ts, tests/workflow.test.ts

## Goal (what is built)

A single discriminator `mode` on the synthesized verify loop that selects which builder runs:
`"verify"` (default, today's behavior) → `buildVerifyWorkflow`, `"tdd"` → `buildTddVerifyWorkflow`
(write test first), `"observe"` → `buildObserveWorkflow` (leaf 02). The mode is carried on
`CreateAgentOptions` (`verifyMode`), persisted into `WorkflowMemberConfig.verify.mode`, and
consumed at the ONE driver-construction site plus its fork-resume mirror. After this leaf, a
create() with `verify:"<cmd>", verifyMode:"tdd"` runs the TDD graph; `verifyMode:"observe"` runs
the observe graph.

## Approach (how — cite real file:symbol attach points)

1. **src/types.ts** — on `VerifySpec` (types.ts:843, currently `command` + `maxFixups`) add:
   ```ts
   /** Which synthesized loop to build. Default "verify". */
   mode?: "verify" | "tdd" | "observe";
   ```
   On `CreateAgentOptions` (types.ts:745, next to `verify?: string` at types.ts:773) add:
   ```ts
   /** Selects the synthesized loop variant for `verify` (tester/observer roles). Default "verify". */
   verifyMode?: "verify" | "tdd" | "observe";
   ```

2. **src/squad-manager.ts** — import the two extra builders. The import today is
   `import { buildVerifyWorkflow } from "./workflow/verify-workflow.ts";` (squad-manager.ts:34);
   extend it to also import `buildTddVerifyWorkflow` and `buildObserveWorkflow`.

3. **Persist the mode.** The `PersistedAgent.workflow` literal at squad-manager.ts:2806 today is:
   ```ts
   workflow: opts.workflow ? { path: opts.workflow } : opts.verify ? { verify: { command: opts.verify } } : undefined,
   ```
   Change the verify branch to `{ verify: { command: opts.verify, mode: opts.verifyMode } }`.

4. **Select the builder in `makeDriver`** (squad-manager.ts:2925), currently:
   ```ts
   const workflow = p.workflow.verify ? buildVerifyWorkflow(p.workflow.verify) : undefined;
   ```
   Replace with a switch on `p.workflow.verify.mode` (a small local helper is fine):
   `"tdd" → buildTddVerifyWorkflow`, `"observe" → buildObserveWorkflow`, else (incl. undefined) →
   `buildVerifyWorkflow`. Keep `p.workflow.verify ? … : undefined` guarding the whole thing.

5. **Mirror the fork-resume re-parse** (squad-manager.ts:3596–3600), currently:
   ```ts
   const wf: Workflow | undefined = rec.options.workflow?.verify
       ? buildVerifyWorkflow(rec.options.workflow.verify)
       : rec.options.workflow?.path ? parseWorkflow(...) : undefined;
   ```
   Use the SAME mode switch on `rec.options.workflow.verify` so a forked TDD/observe run rebuilds
   the right graph (the visit-reset walk below it only needs `goalGate`/`retryTarget`, which the
   verify/tdd graphs have and the observe graph deliberately lacks — the walk already no-ops when
   there is no goalGate, so observe forks are safe). Also thread `verifyMode` through the fork's
   `createInternal` call: it passes `verify: rec.options.workflow?.verify?.command` at
   squad-manager.ts:3658 — add `verifyMode: rec.options.workflow?.verify?.mode` beside it.

Extract the mode→builder mapping into one tiny module-level helper
(`function buildVerifyLoop(spec: VerifySpec): Workflow`) so makeDriver and the fork path call the
identical expression and can never drift.

## Scope boundary

- Do NOT set `verifyMode` anywhere yet (router does that in leaf 04; Observer in leaf 05). This
  leaf only makes the field exist and drive builder selection; default path is byte-for-byte
  today's `buildVerifyWorkflow`.
- Do NOT change `detectVerify`, the fixup/escalate cascade, `proofGate`, or land logic.
- Do NOT add per-mode UI.

## Verify (concrete command + expected observable outcome)

- `bun run check` passes.
- Extend **tests/workflow.test.ts** (or a manager-level driver test) to assert the mapping: build a
  `PersistedAgent` (or call the extracted `buildVerifyLoop`) with `mode:"tdd"` and assert the
  resulting workflow has a `write-test` node; with `mode:"observe"` assert it has a `reproduce`
  node; with `mode` undefined assert it equals the plain verify graph (no `write-test`, no
  `reproduce`). `bun test workflow` is green.
- Regression guard: `bun test` overall stays green — the default (`mode` unset) path is unchanged,
  so no existing verify/fork test breaks.
