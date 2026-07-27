# Navigation: select vs enter, and multi-homed nodes
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: research
TOUCHES: webapp/src/components/hub/HubShell.tsx, webapp/src/lib/router.ts, src/nodes.ts, tests
BLOCKED_BY: 01
MODE: afk

## Goal
Two unresolved shape questions, each with a real failure mode, settled before the shell hardens
around a guess.

## Approach
1. **Select and enter are different acts.** If clicking through the tree swaps the conversation out
   from under you mid-read, you lose your place and learn to distrust the tree — and then the whole
   two-pane premise fails. Preview on select, switch on enter, and a way to pin the chat pane while
   exploring. Prototype and try it before committing; this is a feel question, not a logic one.

2. **It is a DAG, not a tree.** A unit can serve two plans; a PR closes issues across them. So a node
   can have more than one parent. Decide deliberately:
   - primary home + references from elsewhere (recommended — keeps navigation unambiguous), or
   - true multi-homing (a node appears under every parent, one identity)
   Whichever is chosen, `BLOCKED_BY` edges in plan docs are already a DAG and should be the test case.

3. Breadcrumbs must stay honest under whichever model wins — a node reachable by two paths must not
   claim a single canonical ancestry it does not have.

4. **Current state is a property of the node, never of the path.** Whichever multi-homing model wins,
   both parents render the same current state — divergent parent views of one node is the
   parallel-worker "temporal disagreement" failure, resolved at the node by concern 02's supersession
   rule, not per-view. (Source: plans/research-long-horizon-agent-memory/BRIEF.md, Rank 2.)

## Cross-Repo Side Effects
None.

## Verify
- Reading a conversation survives clicking three nodes in the state pane.
- A node with two parents renders correctly from both, and its breadcrumb does not lie.
- A node with two parents reports the same current state from both — parent views may not diverge
  (E_contradiction guard).
- A cycle in the graph is rejected at write time, not discovered at render time.
