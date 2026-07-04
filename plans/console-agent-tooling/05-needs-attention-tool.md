# squad_needs_attention tool
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/console-tools/needs-attention.ts (new), src/console-tools.ts, tests/console-tools.test.ts

BLOCKED_BY: 01

## Goal
"What needs me?" gets a computed answer: pending gates, stranded uncommitted work, idle-with-nothing-landed units, and factory-health flags — the four signals that actually mattered in the 2026-07-04 incident.

## Approach
Registry entry `squad_needs_attention`, `readOnly: true`, no required parameters.
This is a lean server-side assembly, NOT a port of webapp `insights.ts` (34KB — explicitly rejected in DESIGN.md). Sections, each from verified reads:
1. **Waiting on a human**: agents with `pending` requests (roster DTO carries them; gate kind + age). Highest priority section.
2. **Stranded work**: for each non-archived agent whose status is idle/stopped, run `changedFiles(worktree)` (`src/explore.ts:110`) concurrently (Promise.all, cap roster scan at 40); report "N files uncommitted, M ahead of main" lines. This is the read side of OMPSQ-422's stranded-work item — link the ticket in a code comment.
3. **Idle without result**: units idle with turns exhausted and neither landReady nor commits ahead (derive from DTO fields that exist; don't invent).
4. **Factory**: `factoryStatus()` anomalies (armed-but-not-fueled etc.) + automation error count from `automationActivity({meaningfulOnly:true})`.
Output: prioritized markdown ("Needs you now" / "Worth a look" / "Healthy"), capped ~6KB. Empty state says "nothing needs you" explicitly.

## Cross-Repo Side Effects
None. NOTE for the webapp (no change required): this tool makes the chat's answer overlap the dashboard's Attention panel — divergence between the two is a signal `insights.ts` and this assembly disagree; acceptable, they serve different surfaces.

## Verify
- Tests: stub manager with canned roster (one pending-gate agent, one dirty-idle agent via a seeded temp repo, one healthy) → sections populated correctly, priorities ordered, empty-state message.
- Manual: reproduce the 2026-07-04 question in the webapp chat; the answer must surface a stranded-work unit without being told about it.
