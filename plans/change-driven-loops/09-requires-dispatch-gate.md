# Wire requires into the dispatch admission gate

STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/dispatch.ts
PLANE: OMPSQ-347 — https://app.plane.so/inkwell-finance/browse/OMPSQ-347/

## Goal
Make the scope contract *mean something for ordering*, not just decorate spawns. Today
the dispatcher defers an issue only on its Plane `blockedBy` issue-ids (`dispatch.ts:146`),
which is decoupled from `owns`/`requires`/`produces` (red team B-S3 — "enforced by
nothing"). Teach dispatch to also defer a unit whose `requires` are not yet satisfied by
a landed or in-flight `produces`. This is the wiring that turns #3 from cosmetic into a
real admission gate.

## Approach
1. **Resolve `requires` against the produce-set at dispatch time.** In the dispatch tick
   (`src/dispatch.ts:128-153`), alongside the existing `blockedBy` open-issue check, add
   a scope-resolution step for issues/units that carry a `requires` contract:
   ```ts
   const requires = unit.requires ?? [];
   const unmet = requires.filter(r =>
     !existsInMain(repo, r) &&                         // not already landed
     !liveProduces(repo).some(p => isWithinAny(r, [p])) // not declared-produced by a live/queued unit
   );
   if (unmet.length) { defer(unit, `requires unmet: ${unmet.join(", ")}`); continue; }
   ```
   - `existsInMain` — cheap path check in the main checkout (a required prefix that
     already exists on disk is satisfied).
   - `liveProduces` — union of `produces` declared by currently live/queued agents in
     the repo (from the same DTO list the manager exposes). If some live unit will
     produce the required path, defer until it lands (don't dispatch into a read-before-
     write hazard).
   - Reuse the existing `defer`/`blockedLogged` machinery (`:148-151`) so a deferred unit
     is reconsidered each tick and dispatches once its requirement lands — no synthetic
     Plane blocker injected.

2. **Deadlock guard (red team follow-up to A-S5 cycle risk).** Two units that require
   each other's produces would defer forever. Before deferring, run the cycle check from
   concern 05's `validatePlanGraph` over the requires/produces graph of live+queued
   units; if a requires-cycle is detected, do NOT defer both — dispatch the
   higher-priority one and file a low-sev finding naming the cycle, so the fleet makes
   progress instead of wedging.

3. **Only enforce operator-declared OR landed-satisfiable requires.** Inferred
   (`scopeSource:"inferred"`) requires that cannot be resolved should warn, not
   hard-defer, to avoid an LLM hallucination stalling real work — mirror concern 08's
   asymmetric-trust rule.

## Cross-Repo Side Effects
Depends on concern 07 (`requires`/`produces`/`scopeSource`) and reuses concern 05's
cycle detection. Touches `src/dispatch.ts`, which concern 03 also touches — land after
03 (overview ordering). Note the existing cross-project-blocker gap the dispatcher
already flags (`dispatch.ts:127`) is out of scope here.

## Verify
- `bun run typecheck` clean; `bun test` green.
- Queue unit B (`requires:["src/api/types.ts"]`) while unit A (`produces:["src/api"]`)
  is live → B is deferred with reason "requires unmet"; once A lands, B dispatches on a
  later tick.
- A landed/existing required path → no deferral.
- Construct a requires-cycle between two queued units → neither wedges; the
  higher-priority one dispatches and a cycle finding is filed.
