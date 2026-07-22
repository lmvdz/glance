# Needs-you door — the flagship card→door proof (live-by-construction)
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/transcript-event-kinds.ts (needs-you kind), src/squad-manager.ts (pending→event emit), webapp/src/components/hub (NeedsYouCard, new), webapp/src/App.tsx + router (IntervenceView route), webapp/src/context/TaskContext.tsx, tests
BLOCKED_BY: 04, 05, 08
MODE: afk

## Goal
A blocked agent's pending request projects as a needs-you card in the routed channel; clicking it
opens IntervenceView (why-stopped, diff-as-spine, line-comment→steer) via a hash route that
survives reload. Flagship because the target is live-by-construction — a blocked agent is by
definition resident (A-C3 resolution) — so this door never lies.

## Approach
1. needs-you kind + reader land together (landing-order rule). Emit at the PendingRequest/attention
   path — the same substrate feeding the attention ladder (one substrate, two projections; concern
   05 relation test covers it).
2. IntervenceView gets a route (`#/intervene/:agentId`) resolving through the router from concern
   07 instead of in-memory-only context state (App.tsx:58 live-roster find stays, but reachable by
   URL); card click navigates.
3. Card face: pinned why-stopped summary + agent name + age; answered/resolved pendings render the
   card in a resolved state (the projection emits a resolution event — cards are append-only, the
   face of the ORIGINAL card may show "answered" by rendering the later resolution card's fact
   only via a follow-up card, never by mutating the row).
4. Degradation: if the agent is gone by click time (answered then removed), the door renders the
   honest fallback ("resolved/agent gone") — never a blank pane (IntervenceView.tsx:312 today).

## Cross-Repo Side Effects
None.

## Verify
- Scratch daemon: force a pending (permission ask) → card appears in channel + attention lane;
  click → IntervenceView on that agent; answer → resolution card appears; reload on the route
  works; removed-agent click → honest fallback, not blank.
