# Outcome-driven model default (boost-only, floored)

STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/smart-spawn.ts, src/model-outcomes.ts, tests/smart-spawn.test.ts

## Goal

Let the spawn-time model *default* shift toward the model with the better landed-rate for a task's
complexity tier — boost-only, floored so a cold model is never starved, gated behind a flag, and never
overriding an explicit model the planner already chose. This is the reconciliation of "data-driven model
choice" with the substrate's cut of capability-match routing: it biases a default from *outcome
statistics*, it is not a classifier and never a land gate.

## Approach

**Consume concern 06's reader inside `planSpawn` (`src/smart-spawn.ts:148`) via dependency injection:**
- `planSpawn` is a pure planner (currently referenced only by `tests/smart-spawn.test.ts` — dormant,
  like `buildTddVerifyWorkflow`; see DESIGN.md). Keep it pure/testable: add an optional injected reader
  to its opts, exactly as `routeIntake` injects `classify`:
  `opts: { cwd: string; candidates: string[]; outcomes?: (model: string, tier: string) => { landed: number; rejected: number } }`.
- After the existing plan is assembled (the block at `src/smart-spawn.ts:155-166` that sets
  `plan.model` only when `raw?.model` is defined), apply the shift:
  1. **Never override an explicit choice:** if `plan.model` is already set (LLM returned one), return
     unchanged.
  2. Gate on `process.env.OMP_SQUAD_MODEL_OUTCOMES === "1"` (default off) AND `opts.outcomes` provided;
     else return unchanged.
  3. Compute the tier from the plan's resolved thinking with `tierOf(asThinking(raw?.thinking))`
     (import `tierOf` from `src/model-outcomes.ts` — reuse it, do not re-bucket independently).
  4. For each candidate model in a small fixed set (`["opus", "default"]` — the two the current
     heuristic picks between), read `opts.outcomes(model, tier)`. **Exploration floor:** skip any
     candidate with `landed + rejected < MIN_SAMPLES` (=8).
  5. Pick the eligible candidate with the highest landed-rate. Set `plan.model` to it **only if** its
     landed-rate exceeds the incumbent default's rate by ≥ `MIN_EDGE` (=0.15). Otherwise leave
     `plan.model` unset (current behaviour).
- Add a one-line `reason` suffix when the shift fires (e.g. `+ model shifted to opus (0.82 land-rate,
  heavy tier)`) so the choice is surfaced in the UI's existing `SpawnPlan.reason`.

Export `MIN_SAMPLES` and `MIN_EDGE` as named constants at the top of the shift so the thresholds are
one-line tunable.

## Scope boundary

- Do NOT override an LLM-supplied `model`, and do NOT down-rank or exclude a model below baseline — this
  is additive boost only.
- Do NOT wire `planSpawn` into the live `create()` spawn path — that is a separate concern (planSpawn is
  dormant; this concern makes it outcome-aware and unit-test-verifies it).
- Do NOT change `SYSTEM_PROMPT`'s "opus for hard" wording, `pickRepoHeuristic`, or any repo/approval/
  thinking logic.
- Do NOT read/write `model-outcomes.json` directly here — consume only the injected `outcomes` reader.

## Verify

- `bun test tests/smart-spawn.test.ts` — with `OMP_SQUAD_MODEL_OUTCOMES=1` and an injected `outcomes`
  that gives `opus` a ≥0.15 higher landed-rate over ≥8 samples in the `"heavy"` tier, `planSpawn` on a
  `thinking:"high"` task returns `plan.model === "opus"`; with only <8 samples the default is unchanged
  (no shift); with the flag off the default is unchanged; an explicit LLM `model` is never overridden;
  a shift adds a `reason` suffix.
- `bun run check`
- Manual: unit test is authoritative (planSpawn has no live caller); confirm `bun test tests/smart-spawn.test.ts`
  passes with the flag both on and off.
