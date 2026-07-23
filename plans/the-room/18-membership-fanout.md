# Membership + per-channel fan-out enforcement — one landing unit
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/server.ts (fan-out filter layer), src/channels.ts (membership), db schema, webapp (channel create/join UI), tests
BLOCKED_BY: 01, 02
MODE: afk

## Goal
Non-public channels whose visibility the transport actually enforces. Membership semantics and
per-channel socket-filtering land as ONE unit with leak tests — never a membership table whose
rows the fan-out ignores (A-S1: broadcastTo is an org bucket; any per-channel entry would
otherwise hit every org socket).

## Approach
1. Channel visibility: org-public (default, wave-1 behavior preserved) | private (member-only).
   Membership rows keyed by userId (concern 02 identity); creator manages members; no
   absence-inference revocation — removal is a positive-evidence row through the front door
   (binding revocation verdict, PR #217 class).
2. Fan-out: a channel-scoped delivery layer above broadcastTo — resolve the member userIds'
   socket sets and deliver only there; org-public channels keep the org-bucket fast path.
3. Leak tests are the unit's core: non-member in same org receives NO WS frame, NO HTTP read, NO
   search hit for a private channel; grep gate — no bare `broadcast(` in channel code paths.
4. Cross-lineage review mandatory (tenancy/trust path).

## Cross-Repo Side Effects
None.

## Verify
- Three users, one org: private channel between A+B — C's socket captures zero frames during
  traffic (wire-level assert), C's search/API reads 403/empty; revoking B stops delivery on next
  event; org-public channels unaffected.
