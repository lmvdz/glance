# Override reason class — force ≠ validator-override
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/land-ledger.ts, src/squad-manager.ts, tests/land-ledger.test.ts

## Goal (what is built)

Bypassing a validator **veto** is a strictly stronger act than a proof-force and gets its own logged
record type — never the proof-force record. A validator-override requires a non-empty `reasonClass`;
an empty reason class refuses the override (the veto stands). This makes the two override classes
separately auditable by the compliance evaluator (leaf 05).

## Approach (how — cite real file:symbol attach points)

- In `src/land-ledger.ts`, mirror the existing `ForcedLand`/`recordForcedLand`/`readForcedLands`
  trio (`src/land-ledger.ts:84,112,100`) with a parallel:
  ```ts
  export interface ValidatorOverride { branch: string; actor: string; reasonClass: string; detail: string; at: number; }
  export function readValidatorOverrides(stateDir: string): ValidatorOverride[]  // reads land-validator-override.json
  export function recordValidatorOverride(stateDir: string, branch: string|undefined, actor: string, reasonClass: string, detail: string, now?: number): number
  ```
  Use a distinct file `land-validator-override.json` (new `overridePath()` alongside `forcedPath()`
  at `src/land-ledger.ts:96`). `recordValidatorOverride` returns early (no write) when `branch` is
  undefined OR `reasonClass` is empty/whitespace — an override without a reason class is not recorded
  and must not be honored.
- In `SquadManager`, expose the override on the operator land action. `land(id, ...)` already takes
  `opts: { auto?; force?; actor?; reason? }` (`src/squad-manager.ts:2130`); add
  `validatorOverride?: { reasonClass: string }`. When present AND non-empty, pass
  `validatorOverride:true` into `landBranch` (leaf 02 reads it) and call
  `recordValidatorOverride(this.stateDir, branch, actor.id, reasonClass, detail)` — separate from the
  existing `recordForcedLand` call. When the reasonClass is empty, do NOT set `validatorOverride` (the
  veto from leaf 02 blocks the land).
- Audit trail parity: alongside the existing `this.store.appendAudit({ action:"land.force", ... })`
  (`src/squad-manager.ts:2060`), append `action:"land.validator-override"` with `{ reasonClass }` in
  the detail so the audit log distinguishes the two.

## Scope boundary

Do NOT change the proof-force path (`recordForcedLand`, `land.force` audit) — this leaf ADDS a parallel
record, it does not modify the existing one. Do NOT build UI for entering the reason class (a follow-up);
the server/CLI passes it through. Do NOT let a proof-`force:true` imply a validator-override — they are
independent flags.

## Verify (concrete command + expected observable outcome)

`bun test tests/land-ledger.test.ts` — new cases assert: (a) `recordValidatorOverride` with a non-empty
reasonClass writes a `ValidatorOverride` to `land-validator-override.json` and `readValidatorOverrides`
round-trips it; (b) an empty reasonClass is a no-op (returns the prior count, writes nothing); (c) the
proof-force `ForcedLand` file is untouched by an override write.
