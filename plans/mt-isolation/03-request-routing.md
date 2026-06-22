# Request routing & per-org WebSocket broadcast
STATUS: todo
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/server.ts, src/types.ts

## Decision

The server stops holding one `manager` and instead routes every request/command to
`registry.get(actor.orgId)` (DB mode) or the single root manager (file mode). The caller's
`orgId` is **derived server-side from the better-auth session** — never read from a request
param, query, or body. WS events fan out **per org** so a socket only ever sees its own org's
roster/agents/transcripts.

This concern splits into **03a** (the `Actor.orgId` type change — tiny, unblocks 01) and **03b**
(server routing + per-org WS — depends on 01).

## 03a — Actor carries orgId (P2 owns this)

`Actor` (types.ts:467) today has `id / displayName / origin / role` and **no `orgId`**
(confirmed with MtHarden — P1-hardening does not add it). Add:

```ts
export interface Actor {
  id: string;
  displayName?: string;
  origin: "local" | "remote";
  role?: Role;
  /** Org whose fleet this actor acts on (DB mode). Absent => file mode / no active org. */
  orgId?: string;
}
```

This is the routing key. It is the *only* type change in 03a; ship it first so 01 can compile.

## 03b — Server resolution & routing

Today the server reads the session and computes a `Role` via `bridgeRole`, then **discards the
org**: `bridgeRole(req, session.session.activeOrganizationId)` returns only a `Role`
(server.ts:180-187, 262, 293), and `actorForRole(role)` (used at server.ts:232, 519) makes an
actor with no org. Change:

1. **Capture orgId alongside role.** Wherever the server resolves a DB-mode session
   (handle() at server.ts:255-266 for `/ws`; 290-296 for REST), keep
   `const orgId = session.session.activeOrganizationId ?? undefined` next to the bridged role.
2. **Build an org-stamped actor.** Replace `actorForRole(role)` in DB mode with an actor that
   carries the user id, role, and orgId — e.g. `{ id: "db:" + session.user.id, displayName:
   session.user.name, origin: "local", role, orgId }`. Keep `actorForRole(role)` (no orgId) for
   file mode (server.ts:519 / the 232 file-mode branch).
3. **Route to the manager.** Add a private helper
   `private async managerFor(actor: Actor): Promise<SquadManager | null>`:
   - file mode → the single root manager (today's `this.manager`).
   - DB mode + `actor.orgId` → `await this.registry.get(actor.orgId)`.
   - DB mode + no `orgId` → `null` (no fleet — see "No active org").
   Replace the ~30 `manager.<x>()` call sites in `handle()` (server.ts:317-520) and the WS
   `message` handler (server.ts:232) with `const m = await this.managerFor(actor); if (!m) …`.

The `SquadServer` constructor (server.ts:122,156) takes a `ManagerRegistry` instead of (or in
addition to, for file mode) a `SquadManager`. `index.ts` (215) passes the registry in DB mode,
the single manager in file mode.

## No active org (viewer / no fleet)

P1-hardening makes `bridgeRole` return **viewer** when there is no active org (was operator) —
P2 must align. An authenticated user with `activeOrganizationId == null` (signed in, not in /
hasn't selected an org — the SPA already renders "create an organization" at index.html:1072):
- `managerFor` returns `null`. Do **not** lazily create a manager for a null org.
- REST reads (`/api/agents`, `/api/projects`, `/api/features`) return `[]` / empty.
- REST mutations and WS commands → `403` / no-op (role is viewer anyway; `commandRole` mutations
  need operator, so `applyCommand` would deny — but short-circuit before reaching a manager).
- `/api/me` already returns `activeOrganizationId: null` (server.ts:303); the SPA shows the
  no-org state. WS `open` sends an **empty** roster.

## Per-org WS broadcast (the leak fix)

Today: `clients: Set<ServerWebSocket<SocketData>>` (server.ts:123); `open` sends
`manager.list()` to the joining socket (server.ts:208); `broadcast(e)` sends to **every** socket
(server.ts:525-533); the manager's `onEvent` is `e => this.broadcast(e)` (server.ts:158).
With one shared manager this fans every org's events to every client. Change:

1. **Tag the socket with its org.** Add `orgId?: string` to `SocketData` (server.ts:48). Set it
   at upgrade: the `/ws` handler already resolves the session (server.ts:261); pass
   `data: { id, role, orgId }` into `server.upgrade` (server.ts:267-269).
2. **Bucket sockets by org.** Replace the single `clients` set with
   `private readonly clientsByOrg = new Map<string, Set<ServerWebSocket<SocketData>>>()`
   (file mode uses a single bucket keyed by a sentinel, e.g. the empty string). `open` adds to
   `clientsByOrg.get(ws.data.orgId)`, `close` removes (and drops empty buckets).
3. **Per-org fan-out.** The registry (01) calls back into the server per manager event with the
   org: `registry.onEvent = (orgId, e) => this.broadcastTo(orgId, e)`. `broadcastTo(orgId, e)`
   serializes once and sends only to `clientsByOrg.get(orgId)` (preserving the roster
   version-stamp logic at server.ts:527 and the `maybePushAlert`/`schedulePresence` calls at
   534-535, now scoped per org). File mode keeps the single-bucket `broadcast`.
4. **`open` sends only this org's roster.** `manager.list()` becomes
   `(await this.managerFor(actor))?.list() ?? []` for the joining socket's org (server.ts:208-212).
5. **Transcript subscribe stays unicast** (server.ts:225-229) but reads from the socket's org
   manager: `(await this.managerFor(actorForSocket(ws)))?.getTranscript(cmd.id)`. An id from
   another org simply isn't in this manager → empty replay (structural deny).

## Push alerts (scope or note)

`maybePushAlert` (server.ts:525→) and `PushService` subscriptions are daemon-global today
(constructed `new PushService(stateDir)` at index.ts:212). A push payload carries an agent name
(`escalationPayload`), so global push would leak names across orgs. For v1: either (a) scope push
subscriptions by org (store the subscriber's orgId with the subscription and only notify
matching subscribers), or (b) in DB mode disable background push and rely on in-app WS signals.
Recommend (a) as a small follow-up; **ship (b) for P2** (ponytail: don't expand push storage in
the isolation PR) and note (a) as the upgrade. Mark with a `ponytail:` comment.

## Edge cases
- **Org switch mid-session.** A user switching active org (index.html `orgSwitch`) gets a new
  `activeOrganizationId` on the next request; their next WS connection lands in the new org's
  bucket. Existing sockets keep their original org until reconnect — acceptable (the SPA
  reconnects on org switch). Document; don't hot-migrate sockets.
- **Concurrent first request for an org** races `registry.get` — `get` must be idempotent
  (single in-flight create per org; see 05).
- **Federation `bus.onRemoteCommand`** (squad-manager.ts:224) routes to one manager — in DB mode
  the bus is per-manager `NullFederationBus` (01/06), so this path is inert. File mode unchanged.

## Verify
- `tests/routing.test.ts`: stub `AuthInstance.getSession` to return org A vs org B; assert
  `GET /api/agents` returns only the caller's org's agents; a request that puts `?org=B` in the
  URL is ignored (org comes from session). No-org session → empty list + 403 on mutation.
- `tests/ws-org-isolation.test.ts`: two sockets (org A, org B) on one server; `create` an agent
  in org A; assert the org-B socket receives **no** `agent`/`roster` event mentioning it, and the
  org-A socket does; `subscribe` to org A's agent id from the org-B socket replays nothing.
