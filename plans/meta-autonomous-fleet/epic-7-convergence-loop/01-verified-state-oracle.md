# Verified-state oracle module

STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/convergence-oracle.ts (new), src/types.ts, src/convergence-oracle.test.ts (new)

## Goal (what is built)

The disk contract shared by the TS state machine (writer) and the bash Stop hook (reader): a
`VerifiedState` type, the canonical file paths under the glance state dir, an atomic read/write
pair, and the arm-sentinel primitives (`arm`/`disarm`/`isArmed`). Nothing here iterates or plans;
it is purely the persisted boundary object.

## Approach (how — cite real file:symbol attach points)

- Add `VerifiedState` to `src/types.ts` with exactly the schema in `DESIGN.md §1` (`goalId`,
  `iteration`, `gap`, `epsilon`, `pendingEscalation`, `budget:{spent,cap}`, `decision`,
  `updatedAt`). Place it near the other run/receipt DTOs (e.g. by `acceptanceCriteria` at
  `src/types.ts:418`). Export it.
- New `src/convergence-oracle.ts`:
  - `import { resolveStateDir } from "./state-dir.ts"` (`src/state-dir.ts:51`) — the single source
    of truth for the state root.
  - `convergenceDir(stateDir = resolveStateDir())` → `path.join(stateDir, "convergence")`.
  - `oraclePath(stateDir?)` → `<convergenceDir>/oracle.json`; `armPath(stateDir?)` →
    `<convergenceDir>/armed`.
  - `writeOracle(state, stateDir?)`: `mkdir -p` the dir, write to a temp file then `rename` onto
    `oraclePath` (atomic — same discipline as the spool in `src/automation-log.ts`).
  - `readOracle(stateDir?): VerifiedState | null` — returns null on missing/parse error (callers
    fail safe).
  - `arm(stateDir?)` writes the sentinel file; `disarm(stateDir?)` removes it (idempotent,
    `force: true`); `isArmed(stateDir?)` = `existsSync(armPath())`.
- Use `node:fs`/`node:fs/promises`/`node:path`/`node:os` only — no new deps (matches
  `src/automation-log.ts`, `src/state-dir.ts`).

## Scope boundary

Do NOT implement the iteration logic (leaf 02), the ratchet (leaf 03), the bash hook (leaf 04),
or any planner/validator wiring. Do NOT add a `handoffDoc()` serializer yet (leaf 06 adds it).
Do NOT touch `.claude/settings.json` or `runtime-settings.ts`.

## Verify

```
bun test src/convergence-oracle.test.ts
```
Expected: green. Tests must cover — (a) `writeOracle` then `readOracle` round-trips a
`VerifiedState` unchanged under a temp `OMP_SQUAD_STATE_DIR`; (b) `readOracle` returns `null` for a
missing file and for a corrupt (non-JSON) file; (c) `arm` → `isArmed()===true`, `disarm` →
`isArmed()===false`, and `disarm` on an absent sentinel does not throw; (d) `oraclePath()` resolves
under the env-overridden state dir (set `OMP_SQUAD_STATE_DIR` to a temp dir and assert the path
prefix). Also `bun run typecheck` (or `bunx tsc --noEmit`) clean.
