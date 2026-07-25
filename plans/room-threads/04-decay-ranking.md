# Decay ranking — prominence fades unless reinforced
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/lib/hub.ts, src/nodes.ts, tests
BLOCKED_BY: 01
MODE: afk

## Goal
The state pane orders itself and stays honest over months without anyone curating it.

## Approach
1. Score with a half-life: recent activity reinforces, silence decays. Ant trails fade without traffic —
   that decay is exactly what Slack threads lack, which is why promotion there is a one-way door and
   threads rot.
2. **Ordering only, never position.** Layout stays stable. A force-directed field would destroy the
   spatial memory that makes a board beat a feed — ATC strips work because they do not move on their own.
3. State picks the region; the score only orders within it. Needs-you is never scored — otherwise a
   silent blocked node loses a popularity contest to a chatty healthy one.
4. Velocity (rate of change) is the right activity signal inside "in flight", not raw message count.

## Cross-Repo Side Effects
None.

## Verify
- A node untouched for N hours ranks below a freshly active one, deterministically (inject the clock).
- A needs-you node with zero activity still sorts above every in-flight node.
- Ordering changes; region membership and layout do not.
