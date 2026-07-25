# More than one human — authority, attribution, and disagreement
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/rules.ts, src/authz.ts, src/squad-manager.ts, tests
BLOCKED_BY: 11
MODE: afk

## Goal
Every question reaches one named accountable human, every instruction keeps its author, and two humans
who disagree stay visibly two humans.

## Approach
Reference: `reference/05-first-week.html` → 2a, 2b.

1. A question routes to **one named accountable human** — not a group inbox where everyone assumes
   someone else has it.
2. **Instructions retain their author at every surface** they appear on, including quoted rules and
   replayed history.
3. Rules **stay attributed to the person who wrote them**; they never dissolve into anonymous house
   policy just because several exist.
4. Conflicting rules from different humans are **surfaced as a human disagreement**, with both sentences
   and both authors — never implicitly merged, never resolved by write order.
5. Which rule wins in a scope conflict is deliberately unsettled here; see RECONCILE's open question on
   rule evaluation semantics. This concern makes the conflict visible; precedence is decided with real
   historical instructions.

## Cross-Repo Side Effects
None.

## Verify
- A question has exactly one accountable human, named.
- Author survives every render path, including quoted-at-point-of-action.
- Two contradictory rules produce a disagreement surface, not a silent winner.
- Removing an author does not orphan their rules into anonymity.
