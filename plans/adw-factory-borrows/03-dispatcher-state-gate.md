# Dispatcher state gate — make Backlog a real holding pen
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/dispatch.ts, src/config.ts, tests/dispatch.test.ts

## Goal
The Dispatcher only auto-dispatches issues in releasable states, so an unenriched Backlog ticket can no longer be spawned (and permanently claimed in the dispatch ledger) before a human or the promoter touches it.

## Approach
- Ground truth this fixes (both red teams, verified): `listPlaneIssuesUncached` filters only `completed`/`cancelled` (src/plane.ts:190) and `Dispatcher.tick` (src/dispatch.ts:271-355) checks claimed/ledger, `noAutoDispatch`, `blockedBy`, alreadyDone — **never `issue.state`**. Backlog is dispatch-eligible today; the dispatch ledger is add-only (src/dispatch-ledger.ts), so a prematurely claimed issue can never re-dispatch after enrichment.
- Add a state filter in `Dispatcher.tick` before the claim checks: skip issues whose `state` group is not in the releasable set. `IssueRef.state` already carries the group (populated by `toIssueRef`).
- Config: `OMP_SQUAD_DISPATCH_STATES` (comma list of groups, via `src/config.ts` readers). **Default in this concern: `backlog,unstarted,started` — today's behavior, no change.** The migration flip (default → `unstarted,started`) is an explicit operator step documented in the concern and in `glance doctor` output once concern 05 ships; flipping earlier silently starves dispatch of every raw ticket the operator relies on today.
- Log skipped-by-state once per issue (mirror `skipLogged` set) so the operator can see the holding pen working.
- Note the ledger interaction in a comment at the filter: the gate must run BEFORE `ledger.add` can occur — that ordering is the whole point.

## Cross-Repo Side Effects
None.

## Verify
- `bun test tests/dispatch.test.ts` — new cases: backlog-state issue skipped when gate configured to `unstarted,started`; ledger never receives its id; same issue dispatches after state moves to Todo (unstarted).
- Scratch daemon with `OMP_SQUAD_DISPATCH_STATES=unstarted,started`: file a Backlog ticket, observe skip log and no spawn across two ticks; drag to Todo, observe dispatch.

## Resolution
Shipped on branch worktree-research-adw-software-factory (PR #183), merged as c837c6a with integration/audit follow-ups on the same branch (see EXECUTION-LOG.md). state gate before all claim checks; acts only on the five Plane groups; config case-normalized, unrecognized state fails CLOSED under a narrowed gate / open under the default (audit F4 + code-review [8]); persistent ledger stamped only after spawn resolves (code-review [4]).
