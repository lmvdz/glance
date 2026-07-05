# `omp-squad plan-decompose <dir>` one-shot CLI + end-to-end verify

STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/index.ts

## Goal (what is built)

A one-shot CLI `omp-squad plan-decompose <plan-dir> [--json]` that runs a single
decompose→write→validate cycle against a `plans/<name>/OBJECTIVE.md`, without the
daemon loop. This is the manual dogfood path AND the deterministic end-to-end
harness for the epic's top-level Verify ("hand the loop a fixture objective").

Behaviour: read `<plan-dir>/OBJECTIVE.md`; parse existing concerns
(`parsePlanConcerns`); build the verified set from local terminal STATUS (no
DoneProof ledger available off-daemon, so STATUS-terminal only); call `decompose`
with the real `ompClassify()`; on a non-empty draft set call `writeConcernDrafts`;
print a summary (concerns written, or the `PlanGraphIssue[]` on gate failure).
Exit 0 on a clean write, exit 1 on gate failure or a missing `OBJECTIVE.md`.

## Approach (how — cite real file:symbol attach points)

- Model the command on `cmdPlanValidate` (index.ts:597–621): same `parseArgs`
  positional+`--json` shape, same "resolve abs path, pass repo='' + abs planDir"
  convention (index.ts:605–608), same `--json` vs human output split.
- Register it in the dispatch switch next to `case "plan-validate":`
  (index.ts:745) and add a help line next to index.ts:74.
- Import `decompose`/`ConcernDraft` from `./planner.ts`, `writeConcernDrafts` from
  `./plan-writer.ts`, `ompClassify` from `./intake.ts` (already used across the
  codebase), and reuse `parsePlanConcerns`/`validatePlanConcerns` already imported
  in index.ts (validatePlanConcerns at index.ts:41).
- The verified set off-daemon: `existing.filter(c => TERMINAL.has(c.status))` (the
  terminal set already defined in features.ts / plan-sync.ts) mapped to
  `VerifiedConcern`. Note in the command's help/comment that DoneProof-based
  verification only applies in the live daemon (leaf 03/04).

## Verify (concrete command + expected observable outcome)

- Hermetic: `bun run typecheck` passes.
- End-to-end (requires `omp` on PATH): create `plans/fixture/OBJECTIVE.md` with a
  small objective, then:
  1. `omp-squad plan-decompose plans/fixture` → prints "N concern(s) written";
     `plans/fixture/` now holds `NN-slug.md` docs + `00-overview.md`.
  2. `omp-squad plan-validate plans/fixture` → `✓ … dependency graph is clean`
     (exit 0) — proves the emitted tree passes the shared DAG gate.
  3. Re-run `omp-squad plan-decompose plans/fixture` → the tree updates in place,
     no duplicate `NN-` files appear (idempotent), and a concern whose STATUS was
     hand-set to `done` is preserved.

## Scope boundary (what NOT to touch)

CLI surface only. Do not modify `planner.ts`, `plan-writer.ts`, `resident-planner.ts`,
or `squad-manager.ts`. Do not add a daemon loop here (that is leaf 03/04). Do not
file to Plane. Keep the command offline-friendly except for the single injected
`omp` classify call.
