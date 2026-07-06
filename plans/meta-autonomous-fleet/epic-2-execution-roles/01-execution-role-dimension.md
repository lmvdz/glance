# Execution-role dimension (types + DTO mirror + round-trip)

STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/types.ts, webapp/src/lib/dto.ts, src/squad-manager.ts

## Goal (what is built)

An orthogonal `executionRole` field that marks a unit as a `"tester"` or `"observer"` (absent =
general coder), threaded end-to-end: `CreateAgentOptions` → `PersistedAgent` → `AgentDTO` (both
the live create() path AND the `queuedDto` path) and mirrored in the webapp DTO. Pure plumbing:
no behavior keys off it yet (leaf 05 populates the observer case; leaf 04's tester case rides the
`kind:"workflow"` path already). A create() with `executionRole` set round-trips onto the DTO.

## Approach (how — cite real file:symbol attach points)

1. **src/types.ts** — add the type next to `AgentKind` (types.ts:55). Do NOT reuse `Role`
   (types.ts:1027 is RBAC — `"viewer"|"operator"|"admin"`):
   ```ts
   /** Specialization of a coding unit, orthogonal to AgentKind. Absent = general coder. */
   export type ExecutionRole = "tester" | "observer";
   ```
   Add `executionRole?: ExecutionRole;` to `CreateAgentOptions` (interface at types.ts:745),
   `PersistedAgent` (types.ts:656), and `AgentDTO` (types.ts:483). Place each near the existing
   `kind` field with a one-line doc comment.

2. **src/squad-manager.ts** — thread it through the two DTO builders:
   - In `create()`, the `PersistedAgent` literal (`const persisted: PersistedAgent = {` at
     squad-manager.ts:2789) — add `executionRole: opts.executionRole,`.
   - The `AgentDTO` literal that follows (`const dto: AgentDTO = {` at squad-manager.ts:2820,
     tail at 2839–2847) — add `executionRole: opts.executionRole,`.
   - `queuedDto` (squad-manager.ts:2403) — add `executionRole: opts.executionRole,` to its
     returned literal so a queued spawn carries the role too.

3. **webapp/src/lib/dto.ts** — mirror the type. `AgentKind` is mirrored at dto.ts:179 and
   `AgentDTO` at dto.ts:295 (`kind?: AgentKind` at dto.ts:300). Add:
   ```ts
   /** Mirrors src/types.ts's ExecutionRole — role specialization, orthogonal to kind. */
   export type ExecutionRole = "tester" | "observer";
   ```
   and `executionRole?: ExecutionRole;` on the webapp `AgentDTO` next to `kind`.

## Scope boundary

- Do NOT branch any behavior on `executionRole` in this leaf — plumbing only. No changes to
  `makeDriver`, routing, or the Observer.
- Do NOT touch `AgentKind` values or the RBAC `Role`/`Actor.role`.
- Do NOT add the field to `WorkflowMemberConfig`/`VerifySpec` (that is leaf 03's `mode`).

## Verify (concrete command + expected observable outcome)

- `bun run check` (tsc --noEmit) passes — the field exists on all three server interfaces and the
  webapp mirror with matching optionality.
- Add/extend a unit test (e.g. in tests that already exercise `create`, or a focused new
  `tests/execution-role.test.ts`) that spawns via the manager with `executionRole:"observer"`
  and asserts the returned `AgentDTO.executionRole === "observer"`; and one with the field unset
  asserting `dto.executionRole === undefined`. `bun test execution-role` (or the touched file)
  is green. Round-trip is the observable outcome — a create() carrying the role emits it on the DTO.
