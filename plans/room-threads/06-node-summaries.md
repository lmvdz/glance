# Node summaries — the interface between nodes
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/nodes.ts, src/after-action.ts, src/squad-manager.ts, tests
BLOCKED_BY: 01
MODE: afk

## Goal
What flows between nodes is a summary, never a raw log. Each node maintains a current statement of
itself; raw history stays addressable at the node but is not what propagates.

## Approach
1. **Two summaries per node, not one.** They are different documents shaped by their consumer:
   - *upward* (escalation): what happened, what is needed, what it cost
   - *downward* (inherited context): goal, constraints, decisions taken
   Prior art: mattpocock/skills `productivity/handoff` shapes its output by "what the next session
   will focus on" — the same idea, applied to two directions instead of one successor.

2. **Reference, never duplicate.** Adopt the handoff skill's core rule verbatim in spirit: do not
   restate content already captured in a plan doc, PR, gate log or after-action — point at it by path
   or URL. A summary that restates its sources is just the log again, and it is the reason naive
   summarisation grows without bound.

3. **Regenerate, never append.** This is the load-bearing rule. Rebuild the summary from history on
   each state transition rather than growing it by accretion. Append-only context has no recovery
   path: the supervising session before this plan's was killed by accumulated context it could not
   shed, because every turn re-sent the whole thing. Regenerated context lets a bad turn stay a bad
   turn instead of becoming a permanent inheritance for everything downstream.

4. **When to compact resolves itself once (2) holds.** The original worry was cost and drift on a
   node that is still changing. A references-plus-current-state summary is small, so regenerating on
   every state transition is cheap — no separate scheduler, no "summarise a moving target" problem.
   Settling additionally freezes the upward summary into the node's after-action record.

5. After-action reports are ALREADY this artifact for settled units and already retain `channelId`
   (PR #252). Extend rather than duplicate.

6. Redact on generation — summaries propagate further than the messages they came from.

## Cross-Repo Side Effects
None.

## Verify
- Upward and downward summaries of the same node differ, and each contains what its consumer needs.
- A summary references its plan doc / PR rather than quoting them; assert no verbatim restatement.
- Regeneration is idempotent: same history in, same summary out.
- A poisoned turn dropped from history disappears from the regenerated summary — pin the recovery path.
- A settled node's upward summary matches its after-action record.
