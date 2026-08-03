# Server route table — make the lane-router seam real
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/server.ts (handle() 1695–4023, ~205 branches; payload builders 4615–5050), src/feedback-routes.ts (the proven pattern), new src/routes/*.ts
MODE: afk

## Goal
A `Route[]` registry ({method, pattern, scope, handler}) behind a ~30-line matcher, assembled from
per-lane route modules (routes/memory.ts, routes/land.ts, routes/voice.ts, routes/org.ts…).
`handleFeedbackRoutes` already proves the extraction pattern — one adapter today means the seam is
still hypothetical; the second lane module makes it real. The ~650 lines of homeless `*Payload`
builders move next to the lane they read from. API surface becomes enumerable for the first time;
authz/scope checks become table data. Migrate lane-by-lane, thin-delegation branches first.

## Provenance
Memory-lane report candidate 5 + whole-repo report candidate 2 (top-recommendation pair with 04).
