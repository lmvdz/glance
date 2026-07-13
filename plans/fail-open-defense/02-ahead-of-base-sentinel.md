# aheadOfBase's `-1` sentinel reads as "no unlanded work"
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/land-mode.ts, src/squad-manager.ts, src/worktree-reaper.ts, tests/

## Goal
A transient git failure must never read as "this agent has nothing to land." Today it does, and the
orchestrator silently skips the unit forever with no escalation — the interlock shape.

## Approach
`aheadOfBase` (src/land-mode.ts:193) returns `-1` when git fails, on both the PR-mode and local-mode
branches. Two consumers ask `> 0`, so `-1` reads as `false`:
- `agentHasUnlandedWork` (squad-manager.ts:3512) → `orchestrator.ts:220`'s
  `if (!(await this.deps.agentHasWork(a.id))) continue;` **skips the land entirely.**
- `persistedHasWork` (squad-manager.ts:1700, via :1522) → a persisted agent's work is deemed absent.
- `worktree-reaper.ts` asks `=== 0` and is therefore accidentally fail-SAFE. It must stay so.

Make "couldn't determine" impossible to compare numerically: return `number | "unknown"` and force
every consumer to branch. Unknown ⇒ `agentHasUnlandedWork`/`persistedHasWork` return **true** (assume
work; the cost is a wasted acceptance run, the alternative is a unit that never lands). Unknown ⇒
reaper treats as **not merged** (unchanged, now explicit). If the reaper's `aheadOfBase: number` DTO
field makes the union too invasive, the fallback is keeping `-1` with a named `aheadUnknown(n)` helper
at every call site — but no bare `> 0` may remain. Grep every consumer, including `auditLandedSurvivors`.

## Cross-Repo Side Effects
None.

## Verify
Reproduce-first: with a PATH-shimmed git that fails `rev-list`, `agentHasUnlandedWork` returns `false`
on current code and `true` after. Reaper still treats unknown as not-merged; genuine `0` still means no
work; genuine `>0` still means work.
