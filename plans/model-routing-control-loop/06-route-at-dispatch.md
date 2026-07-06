# Route model at dispatch via enriched shiftedModel
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/smart-spawn.ts (SHIFT_CANDIDATES ~:36, shiftedModel ~:58, gate ~:229), src/squad-manager.ts (dispatch path createWithId ~:2996-3026, makeDriver ~:3190)
BLOCKED_BY: 05-matrix-and-surface
VERIFY_BLOCKER: `buildTaskClassMatrix` returns populated cells for ≥1 real (non-"unknown") model

## Goal
The control loop's **action arm**: turn the outcome evidence into cheaper routing. Teach the existing up-front router (`shiftedModel`) to key on `(task-class, difficulty)` from C05's matrix, and wire it onto the **dispatch** path — where it currently never runs. Cheap by default; escalate the starting model only for classes that historically fail cheap. Full coverage (including `RpcAgent` units), clean attribution (model known at create), no `getModel()` needed.

## Approach
1. **Enrich `shiftedModel`** (`src/smart-spawn.ts:58`). Today it shifts on `(currentModel, tier, outcomes)` with a binary `SHIFT_CANDIDATES = ["opus","default"]` (`:36`) and `MIN_SAMPLES`/`MIN_EDGE`/symmetric-floor guards (`:28-64`). Extend the key from `tier` to `(taskClass, tier)` reading C05's per-cell merge-rate: if the cheap/default model's merge-rate for this class is materially below the frontier candidate's (above the existing edge/sample floors), boost; else stay cheap. Keep the conservative guards — thin cells never trigger a shift.
2. **Wire onto dispatch.** In `createWithId`, right after `routeIntake` resolves (`:2996-3008`) and before `makeDriver` (`:3190`), call the enriched router with the just-computed `taskClass` and set `opts.model` explicitly to the chosen model. This both (a) applies the routing and (b) **guarantees a real model value** on routed units — the C01 fallback for harnesses (ACP/codex) that don't emit an effective model.
3. **Gate + shadow-first.** Behind `OMP_SQUAD_MODEL_OUTCOMES=1` (the existing gate, `:229`). Ship shadow-first: log the decision it *would* make (routed model vs default) without applying, verify the choices look sane against the panel, then flip to applying. Emit the decision so it's auditable.
4. **Attribution stays clean.** Because the model is set at create, `recordModelOutcome`/the C03 row record the real chosen model — no mid-run ambiguity. This closes the observe→act loop: routed outcomes feed back into the same matrix.

**Explicitly NOT in scope:** epsilon-random exploration (D1) — without it the router may only *conservatively boost* on existing evidence, never *regenerate* policy from its own closed loop. Keep the boost-only, sample-gated behavior; document that self-optimization needs D1.

## Cross-Repo Side Effects
None outside omp-squad. Changes default dispatch routing **only when the env gate is on**; off by default, so nothing moves until deliberately enabled and shadow-verified.

## Verify
- With the gate off: dispatch units, confirm routing is unchanged (default model).
- With the gate on, shadow mode: dispatch units across ≥2 task-classes with seeded matrix data; confirm the logged "would route" decision matches the panel (boost the class where cheap underperforms, stay cheap elsewhere).
- Flip to applying: confirm a routed unit's receipt/row shows the chosen model and feeds back into C05's matrix.
- Confirm a thin/no-data class falls through to default (no shift on insufficient samples).
- `/verify`: drive a real dispatch through the daemon end-to-end, not just a unit test.
