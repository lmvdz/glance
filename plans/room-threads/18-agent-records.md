# Agents have records, not scores
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/agents.ts, src/nodes.ts, webapp/src/components/hub/*, tests
BLOCKED_BY: 17
MODE: afk

## Goal
What is known about an agent is evidence with a sample size and a date, openable to its source, and
never a leaderboard.

## Approach
Reference: `reference/03-machinery.html` → 4a, 4b; `reference/05-first-week.html` → 4a, 4b, 5a, 5b.

1. Every claim carries **its sample size** and **its date**. "Proven across 34 units since June" is a
   claim; "reliable" is not.
2. **Role default versus proven behaviour are distinguished** — what the agent was configured to do
   versus what it has actually done.
3. Every claim is **openable to the units that produced it**.
4. Claims **go stale and can be withdrawn**; a claim resting on evidence older than its window says so.
5. A new agent is **provisional and marked as being checked** — not silently trusted, not silently
   distrusted.
6. **No cross-agent leaderboard, ever.** Comparison invites optimising for the metric; the record exists
   to inform a decision about one agent's next task.

## Cross-Repo Side Effects
None.

## Verify
- Every rendered claim shows sample size and date.
- Opening a claim reaches the actual units.
- A claim past its freshness window renders as stale.
- A provisional agent is marked provisional in every surface that shows it.
- No view ranks agents against each other; asserted as a test, not a convention.
