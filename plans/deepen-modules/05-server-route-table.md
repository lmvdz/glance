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

## Slice ledger
- Slice 1 done (2026-08-04, iteration 9): src/routes/table.ts (Route type + first-match dispatch,
  string/RegExp patterns, undefined fall-through — the feedback-routes contract as data) +
  src/routes/memory.ts (8 observability GETs moved verbatim, second lane adapter → seam is real).
  boundedNumber de-cloned into the table module. codex found one real Low (empty-id domain drift,
  fixed with (.*) + recorded); grok clean with itemized precedence checks. Remaining slices:
  attention/fog lane (needs server-instance ctx made explicit), voice lane (with 11), org lane,
  payload builders.

- Slice 2 done (2026-08-04, iteration 11): routes/attention.ts — 6 attention/ladder/fog routes
  moved with the server-instance context made EXPLICIT (Route<C> generic; viewerId/isAdmin
  computed once in handle(), no this.* reach-back); fail-closed POSTs and the fog-vs-attention
  repo-param normalization asymmetry preserved (both blind passes verified it specifically);
  codex clean, grok clean. Remaining: voice lane (with 11), org lane, payload builders.

- Slice 3 done (2026-08-04, iteration 22): routes/org.ts — the 13 session-tier org/auth admin
  routes (join-requests, org profile/members/invite/join-policy, the four voice-key admin
  routes) moved verbatim. Third context shape for the seam: the lane runs BEFORE manager/actor
  resolution, so table.ts's base relaxed to MatchContext {url,req} (type-level only — existing
  lanes still declare RouteContext) and OrgRouteContext carries auth/db/session/role + the
  voice-key rate-limiter thunk explicitly. members role|remove collapsed to one anchored
  non-capturing RegExp ≡ the two old string equalities (codex probed it live: trailing slash,
  case, superset paths all fall through). /api/me, /api/workos/sync, /api/auth/check stay
  inline deliberately (any-verb matching / pre-tier-gate; documented in the module header).
  codex CLEAN (runtime fall-through probes + precedence trace), grok CLEAN + 2 Low import/doc
  nits (fixed + recorded). Remaining: voice lane (with 11), payload builders.

## Provenance
Memory-lane report candidate 5 + whole-repo report candidate 2 (top-recommendation pair with 04).
