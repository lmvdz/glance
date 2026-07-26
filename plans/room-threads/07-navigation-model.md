# Navigation: select vs enter, and multi-homed nodes
STATUS: done
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

## Questions examined

The 2026-07-25 amendment closed the centre-pane fork before this research began: the room timeline is
the default narrative; depth opens from cards and the rail; selection never yanks a conversation
mid-read. The remaining router and containment questions are settled below.

## Cross-Repo Side Effects
None.

## Acceptance criteria for implementation
- Selecting three state-pane nodes leaves the current conversation route and reading position unchanged.
- Entering and then backing out restores the prior route and its exact reading position.
- A shared unit or landing appears once at its primary home and as an honest typed reference elsewhere.
- A `parentId` cycle is rejected at write time; a valid typed reference never changes containment.

## Settled

### 1. Select previews; enter changes the conversation

**Select** is a reversible inspection of a state-pane node. A click, arrow-key move, or search result
sets the local `selectedNodeId`, highlights that node, and shows its preview in the state pane. It does
not change the router, replace the room timeline, or change either conversation's scroll position.
The preview must say: **“Selected: {title}. Press Enter to read its conversation; the room timeline
stays where you are.”** That states both the fact and the consequence: inspection is safe while
reading.

**Enter** is explicit: `Enter`, double-click, or a card/rail “Open conversation” control navigates to
the selected node's conversation route. The destination node timeline becomes the depth narrative;
the room timeline remains the default narrative and is never replaced by selection alone. Before
navigating, the router records the source route and its scroll offset. Enter restores the destination
route's last recorded offset; a card that names a particular event additionally anchors that event.
A node with no previous reading position opens at its first unread event, or at the newest event when
nothing is unread.

**Back** is history, not graph traversal: browser Back and the in-product back affordance return to the
immediately preceding conversation route and its recorded offset. Its copy is **“Back to {title} —
return to the message you were reading.”** Breadcrumbs are explicit ancestor navigation and therefore
enter that ancestor; they are not a disguised Back button. Selecting while inside a node conversation
still only previews. This gives a reader one invariant: nothing changes the conversation beneath them
unless they ask to enter it.

### 2. One primary home; typed references for every other relationship

The containment graph is a tree: every node has exactly one nullable `parentId`, its **primary home**.
An implementation unit or landing that serves another plan keeps the delivery plan/unit as its primary
home and records typed references to every other affected plan, concern, issue, and landing. References
are edges, not parents; they can be rendered under the other plan as a “Used here” reference, always
opening the one canonical node. A referenced node's breadcrumb shows only its primary-home ancestry and
labels the cross-plan link that led there, e.g. **“Used by {plan}; this work lives in {primaryPlan}.”**
It never claims that the referring plan is an ancestor.

This rejects true multi-homing. It preserves one unambiguous containment path for routing, breadcrumbs,
scroll restoration, authorization inheritance, and cycle checks, while still making shared work visible
where it matters. The write rule is correspondingly strict: reject a `parentId` that would form a
containment cycle; accept additional typed references after validating their target exists, and never
turn a reference into a parent.

### Evidence checked

- `plans/room-threads/00-overview.md`'s live dependency graph is already a DAG: concern 03 is blocked
  by 01, 02, and 20; concern 10 by 11, 16, 17, 20, and 21; concern 15 by both 11 and 12. Those are
  dependency references, not claims that one concern is contained by all of its prerequisites.
- `plans/room-threads/RECONCILE-VOICE.md` documents a real cross-plan chain: voice 02 follows
  room-threads 17, voice 03 follows room-threads 03 because both change `HubShell`, and voice 01 is
  independent in different repositories. It also records that voice calls must bind to one node id,
  not to a second channel/visibility model.
- Git landing `86fcd002` (PR #262) amended both `plans/room-threads` and `plans/the-room`; landing
  `3b2e94ba` (PR #263) changed room-threads concern 02 together with routing code and its regression
  tests. The repository therefore has real cross-plan and plan-plus-code landings, but neither
  establishes that duplicate containment is necessary. The references above capture the shared
  relationship without presenting the same work as two different conversational homes.

I did not find a verified historical landing that requires one live work node to have two containment
parents. That absence is not treated as permission to hide cross-plan work: typed references are
required whenever a landing or unit serves another plan.
