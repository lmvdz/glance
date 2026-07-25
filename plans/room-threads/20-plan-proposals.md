# A plan is a proposal before it is work
STATUS: open
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

## Cross-Repo Side Effects
None.

## Verify
- The original sentence is retained verbatim and rendered beside the derived plan.
- Editing the proposal's shape changes what spawns; asserted end to end, not in the UI alone.
- An ambiguous goal produces a question and zero nodes.
- Starting is one deliberate act and cannot happen as a side effect of navigation.
- Proposed nodes never appear as in-flight work in ranking or counts.
