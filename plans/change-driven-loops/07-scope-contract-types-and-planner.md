# Scope contracts: requires/produces types + planner emission

STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/ownership.ts, src/smart-spawn.ts, src/types.ts
PLANE: OMPSQ-345 — https://app.plane.so/inkwell-finance/browse/OMPSQ-345/

## Goal
Extend the agent-scope model from write-only `owns` to a declarative contract:
`requires` (read deps) and `produces` (write outputs). This is the type/plumbing
foundation for spawn-time validation (08) and the dispatch gate (09). Crucially,
contracts must be **operator-declarable**, not only LLM-inferred — the enforced path
must fire on the autonomous fleet, which an LLM that's told to "omit if unsure" won't
guarantee (red team A-S5).

## Approach
1. **Extend `Owner`** (`src/ownership.ts:54-59`) with `requires?: string[]` and
   `produces?: string[]` (repo-relative path prefixes, same shape as `owns`). Keep
   `owns` as the write-conflict basis. Add a helper
   `requiresConflict(live, repo, requires)` mirroring `ownershipConflict(:62-70)`:
   returns the live agent whose `owns`/`produces` overlaps the new agent's `requires`
   (a read-after-write hazard). Distinct from `ownershipConflict` (write-write).

2. **Extend `CreateAgentOptions` and the agent DTO** (`src/types.ts`) with
   `requires?: string[]` and `produces?: string[]` so they flow from spawn → DTO →
   `Owner` (the DTO is what `ownershipConflict` reads via
   `[...this.agents.values()].map(r => r.dto)` at `squad-manager.ts:1906`). Default
   `produces` to `owns` when omitted (a unit's declared write scope is its produces).

3. **Planner emission** (`src/smart-spawn.ts`). Add `requires?`/`produces?` to `RawPlan`
   (`:24-33`) and extend `SYSTEM_PROMPT` (`:115-134`) with two keys, mirroring the
   existing `owns` description: *"requires" (paths this task READS but does not own —
   used to order it after the task producing them)* and *"produces" (paths this task
   creates/modifies as outputs — defaults to owns)*. `parsePlanJson` already ignores
   unknown keys, so a model that omits them degrades gracefully. **Mark planner-emitted
   contracts as advisory** (provenance flag, e.g. `scopeSource: "inferred" | "operator"`
   on the DTO) so 08/09 can treat operator-declared contracts as enforceable and
   LLM-inferred ones as warn-only — this is the A-S5 fix.

   Note: do NOT add a second LLM call; extend the existing `decideTyped --smol` schema
   (the 20s timeout already applies). Two extra optional fields won't materially change
   reliability; the provenance flag is what makes correctness not depend on the model.

## Cross-Repo Side Effects
Touches `src/types.ts`, which concern 01 also touches (different interfaces:
`AutomationEvent` vs `CreateAgentOptions`/DTO) — land after 01 to avoid a merge on the
same file. Foundation for concerns 08, 09, 10.

## Verify
- `bun run typecheck` clean; existing `ownership` tests pass.
- Unit test `requiresConflict`: new agent `requires:["src/api"]`, live agent
  `produces:["src/api/x.ts"]` → conflict returned; no overlap → undefined.
- Spawn via smart-spawn with a task that clearly reads one area and writes another →
  inspect the DTO carries `requires`/`produces` with `scopeSource:"inferred"`.
