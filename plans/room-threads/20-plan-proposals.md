# A plan is a proposal before it is work
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/nodes.ts, src/squad-manager.ts, webapp/src/components/hub/*, tests
BLOCKED_BY: 01
MODE: afk

## Goal
Between a human's sentence and running agents there is a proposal he can change the shape of — not just
approve or reject — and an ambiguous goal stops before anything spawns.

## Approach
Reference: `reference/02-surfaces.html` → 7a, 7b.

1. The proposal records **the human's original words**, unedited, alongside everything derived from them.
2. It states **the assumptions it made** to get from the sentence to the units.
3. It shows **the proposed units, their order, and what runs in parallel**.
4. It states **the consequences of starting** in consequences, not counts: "four agents wake, three files
   are touched, nothing lands without you."
5. **The human can change the shape** — split, merge, reorder, drop — not only approve or reject. This is
   where the standing law that humans plan and review plans is honoured or quietly broken.
6. **An ambiguous goal asks before spawning**, never after.
7. Projection (concern 02) must distinguish **proposed** from **started**; a proposed node is not work.

## Built 2026-07-25

`src/plan-proposals.ts`, persisted in both stores (migration `0019_plan_proposals` + RLS), surfaced
through `SquadManager.proposePlan` / `reshapeProposal` / `startProposal` / `planProposals`.

The original words are stored **unedited** — not trimmed, not normalised — because a person checks the
derivation against what they actually said, and any edit makes that check impossible. Assumptions carry
what would have settled them (`insteadOf`), since an unstated alternative makes an assumption
indistinguishable from a fact.

The consequence is a sentence, never a count: "2 agents wake now; one more waits on work that has to
finish first. 2 files are touched: … Nothing lands without you." That last clause survives every branch.
When file impact is unknown it says so rather than rendering "0 files" — absence is not zero.

**Reshaping is the point.** Split, merge, reorder, retitle, drop. Approve-or-reject is not review:
bouncing a seven-unit plan because the third unit is wrong is not planning. Operations that would leave
the plan unable to run are refused rather than silently repaired — dropping a unit something waits on,
a reorder that creates a cycle, a merge of units that do not exist — because silent repair hands the
person a plan they did not design. A split rewires old dependents onto the LAST part, since waiting on
the first would let them start before the work they depend on had finished.

Ambiguity asks before spawning: a proposal carrying `needsClarification` has no units and cannot be
started, and `proposePlan` refuses one that tries to do both — units resting on a guess the planner
itself flagged as unsafe. Starting is one deliberate act, and reshaping after it is refused because at
that point it is steering, not planning.

Concern 02's projection can now distinguish proposed from started: a proposal is not work.

## Cross-Repo Side Effects
None.

## Verify
- The original sentence is retained verbatim and rendered beside the derived plan.
- Editing the proposal's shape changes what spawns; asserted end to end, not in the UI alone.
- An ambiguous goal produces a question and zero nodes.
- Starting is one deliberate act and cannot happen as a side effect of navigation.
- Proposed nodes never appear as in-flight work in ranking or counts.
