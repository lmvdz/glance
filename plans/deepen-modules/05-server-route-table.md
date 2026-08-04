# Server route table — make the lane-router seam real
STATUS: in-progress
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

## Slice plan (goal-mode, 2026-08-03)
Slice 1: Route[] registry ({method, pattern, scope, handler}) + ~30-line matcher + routes/memory.ts
(the thin observability GETs: horizon, episodes, after-action, symptoms, answers, fog reads) — the
SECOND lane module after feedback-routes.ts, which is what makes the seam real. Later slices:
voice lane (with concern 11), org/auth lane, payload builders move next to their lanes.

## Provenance
Memory-lane report candidate 5 + whole-repo report candidate 2 (top-recommendation pair with 04).
