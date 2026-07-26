# The two-pane shell, coupled by depth
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/hub/HubShell.tsx, webapp/src/components/hub/ChannelRail.tsx, webapp/src/lib/hub.ts, webapp/src/lib/router.ts, tests
BLOCKED_BY: 01, 02, 20
MODE: afk

## AMENDED 2026-07-25 (RECONCILE finding 2) — the room is the home frame

The coupled-pane thesis is superseded as the *home* frame. The settled direction is a **room home
screen** whose rail is a standing entrance and into which depth events project cards back.

- Selecting a plan in the rail **does not** make the main conversation stop being the room narrative.
  The busy room explicitly shows cross-plan conversation beside a selected plan.
- Detailed unit context is **entered from the work or the card**, not by selecting in the rail.
- Coupling still exists — but one level down, once you have entered a node, not at the home frame.

Build against `reference/01-room.html` (busy and quiet) and `reference/02-surfaces.html` → 3a, 8b,
plus `DIRECTION.md` §What we are building. The obsolete "global feed versus coupled panes" fork is
closed; see the amendment on concern 07.

## Partly built 2026-07-26 — the state side

`webapp/src/lib/roomState.ts` + `StatePane.tsx`, wired into `HubShell` beside the room narrative
rather than replacing it, which is the home-frame amendment made structural.

**The copy lives in the lib, not in JSX**, so the rules it must satisfy are testable. Every string
states a fact and what it means, and a test asserts no status line is a bare state word — the rule
that is hardest to retrofit. Three regions in a fixed order; settled work collapses off the working
surface but stays readable. Select previews and changes nothing you are reading; Enter is the only
key that navigates (concern 07).

The alarm band explains rather than counts: at zero it reports elapsed unbroken autonomy and the
month's best run, and with several at once it says outright that this is a defect in the work rather
than a list to keep. Parked work carries no elapsed number, however long it has sat, because an age
beside parked work reads as overdue and parked is a decision. An unknown agent status projects as
in-flight, never settled — settled work leaves the working surface, so a status nobody recognises
must not make work vanish.

Two of my own defects were caught by these tests: `duration(30s)` rounded up to "1m", and the
in-flight line was 22 characters that named a state and stopped.

**Still open:** the doors, the folded-run open view, the handover screen rendered (its copy exists and
is tested), and the depth coupling once you have entered a node. `foldVerdict` and `handoverSummary`
are built and tested but not yet rendered.

## Goal
State on one side, that node's conversation on the other. Drilling into state changes both, so the
conversation is always about what you are looking at — and is found by navigating to the thing rather
than by remembering when it happened.

## Approach

**Build against [`reference/quiet-inbox.html`](reference/quiet-inbox.html)** — the direction is
settled, four screens exist, and it is runnable HTML rather than a picture. Read DESIGN.md's "The
design, established" section first: the six patterns there are requirements, not suggestions, and
the copy rules are the hardest part to retrofit later.

Specifically from the reference, do not re-derive these:
- the alarm band is a full-width sentence that explains, not a labelled counter
- unbroken-autonomy elapsed time and the month's best run sit beside the count
- every decision control carries a consequence line, and every decision offers a free-text option
- the tree shows a per-node one-line status ("holding — cannot start until 3.2 is decided",
  "queued — nobody has picked it up") and closes with the blast radius
- folded event runs end in a verdict ("nothing unusual")
- the quiet screen is a HANDOVER ("what got done while you didn't look"), not an empty state

1. State pane lists the current node's children grouped by state: needs-you (near-empty and visibly
   so), in flight, settled (collapsed — done work leaves the working surface).
2. Chat pane shows that node's channel, with inherited context (the parent's goal and constraints)
   pinned above the conversation. Composer at the node = the steer for work under it.
3. Same interaction at every depth. Org, plan, unit, subagent — one mental model, applied recursively.
4. Style to `brand.md`, matching `ChannelRail.tsx`'s migrated treatment: ink ramp, one ember accent,
   semantic colour for state only, mono uppercase eyebrows.
5. Selecting and entering are DIFFERENT ACTS (see 06) — do not swap the chat pane on hover or select.

## Cross-Repo Side Effects
None.

## Verify
- Navigating to a node shows its children and its channel; the breadcrumb reflects depth.
- Needs-you renders as a region and is empty when nothing waits — not a filtered list you must read.
- Settled is collapsed by default and does not accumulate on screen.
- DOM-free tests for the grouping and region assignment.
