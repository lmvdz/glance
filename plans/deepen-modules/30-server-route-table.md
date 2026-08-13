# server.ts route table — retire the 1,748-line handle()
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: complex
TOUCHES: src/server.ts (3,725 lines; handle() 1584–3332 = 47% of the file; 99 exact pathname matchers + 4 prefix + regex; handleObservability 1092–1202 is the proven seam)
MODE: afk

## Goal
`handle(req, server)` is a 1,748-line if-ladder. The route table is a LIST, not a graph —
the safest big extraction in the daemon. Seam: `RouteTable` of `{ method, match, tier,
handler }` with `handle` reduced to auth/actor resolution + table lookup; move handler bodies
out in families following the `handleObservability` precedent (observability already done →
voice, push, decisions, channels, agents). Handlers close over manager helpers that are
already methods, so each family lifts as a function over a small context object. Slice per PR:
the table + one family first, remaining families mechanically after. Continues round-1's
concern 05 groundwork.

## Provenance
Round-3 review, daemon agent, ranked with the land-lane family as the strongest daemon items.
