# The two-pane shell, coupled by depth
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/hub/HubShell.tsx, webapp/src/components/hub/ChannelRail.tsx, webapp/src/lib/hub.ts, webapp/src/lib/router.ts, tests
BLOCKED_BY: 01, 02
MODE: afk

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
