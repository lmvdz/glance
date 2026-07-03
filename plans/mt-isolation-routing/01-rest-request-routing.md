# REST request routing
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: tests/routing.test.ts
PLANE: OMPSQ-396 — https://app.plane.so/inkwell-finance/browse/OMPSQ-396/

## Goal

Add a live-server integration test proving DB-registry REST requests are scoped by `AuthInstance.getSession().session.activeOrganizationId`.

The test must prove:

- org A reads only org A agents;
- org B reads only org B agents;
- `?org=orgB` on an org A request is ignored;
- no active org reads an empty list and mutations are denied;
- no session is unauthorized.

## Approach

Use the `tests/rbac.test.ts` live-server pattern: `afterEach` cleanup stack, temp state root, `new SquadServer(..., { port: 0 })`, and real `fetch()` calls.

Build only test seams:

1. Define unique agent DTO fixtures for org A and org B. Use distinct IDs/names so absence checks are meaningful.
2. Create a tiny structural `AuthInstance` stub:
   - `getSession({ headers })` reads a deterministic test cookie/header such as `session=orgA`, `session=orgB`, `session=no-org`, or no session.
   - returns matching `activeOrganizationId` values (`orgA`, `orgB`, `null`) and user IDs.
   - `getActiveMemberRole()` returns `{ role: "member" }`; a no-org session never calls the org role lookup because `bridgeRole` falls back to viewer when `activeOrganizationId` is null.
   - `handler()` can return `404`; `/api/auth/*` is not under test.
3. Use a real `ManagerRegistry` object, but seed org A/org B entries with fake manager-shaped objects in the same style as `tests/manager-registry.test.ts`.
   - Needed fake methods for this concern: `list()`, `off()`, `stop()`.
   - If TypeScript complains about private fields, use a named test-only interface for the private map seam; do not inline `any` casts repeatedly.
4. Start `new SquadServer(undefined, { port: 0, auth, registry })`.
5. Assert REST responses by IDs, not counts:
   - `GET /api/agents` as A returns `agent-a` and not `agent-b`.
   - `GET /api/agents?org=orgB` as A still returns `agent-a` and not `agent-b`.
   - `GET /api/agents` as B returns `agent-b` and not `agent-a`.
   - `GET /api/agents` as no-org returns `[]`.
   - `POST /api/command` as no-org returns `403`.
   - no cookie/header returns `401`.

Keep all helpers local to `tests/routing.test.ts` unless the file becomes obviously unreadable.

## Cross-Repo Side Effects

None. This is backend test coverage only in `omp-squad`.

## Verify

- `bun test tests/routing.test.ts` passes.
- Full gate after both concerns: `bun run check && bun test`.

## Resolution

Closed 2026-06-30 via OMPSQ-396 (https://app.plane.so/inkwell-finance/browse/OMPSQ-396/). Commits: 2edcfe2.
Added `tests/routing.test.ts`, a live `SquadServer` + real `ManagerRegistry` integration test proving DB-mode REST routing derives org scope from the session and ignores request-supplied org selectors.
