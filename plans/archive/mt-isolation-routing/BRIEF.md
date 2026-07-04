# MT isolation request-routing integration brief

## Goal

Add integration-test coverage only for `plans/mt-isolation/03-request-routing.md`:

1. `tests/routing.test.ts`: DB-mode REST requests use the org from `AuthInstance.getSession`, not URL/body input; org A cannot read org B.
2. `tests/ws-org-isolation.test.ts`: two WebSocket clients on one live `SquadServer` receive only their own org's roster/agent/transcript events.

No production code is needed; `src/server.ts` already contains the routing and per-org fan-out implementation.

## Sources scouted

- Concern spec: `plans/mt-isolation/03-request-routing.md:10-14`, `:120-126`.
- Live-server harness: `tests/rbac.test.ts:100-134`, `tests/auth.test.ts:45-89`, `tests/db-auth.test.ts:48-83`.
- Existing DB auth behavior: `tests/db-auth.test.ts:85-128`, `:130-172`.
- Existing WebSocket event-waiting style: `tests/coordinator.test.ts:16-33`, `:47-66`; polling helper pattern: `tests/federation-sync.test.ts:36-42`, `:55-60`.
- Runtime seams: `src/server.ts:196-210`, `:323-336`, `:396-445`, `:520-658`, `:1227-1254`.
- Registry seam: `src/manager-registry.ts:56-116`; fake private-map seam precedent: `tests/manager-registry.test.ts:52-57`.
- Bun WebSocket docs: `server.upgrade(req, { data })` stores contextual `ws.data`, handlers are server-level, `ws.send()` sends string/bytes; cookies ride upgrade headers, and Bun's test/runtime client supports constructor `headers` as a Bun-only extension: <https://bun.com/docs/runtime/http/websockets>.

## Runtime facts to preserve in tests

- `AuthInstance` is structural: only `handler`, `api.getSession`, and `api.getActiveMemberRole` are needed (`src/server.ts:204-209`). A test stub can satisfy the interface without importing better-auth.
- REST DB mode resolves `session = await auth.api.getSession({ headers })`, bridges role from `activeOrganizationId`, then builds an actor with `orgId` from the session (`src/server.ts:603-657`). The query string is not part of the routing key.
- `managerFor(actor)` is the only manager lookup: registry mode returns `registry.get(actor.orgId)` or no fleet when absent (`src/server.ts:396-402`).
- No active org returns empty JSON for GET and `403` for mutations (`src/server.ts:439-445`, `:657-658`).
- WS upgrade stamps `orgId` from the session into `ws.data`; socket commands reuse `actorForSocket(ws)`, not wire-supplied orgs (`src/server.ts:523-548`, `:484-493`).
- `registerSocket()` buckets sockets by `ws.data.orgId`; `broadcastTo(orgId, e)` only iterates that org's bucket (`src/server.ts:409-423`, `:1241-1254`).

## Transferable test patterns

### Shared live-server harness

Follow `tests/rbac.test.ts:100-134`:

- `afterEach` drains a cleanup stack.
- Temp root via `fs.mkdtemp(path.join(os.tmpdir(), "<prefix>-"))`.
- Bind `SquadServer` on `port: 0`; use returned URL.
- Cleanup order: close sockets, `server.stop()`, stop managers/registry, remove temp dir.

For DB-registry tests, instantiate `new SquadServer(undefined, { port: 0, auth, registry, trustedOrigins: [origin] })`; no root `SquadManager` is needed because registry mode owns fleets.

### Auth stub pattern

Use a tiny structural `AuthInstance`:

- `getSession({ headers })` maps a deterministic test header/cookie to one of:
  - user A + `activeOrganizationId: "orgA"`
  - user B + `activeOrganizationId: "orgB"`
  - user N + `activeOrganizationId: null`
  - `null` for unauthenticated
- `getActiveMemberRole()` returns `{ role: "member" }` or `{ role: "owner" }`; member is enough for `GET /api/agents`, owner/admin if a mutation assertion is included.
- `handler()` can return `404` because these tests do not exercise `/api/auth/*`.

This proves routing comes from server-side session state. Use a header/cookie only as a session selector; never pass an org claim in URL/body except as the malicious ignored input (`/api/agents?org=orgB`).

### Manager/registry seam options

Preferred for these tests: keep a real `ManagerRegistry`, but seed its private `managers` map with fake manager-shaped objects. This keeps the live `SquadServer` and real `ManagerRegistry.get()` path while avoiding real agent process startup. The repo already uses this private-map test seam in `tests/manager-registry.test.ts:52-57`.

Fake managers need only the methods hit by server routes/WS:

- REST `/api/agents`: `list()`.
- WS open: `list()` and `commandsFor(id)`.
- WS subscribe: `getTranscript(id)`.
- Cleanup/registry stop if used: `off()`, `stop()`.
- Optional WS command assertions: `applyCommand(cmd, actor)`.

Alternative: use `FileStore` under `root/orgs/<orgId>` and real `SquadManager` instances. This is heavier and risks adoption/janitor side effects from persisted agents. Fake managers are narrower and target the server-routing contract directly.

### `tests/routing.test.ts` target assertions

Data setup:

- org A manager list: one agent with id/name unique to org A, e.g. `agent-a`.
- org B manager list: one agent unique to org B, e.g. `agent-b`.

Assertions:

- `GET /api/agents` with session A returns only `agent-a`.
- `GET /api/agents?org=orgB` with session A still returns only `agent-a`.
- `GET /api/agents` with session B returns only `agent-b`.
- No-org session returns `[]` for `GET /api/agents`.
- No-org mutation such as `POST /api/command` returns `403` if included; this matches the concern's requested no-org edge case.
- Unauthenticated request returns `401`.

### `tests/ws-org-isolation.test.ts` target assertions

Socket setup:

- Connect two client `WebSocket`s to `url.replace("http", "ws") + "/ws"`.
- Use Bun's `new WebSocket(url, { headers: { cookie: "session=orgA" } })` client extension to feed distinct cookie/header selectors into the stubbed `getSession`. This is acceptable in Bun tests and keeps org selection inside request headers; do not put org selectors in the URL or command payload.

Event assertions:

- On open, org A receives an initial `roster` containing only org A agents; org B receives only org B agents.
- Trigger `registry.onEvent("orgB", { type: "agent", agent: agentB })`; org B should receive it, org A should not.
- Trigger `registry.onEvent("orgB", { type: "roster", agents: [agentB], version: "" })`; org B receives it, org A does not.
- Trigger `registry.onEvent("orgB", { type: "transcript", id: "agent-b", entry })`; org B receives it, org A does not.
- Send `{ type: "subscribe", id: "agent-a" }` from the org B socket; fake org B manager returns no transcript for `agent-a`, so org B receives no replay.

Use positive-before-negative timing:

1. Attach `onmessage` collectors before triggering events.
2. Await the intended org's message first.
3. Only then assert the other org's collector has no matching event after a short drain window or a polling deadline.

This mirrors the repo's event-driven WS style (`tests/coordinator.test.ts`) while avoiding fixed sleeps as the primary readiness signal (`tests/federation-sync.test.ts`).

## Risks and traps

- The requested WS auth stub is the only non-obvious risk: browser/client WebSocket APIs usually do not allow arbitrary headers. Confirm Bun's client supports the intended cookie/header injection. If not, use real better-auth cookie setup from `tests/db-auth.test.ts` or an allowed constructor option, not query-string org claims.
- Do not use `/api/command` create for the WS event test unless the test intentionally wants real manager create behavior; `create` can spawn agent runtime work. Simulating manager events through `registry.onEvent(orgId, event)` directly targets the broadcast contract.
- Do not assert “no cross-org read” by only checking response lengths; use unique IDs/names and assert absence of the other org's marker.
- Do not test by adding `orgId` to command bodies or WS messages as if it were supported. The invariant is server-side session stamping, not client-provided tenant selection.
- Negative WS assertions need a bounded wait, but the real proof comes from an awaited positive delivery to the intended org followed by absence in the other collector.

## Verification gate for the implementation phase

Run exactly the requested gate after adding tests:

- `bun run check`
- `bun test`

## Abstracted concepts that should drive the plan

1. **Authority-derived tenancy**: the tenant key is derived from authenticated server state, never request parameters.
2. **Structural isolation over filters**: route to separate manager/state objects per org instead of filtering a shared roster.
3. **Bucketed broadcast domains**: sockets join immutable org buckets at handshake; events are emitted to one bucket only.
4. **Positive-signal negative testing**: first prove the intended recipient got the event, then assert non-recipients stayed silent.
5. **Narrow integration seams**: keep the live server and real registry path, but fake only manager methods unrelated to routing so tests are fast and non-flaky.
