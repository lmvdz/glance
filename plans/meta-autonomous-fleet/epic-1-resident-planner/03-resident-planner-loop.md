# ResidentPlanner loop class (Opportunity-shaped)

STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/resident-planner.ts, src/resident-planner.test.ts

## Goal (what is built)

A new `src/resident-planner.ts` exporting a `ResidentPlanner` class — the standing
loop that ties leaf 01 (decompose) and leaf 02 (writer) together, gated by
`OMP_SQUAD_RESIDENT_PLANNER` (default OFF). Structurally a sibling of `Opportunity`
(opportunity.ts:108): `start(intervalMs?)`, `stop()`, `tick()`, a JSON state file in
`stateDir`, and an `AutomationRecorder` heartbeat every tick.

Per tick:
1. Enumerate planner-owned objectives: `plans/<name>/` dirs containing an
   `OBJECTIVE.md`. Process **one** per tick (WIP discipline).
2. Build the verified set: for each existing concern (`parsePlanConcerns`), mark it
   verified-done iff `hasProof(stateDir, concern.planeId)` OR its STATUS is terminal.
3. Compute `hash(objective text + sorted verified-concern ids)`. If unchanged from
   the value stored in the state file for this plan dir → **skip** (no LLM, no
   write): a no-op tick. This is what makes a second tick idempotent and a
   verified-done event trigger exactly one re-plan.
4. Else call `decompose({ objective, verified, existing, classify })`; if it returns
   a non-empty draft set, call `writeConcernDrafts(repo, planDir, drafts)`. On
   `ok=true` store the new hash + emit the features-changed signal via an injected
   callback; on `ok=false` log the `PlanGraphIssue[]` and store nothing (retry next
   change).

Deps are injected (like `Opportunity`/`Scout`): `{ repo, stateDir, classify,
hasProof, onChanged?, now?, log?, record?, seenFile? }`.

## Approach (how — cite real file:symbol attach points)

- Copy the `Opportunity` class scaffold (opportunity.ts:108–200): the `timer`
  guard + `this.timer.unref?.()` in `start`, the `running` re-entrancy guard and
  `try/finally` heartbeat in `tick`, `loadSeen`/`saveSeen` JSON persistence keyed
  in `stateDir`, and the env-gate helper. Default interval 300_000ms (match
  plan-sync's slow cadence, squad-manager.ts:740, not Opportunity's 60s — planning
  is expensive and slow-moving). `residentPlannerEnabled()` reads
  `process.env.OMP_SQUAD_RESIDENT_PLANNER === "1"` (opt-IN, inverse of the others).
- `classify` is the injected LLM fn — the real one is `ompClassify(bin)`
  (intake.ts:92), wired in leaf 04; the test injects a stub returning canned JSON.
- `hasProof` is injected as `(planeId: string) => boolean`; leaf 04 wires
  `(id) => hasProof(this.stateDir, id)` from done-proof.ts:88 — the identical
  injection plan-sync already uses (squad-manager.ts:746).
- State file `resident-planner.json`: `Record<planDir, { hash: string; plannedAt:
  number }>`. Mirror `Opportunity`'s `loadSeen`/`saveSeen` (opportunity.ts:183–199)
  exactly (best-effort, corrupt→{}).
- `record` emits one report per tick: `found` = objectives scanned, `filed` =
  concerns written, `skipReason: "idle"` when no objective, `"already-handled"`
  when hash unchanged — matching `Opportunity`'s `AutomationRecorder` usage
  (opportunity.ts:172).

## Verify (concrete command + expected observable outcome)

`bun test src/resident-planner.test.ts` passes, using a `mkdtemp` repo with a
`plans/demo/OBJECTIVE.md`, an injected `classify` stub, and an injected `hasProof`,
with cases:
1. First `tick()` → `plans/demo/` gains a valid concern tree;
   `validatePlanConcerns(tmp, "plans/demo")` returns `[]`; `onChanged` fired once.
2. Second `tick()` with unchanged inputs → no new/changed files (hash-skip);
   `classify` stub NOT called again; heartbeat records `already-handled`.
3. Flip `hasProof` to return true for one concern's id, then `tick()` → `decompose`
   is called again and the verified concern is passed into the prompt as
   already-complete (assert via a spy on `classify`'s prompt argument); the
   re-emitted tree omits/collapses it.
4. With `OMP_SQUAD_RESIDENT_PLANNER` unset, `start()` installs no timer and
   `tick()` is a no-op.

## Scope boundary (what NOT to touch)

No changes to `squad-manager.ts` (leaf 04) or `index.ts` (leaf 05). Do not
re-implement decompose (import from `planner.ts`) or the writer (import from
`plan-writer.ts`). Do not file to Plane, dispatch agents, or write STATUS
transitions. Do not read/write `OBJECTIVE.md` except to read the objective text.
Do not call `omp` directly — `classify` is injected.
