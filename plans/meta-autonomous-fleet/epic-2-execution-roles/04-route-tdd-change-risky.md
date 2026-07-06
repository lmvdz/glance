# Router emits mode:"tdd" for change-risky code tasks

STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/intake.ts, src/squad-manager.ts, tests/intake.test.ts

## Goal (what is built)

The intake router selects the testing-agent process for behavior-adding code changes: when it
routes a task to the `verify` process (a real code change with a detected verify command) and the
task looks behavior-adding and is not trivial, the decision carries `mode:"tdd"`, which leaf 03
turns into a `write-test → implement → verify` run. Env override: `OMP_SQUAD_TDD=0` never emits
tdd; `OMP_SQUAD_TDD=force` emits tdd on every verify-routed task; unset = the heuristic.

## Approach (how — cite real file:symbol attach points)

1. **src/intake.ts** — on `IntakeDecision` (intake.ts:17) add `mode?: "tdd";` with a doc comment
   ("selects the TDD variant of the verify loop — write the acceptance test first").

2. Add the signal regex near the existing ones (`HIGH_RISK`/`HARD`/`TRIVIAL` at intake.ts:31–34):
   ```ts
   const TDD_SIGNAL = /\b(add|implement|feature|support|endpoint|api|handler|route|behaviou?r|new )\b/i;
   ```
   And a small helper:
   ```ts
   function tddMode(task: string): "tdd" | undefined {
     const env = process.env.OMP_SQUAD_TDD;
     if (env === "0") return undefined;
     if (env === "force") return "tdd";
     return !TRIVIAL.test(task) && TDD_SIGNAL.test(task) ? "tdd" : undefined;
   }
   ```

3. Set it on BOTH verify-branch returns:
   - `heuristicRoute` (intake.ts:52) — the `if (verify) return { verify, thinking, reason: … }`
     at intake.ts:57 becomes `return { verify, thinking, mode: tddMode(task), reason: … }`. When
     tdd is chosen, append " (TDD: test first)" to the reason string so the log shows it.
   - `llmRoute` (intake.ts:69) — its `verify` branch (intake.ts:75–77) likewise adds
     `mode: tddMode(task)` on the `{ verify, … }` return.
   Leave the `plan`/`fanout`/`plain` returns untouched (mode stays undefined).

4. **src/squad-manager.ts** — thread the mode into options at the route-merge site. Today
   (squad-manager.ts:2738):
   ```ts
   opts = { ...opts, workflow: decision.workflow, verify: decision.verify, thinking: decision.thinking ?? opts.thinking };
   ```
   Add `verifyMode: decision.mode`. Also stamp the tester role for observability: when
   `decision.mode === "tdd"`, set `executionRole: "tester"` in the same spread (leaf 01 added the
   field; leaf 03 added `verifyMode`). This is the single place the router's decision becomes
   agent options.

## Scope boundary

- Do NOT change the risk/fanout/plain routing branches or `detectVerify`.
- Do NOT emit `mode:"observe"` from the router — observe is Observer-initiated (leaf 05) only.
- Do NOT make tdd a land gate or alter the gate command; it only prepends a write-test node.

## Verify (concrete command + expected observable outcome)

- `bun run check` passes.
- Extend **tests/intake.test.ts** (imports `routeIntake`/`detectVerify` at tests/intake.test.ts:10;
  it already exercises `routeIntake` against a temp repo with a verify command). Add cases:
  - a behavior-adding task in a repo with a detected verify command (e.g. "add a /health
    endpoint") → `decision.verify` set AND `decision.mode === "tdd"`.
  - a trivial task ("fix typo in README") → `decision.mode` is undefined (TRIVIAL wins).
  - `OMP_SQUAD_TDD=0` around a behavior-adding task → `decision.mode` undefined; `=force` around
    any verify-routed task → `mode === "tdd"` (remember to restore the env var).
- `bun test intake` is green. Observable end-to-end (manual, optional): dispatching "add a new
  endpoint" produces a run whose first node is `write-test` (a red test lands before any
  implementation), per leaf 03's mapping.
