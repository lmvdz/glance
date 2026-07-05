# Run entrypoint + Stop-hook settings + flag

STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/convergence-run.ts (new), .claude/settings.json (new), src/runtime-settings.ts

## Goal (what is built)

The thing an operator actually runs to start a convergence loop, plus the Stop-hook registration
and the arm flag. The entrypoint builds the real `ConvergenceDeps`, arms the sentinel at start,
disarms on any terminal outcome or crash, and hands off to the Stop-hook driver for the warm
auto-continue. Ships with a fixture adapter so the whole thing runs end-to-end before Epics 1/3
land.

## Approach (how — cite real file:symbol attach points)

- New `src/convergence-run.ts` (`import.meta.main` entrypoint, run via `bun src/convergence-run.ts
  --goal <id>`):
  - Build `ConvergenceDeps` (from leaf 02's interface): inject `ratchet` from
    `src/convergence-ratchet.ts` (leaf 03) and `writeOracle` from `src/convergence-oracle.ts`
    (leaf 01). Read `epsilon`/`budgetCap`/`confidenceFloor` from env with documented defaults.
  - **Planner/validator adapters** (`DESIGN.md §2`): `plan` calls `src/planner.ts` (Epic 1),
    `validate` calls `src/validator.ts` (Epic 3). Guard each with a dynamic `import` in a
    try/catch that `throw`s a clear `"Epic 1 (src/planner.ts) not landed — run with --fixture"`
    if the module is absent. Provide a `--fixture` flag that swaps in a deterministic fake planner
    + validator over a tiny bundled meta-goal (a 3-criterion spec whose gap closes in N cycles) so
    the acceptance test runs today.
  - Lifecycle: `arm()` (leaf 01) before the first iteration; run `runToConvergence` (leaf 02, which
    calls `runIteration` + `writeOracle` per cycle); `disarm()` in a `finally` so a crash never
    leaves the sentinel armed.
  - Set `process.env.OMP_SQUAD_LOOP_ARMED = "1"` for the child turns (belt with the sentinel).
- Register the flag in `src/runtime-settings.ts`: add `"OMP_SQUAD_LOOP_ARMED"` to the
  `FeatureFlagKey` union (`src/runtime-settings.ts:10-19`) and a `FEATURE_FLAGS` entry
  (`src/runtime-settings.ts:52` neighborhood): `{ key: "OMP_SQUAD_LOOP_ARMED", label: "Convergence
  loop", description: "Arm the Stop-hook auto-continuation for a convergence run.", defaultEnabled:
  false }`.
- New `.claude/settings.json` (project-scoped, committed — there is none today, only
  `settings.local.json`). Add a `Stop` hook pointing at the leaf-04 script:
  ```json
  { "hooks": { "Stop": [ { "hooks": [ { "type": "command",
      "command": "bash \"$CLAUDE_PROJECT_DIR/scripts/continue-loop.sh\"" } ] } ] } }
  ```
  Do NOT put this in the user's global `~/.claude/settings.json` — a global Stop hook would make
  every unrelated Claude session immortal (the arm gate mitigates, but project scope is the belt).

## Scope boundary

Do NOT re-implement the oracle, ratchet, state machine, or hook (import/reference leaves 01-04).
Do NOT edit `settings.local.json` (leave the existing permissions block untouched — add a *new*
`settings.json`). Do NOT wire the real planner/validator logic beyond the thin adapter import +
throw (Epics 1/3 own those modules). Do NOT implement session handoff (leaf 06).

## Verify

```
bun src/convergence-run.ts --goal demo --fixture
```
Expected observable outcome: the run drives the fixture meta-goal to `decision === "converged"`
without human re-prompting, writing an incrementing `<stateDir>/convergence/oracle.json` each cycle
(inspect: `jq . "$OMP_SQUAD_STATE_DIR/convergence/oracle.json"` shows `gap 0`, `decision
"converged"`), and the arm sentinel is ABSENT after exit (`test ! -f
"$OMP_SQUAD_STATE_DIR/convergence/armed"`). Then confirm the hook is wired: `jq '.hooks.Stop'
.claude/settings.json` prints the command entry, and with the fixture oracle mid-run
(`decision:"continue"`, armed) `echo '{"stop_hook_active":false}' | bash scripts/continue-loop.sh`
emits a block decision (leaf 04's contract, now reachable via settings). Also `bun run typecheck`
clean and `grep -q OMP_SQUAD_LOOP_ARMED src/runtime-settings.ts`.
