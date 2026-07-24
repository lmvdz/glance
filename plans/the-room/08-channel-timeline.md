# Channel timeline — typed cards bound to channel entries
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/hub/ChannelTimeline.tsx (new), webapp/src/hooks (channel state), webapp/src/lib/ws.ts consumers, webapp/src/lib/dto.ts, tests
BLOCKED_BY: 01, 07
MODE: afk

## Goal
The hub's center pane renders a channel's entries as the existing typed-card grammar: human
messages, agent replies, and event-bearing proof cards — reusing the TranscriptTimeline/card
component family where shapes allow, new channel-specific binding where they don't (red team
verified the components exist but their prop-narrowness was unverified — budget adaptation).

## Approach
1. Channel state: extend useSquad/TaskContext reduction with {type:"channel-entry"} events +
   `?since=` seq resync on WS reconnect (concern 01 cursor).
2. Timeline: render channel entries through the typed-card dispatch (entry.kind + event.kind);
   plain text fallback for unknown event kinds (old-client rule). Scroll behavior: adopt the R3
   anchoring modes (following-end / anchoring-new-turn / free-scrolling) from the t3code research
   as the spec — implementation may start simpler but must not per-token re-scroll.
3. Card faces render from pinned payload.face instantly; door fetch is lazy (concern 12+).
4. Perf: memoized rows keyed by entry id; virtualize only if measured jank (channel volumes are
   lower than unit transcripts initially).

## Cross-Repo Side Effects
None.

## Verify
- Post human message + trigger a projected card in scratch daemon → both render as distinct card
  types in order; WS drop/reconnect shows no gaps or dupes (seq resync test).
- Unknown event.kind renders as neutral text card, no crash.
- DOM-free tests for the reduction + card-dispatch logic.
