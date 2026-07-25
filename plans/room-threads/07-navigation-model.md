# Navigation: select vs enter, and multi-homed nodes
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: research
TOUCHES: webapp/src/components/hub/HubShell.tsx, webapp/src/lib/router.ts, src/nodes.ts, tests
BLOCKED_BY: 01
MODE: afk

## AMENDED 2026-07-25 (RECONCILE finding 6) — one fork is closed

The centre-pane question is **resolved by the design and is no longer open here**: the room timeline is
the default narrative, depth is entered through cards and the rail, and selection must not yank a
conversation mid-read. Remove the "global feed versus coupled panes" fork before shell work begins.

What genuinely remains open is narrower and still real:

- exact router interaction for select-versus-enter, and
- primary-home references versus true multi-homing for a unit or PR serving two plans.

Decide the second against real `BLOCKED_BY` and landing examples, not in the abstract.

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

3. **Are the panes coupled, or is the middle always global?** The reference surfaces this and does
   not resolve it: on its busy screen the tree says `payments-retry / 3.2` while the conversation
   beside it carries Pike on auth-service, Ash on the migration and Tam on invoicing — four different
   plans. So either selection scopes the conversation to that node, or the middle pane is always the
   org-level feed and the tree is navigation only. Both are defensible; picking by accident is not.
   This is the single biggest open question in the plan — concern 03's shell is built on the answer.

4. Breadcrumbs must stay honest under whichever model wins — a node reachable by two paths must not
   claim a single canonical ancestry it does not have.

## Cross-Repo Side Effects
None.

## Verify
- Reading a conversation survives clicking three nodes in the state pane.
- A node with two parents renders correctly from both, and its breadcrumb does not lie.
- A cycle in the graph is rejected at write time, not discovered at render time.
