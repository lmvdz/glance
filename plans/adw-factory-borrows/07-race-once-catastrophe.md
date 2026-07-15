# Race-once at gate exhaustion (workflow catastrophe seam)
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts, src/race-ledger.ts (new), tests/race-once.test.ts (new)
BLOCKED_BY: 01, 02

## Goal
When an issue-carrying verify unit exhausts its workflow (visit-cap catastrophe) and its lane allows `race: 1`, the daemon parks the failed unit and spawns exactly one fresh-context sibling with an alternate-strategy prompt before escalating to a human — converting one human-park into one more autonomous rung.

## Approach
- Seam (red-team, both): the workflow terminal-failure path — `node "X" exceeded its visit cap` (src/workflow/engine.ts:98) surfacing via `markCatastrophe` (src/squad-manager.ts:1865) — NOT `fileLandBlockedEscalation` (:3824), which fires for land-infrastructure blocks (dirty main, merge hiccups) where the diff already passed gates; racing there re-implements accepted work and manufactures a double-land.
- Flow at catastrophe of an issue-carrying unit with `LANE_POLICY[lane].race === 1` (operator-config lanes only, per the concern-02 clamp):
  1. Check the persisted race ledger — one race per issue, ever. `src/race-ledger.ts` follows the `dispatch-ledger.ts` shape (tiny JSON set per stateDir); in-memory dedup alone re-fires after daemon restart (red-team C3.3).
  2. Park the original first: stop the unit, keep its worktree for forensics — the sibling must never run concurrently with a live original (double-land hazard).
  3. Spawn the sibling on the same issue: fresh worktree, branch suffix (deterministic `planeIssueBranch` collides otherwise), alternate-strategy prompt reused from fan-out's variants (workflows/fan-out/workflow.fabro:12-14 — pick the strategy furthest from the original's failure mode, default "simplicity"), `claimed()` bookkeeping so the Dispatcher doesn't double-count the issue.
  4. Suppress the human escalation while the sibling runs; if the sibling also reaches catastrophe (ledger already stamped ⇒ no second race), escalate with BOTH attempts referenced in the attention event detail.
- Honest bookkeeping note in-code: this is 1:N-lite — same-issue sibling with distinct branch and linked outcome; the full N-wide dispatch racing (BRIEF concept 4b) stays a design spike and this concern must not grow into it.
- Flag: `OMP_SQUAD_RACE_ONCE` default off; on = lanes with `race: 1` in constants (hotfix only, v1).

## Cross-Repo Side Effects
None.

## Verify
- `bun test tests/race-once.test.ts` — catastrophe with race-eligible lane spawns exactly one sibling and suppresses escalation; second catastrophe escalates with both attempts; restart between catastrophe and sibling completion does not spawn a second sibling (ledger); non-race lane escalates immediately (existing behavior).
- Live scratch-daemon: force a visit-cap catastrophe (impossible verify command) on a hotfix-lane unit with the flag on; observe park → sibling → (sibling fails) → single escalation naming both.
