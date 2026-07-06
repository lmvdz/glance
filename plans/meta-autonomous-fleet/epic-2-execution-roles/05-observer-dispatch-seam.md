# Observer → dispatch seam (spawn an observing agent)

STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/observer.ts, src/squad-manager.ts, tests/observer.test.ts

## Goal (what is built)

On a confirmed regression, the Observer spawns an **observing agent** that reproduces the failure
in its own worktree (leaf 02's `observe` workflow, `executionRole:"observer"`) instead of only
filing a Plane issue. Opt-in and additive: gated by `OMP_SQUAD_OBSERVE_REPRODUCE=1` (default off,
so no behavior change); on a successful spawn the finding is marked handled for this tick so the
file path is skipped; on spawn failure it falls through to today's file path. The existing
`confirmedGate` double-confirmation (a regression is only real if it REPRODUCES) still gates it.

## Approach (how — cite real file:symbol attach points)

1. **src/observer.ts** — add an injected dep to `ObserverDeps` (observer.ts:54, alongside
   `fileIssue`/`reopenIssue`/`removeAgent`):
   ```ts
   /** Spawn an observing agent to reproduce a confirmed regression in its own worktree.
    *  Absent ⇒ regressions are only filed (today's behavior). */
   spawnObserver?: (finding: Finding) => Promise<boolean>;
   ```
   Add the env gate helper near `autoDispatch()`/`autoFix()` (observer.ts:108–114):
   ```ts
   function observeReproduce(): boolean { return process.env.OMP_SQUAD_OBSERVE_REPRODUCE === "1"; }
   ```

2. In `tick()`'s finding loop (observer.ts:383), for a regression finding — identified by
   `f.fingerprint.startsWith("regression:")` (minted by `auditTestsGreen`, observer.ts:162, fed by
   `confirmedGate` at observer.ts:529) — BEFORE the existing dedup/file block (observer.ts:419),
   insert: if `observeReproduce() && this.deps.spawnObserver && !this.seen[f.fingerprint]`, call
   `spawnObserver(f)`; on `true`, record it in `seen` (so it isn't re-dispatched next tick),
   `reproduced.add(f.fingerprint)`, log "dispatched observing agent for <fp>", and `continue`
   (skip filing this tick); on `false`/throw, log and fall through to the normal file path. Do NOT
   touch the `reopenIssue`/`autoFixable` branches — only the plain regression finding.

3. **src/squad-manager.ts** — wire `spawnObserver` where the Observer is constructed
   (`new Observer({ … })` at squad-manager.ts:712, one per repo). Add a dep bound to a new private
   method, e.g.:
   ```ts
   spawnObserver: (f) => this.dispatchObserver(repo, f),
   ```
   Implement `private async dispatchObserver(repo: string, f: Finding): Promise<boolean>` that
   calls `this.create({ repo, task: <repro task text from f.title/f.detail>, verify: <the repo's
   gate command via detectVerify(repo)>, verifyMode: "observe", executionRole: "observer",
   autoRoute: false, track: false, approvalMode: "yolo" })` inside a try/catch returning
   `true`/`false`. Use `detectVerify` (already imported, squad-manager.ts:35) for the command;
   if it returns undefined, return false (nothing to reproduce against). Cap respect: `create`
   already enforces the WIP cap and throws when full — catch that and return false so the Observer
   falls back to filing.

4. Import `Finding` type into squad-manager if not already (`import type { Finding } from
   "./observer.ts"` — observer.ts:40 exports it).

## Scope boundary

- Do NOT change the confirmedGate logic, the file/reopen/autofix branches, or the seen-map schema
  beyond adding the regression fingerprint on successful dispatch.
- Do NOT auto-land or fix from the observing agent — the observe workflow (leaf 02) only
  reproduces and reports.
- Do NOT enable it by default — `OMP_SQUAD_OBSERVE_REPRODUCE` unset must preserve today's
  file-only behavior exactly.
- Do NOT dispatch for non-regression findings (survivors, stale-done, untracked, land-failure).

## Verify (concrete command + expected observable outcome)

- `bun run check` passes.
- Extend **tests/observer.test.ts** (30KB of headless Observer tests with injected fakes — follow
  its `ObserverDeps` fixture idiom). Add:
  - With `OMP_SQUAD_OBSERVE_REPRODUCE=1`, a fake `runGate` that is red twice (so `confirmedGate`
    reproduces) and a fake `spawnObserver` returning `true`: assert `spawnObserver` was called once
    with a `regression:`-fingerprinted finding, and `fileIssue` was NOT called for it (dispatch
    replaces filing that tick). Restore the env var.
  - `spawnObserver` returning `false`: assert the finding IS filed (fallback path).
  - Env unset / no `spawnObserver` dep: assert today's behavior — the regression is filed, spawn
    never called.
- `bun test observer` is green. End-to-end observable (manual, optional): with the flag on, a red
  main gate spawns an agent whose `executionRole === "observer"` running a graph with a `reproduce`
  node in its own worktree, visible in the roster, instead of only a `regression:` Plane issue.
