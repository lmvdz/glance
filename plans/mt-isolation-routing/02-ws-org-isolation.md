# WebSocket org isolation
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: tests/ws-org-isolation.test.ts
PLANE: OMPSQ-397 — https://app.plane.so/inkwell-finance/browse/OMPSQ-397/

## Goal

Add a live-server integration test proving two WebSocket clients on one DB-registry `SquadServer` only receive events for their own org.

The test must prove org A never receives org B's:

- initial or broadcast roster data;
- `agent` events;
- `transcript` events;
- transcript replay when org B subscribes to an org A agent ID.

## Approach

Use the same live-server and auth/registry seam as concern 01, but keep helpers local to this test file unless an implementer has already extracted a shared test helper.

1. Create org A/org B agent DTO fixtures with unique IDs and names.
2. Create a structural `AuthInstance` stub whose `getSession({ headers })` maps cookie/header selectors to `activeOrganizationId`.
   - Bun's test/runtime WebSocket supports `new WebSocket(url, { headers: { cookie: "session=orgA" } })`; use that instead of query-string org selectors.
   - `getActiveMemberRole()` can return `{ role: "member" }`; WebSocket transcript subscribe and initial roster are viewer-readable.
3. Use one live `SquadServer` with one real `ManagerRegistry` and seeded fake manager-shaped entries for org A and org B.
   - Needed fake methods: `list()`, `commandsFor(id)`, `getTranscript(id)`, `off()`, `stop()`.
   - For org A, `getTranscript("agent-a")` returns at least one unique transcript entry.
   - For org B, `getTranscript("agent-a")` returns `[]`.
4. Connect two sockets to the same `/ws` endpoint:
   - org A socket with cookie/header `session=orgA`.
   - org B socket with cookie/header `session=orgB`.
5. Attach message collectors before triggering events. Parse JSON into arrays.
6. Initial roster assertions:
   - org A socket sees a `roster` containing `agent-a` and not `agent-b`.
   - org B socket sees a `roster` containing `agent-b` and not `agent-a`.
7. Broadcast assertions:
   - call `registry.onEvent("orgB", { type: "agent", agent: agentB })` and await org B's matching event; assert org A has no matching event after a short drain.
   - call `registry.onEvent("orgB", { type: "roster", agents: [agentB], version: "" })` and await org B; assert org A has no matching roster mentioning `agent-b`.
   - call `registry.onEvent("orgB", { type: "transcript", id: "agent-b", entry })` and await org B; assert org A has no matching transcript.
8. Subscribe isolation assertion:
   - send `{ type: "subscribe", id: "agent-a" }` from the org B socket.
   - prove no `transcript` event for `agent-a` arrives on org B after a bounded drain.

Timing rules:

- Use event-driven readiness like `tests/coordinator.test.ts`: promises resolve on `onopen` and `onmessage` matches.
- For negative assertions, first await the positive delivery to the intended org, then wait only a small drain window and inspect collected events.
- Close sockets in `afterEach` before stopping the server.

## Cross-Repo Side Effects

None. This is backend test coverage only in `omp-squad`.

## Verify

- `bun test tests/ws-org-isolation.test.ts` passes without hanging.
- Full gate after both concerns: `bun run check && bun test`.

## Resolution

Closed 2026-06-30 via OMPSQ-397 (https://app.plane.so/inkwell-finance/browse/OMPSQ-397/). Commits: c3fce10.
Added `tests/ws-org-isolation.test.ts`, a live `SquadServer` + real `ManagerRegistry` WebSocket test proving org B roster/agent/transcript events stay out of org A and org B cannot replay org A transcripts.
