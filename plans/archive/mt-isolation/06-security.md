# Security — isolation invariants & the P3 seam
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/server.ts, src/squad-manager.ts, src/dal/store.ts

## The invariant P2 must guarantee (and P3 enforces on top)

**I1 — Tenant isolation.** An actor with `orgId = A` can never read or mutate any agent,
transcript, feature, receipt, worktree, audit/usage row, or event belonging to `orgId = B`.

**I2 — Server-derived org.** An actor's `orgId` is derived from the better-auth session
(`session.session.activeOrganizationId`, server.ts:261/293), **never** from a request param,
query, header, or body. A client cannot select another org by crafting a request.

**I3 — No ambient cross-org authority.** There is no code path (federation, CLI, supervisor,
janitor) that can issue a mutation against an org the actor is not a member of.

## Enforcement chokepoints (defense in depth)

1. **Routing chokepoint (server, 03).** The *only* way to reach a manager is
   `registry.get(actor.orgId)`. `actor.orgId` comes from the session (I2). A request for org B by
   an org-A user is impossible because the server never reads an org from the request — it reads
   the session's active org. **First line: you can't even address another org's manager.**
2. **Structural chokepoint (registry, 01).** Manager A's `agents` Map physically cannot contain
   org B's agents; WS events fan out per-org bucket (03). So even a *routing bug* cannot return
   B's in-memory data from A's manager — the data isn't there. **This is the property that lets
   P3 ignore org↔resource entirely.**
3. **DAL chokepoint (DbStore, 04).** Every DB read/write goes through `withOrg(ctx, orgId, …)`
   (dal/context.ts:26): Postgres sets the `app.current_org` GUC so RLS (`org_id =
   current_setting('app.current_org')`, migrations.ts rlsMigration) filters every row even if a
   query forgets its predicate; the DbStore queries *also* carry explicit `where org_id = orgId`
   so SQLite self-host (no RLS) is equally isolated (dal/context.ts:11-13). **Backstop if routing
   or the store ever passes the wrong org.**
4. **Command chokepoint (manager, P3's slot).** `applyCommand` (squad-manager.ts:943) is the
   single mutation entry for every surface and already does the RBAC tier check (943-951). It now
   also writes the audit trail (04). Because the manager is org-scoped, the only authorization
   left for P3 here is **role ↔ command** — never org ↔ resource.

## Composition with P1-hardening `bridgeRole` + loopback bootstrap

- **`bridgeRole`** (server.ts:180) maps the active-org membership role (owner/admin ⇒ admin,
  member ⇒ operator, **no active org ⇒ viewer** post-hardening) to an RBAC tier. That is the
  **within-org** axis. P2's `orgId` routing is the **across-org** axis. They are orthogonal and
  compose: `actor = { orgId: <active org>, role: <bridged tier> }`. P2 must keep bridgeRole's
  no-org⇒viewer and route no-org actors to the empty/no-fleet path (03) — a viewer with no org
  has nothing to act on.
- **Loopback / file-mode bootstrap admin.** In file mode (no auth tokens configured),
  `resolveRole`/`effectiveRole` grant **admin** to local surfaces (auth.ts `effectiveRole`:
  local ⇒ admin) over the single root manager — unchanged single-tenant behavior, no orgId.
  In DB mode there is **no loopback bypass**: auth is required, `actor.orgId` is mandatory to
  reach a fleet, and a no-org/admin-less session can only read its own (empty) view. The two
  modes never mix: file mode has one root manager and no registry; DB mode has the registry and
  no token-admin bypass. **A DB-mode request can never resolve to the file-mode admin path.**

## Cross-cutting leaks P2 must close (DB mode)

- **Global presence/leases registries (risk #6).** `~/.omp/squad/presence` + `…/leases` are
  machine-wide, keyed by repo-hash (presence.ts:11, leases.ts:9), and feed `syncPresence`
  (server.ts:571) + the federation/command-center `federationSnapshot` (server.ts:~590). In DB
  mode these would surface org A's repos/tasks/branches to org B. **Decision:** in DB mode, serve
  presence/federation **from the per-org manager's `list()`** (in-memory, already org-scoped) and
  **skip the global file registry** entirely — it is a self-host/federation convenience, not
  tenant data. So `syncPresence`/`federationSnapshot` become per-org reads in DB mode; file mode
  keeps the global registry.
- **Federation bus (risk #8).** `bus.onRemoteCommand` → `applyCommand(remote.cmd, remote.actor)`
  (squad-manager.ts:224-230) injects commands from tailnet peers. A shared/global bus has no org
  notion and would violate I3. **Decision:** in DB mode each manager gets a `NullFederationBus`
  (cross-org tailnet gossip is a separate design); the `TailnetFederationBus` stays a file-mode
  feature (index.ts:179). Defer multi-tenant federation.
- **CLI (risk #8).** The CLI verbs (add/list/prompt) authenticate with the file-mode bearer
  token (`tokenHeader` reads `access-token`) and carry no org. In DB mode the server is cookie-
  gated and org-scoped, so the CLI cannot act. **Decision:** document the CLI as a **file-mode /
  self-host tool**; DB-mode operations are web-only (a future service token + org header could
  re-enable CLI, out of P2 scope).
- **Push payloads (03).** Carry agent names; scope by org or disable background push in DB mode
  for v1 (03). Note the per-org-subscription upgrade.

## The exact P3 seam

P3 (OMPSQ-36) plugs into **`applyCommand`** (squad-manager.ts:943). After P2:
- The manager is already org-scoped, so P3's check is `authorize(actor.role, cmd.type, target)`
  — pure role↔command, using the audit trail (04) for accountability. No org check needed (I2/I3
  guarantee it structurally).
- The `audit` table (04) records `{actor, action, target, detail, at}` per org for every accepted
  mutation — P3 turns denials into audit rows too.
- Keep the chokepoint singular: every surface (WS message handler server.ts:232, REST
  server.ts:519, in-process autonomy) routes through `applyCommand` so P3 has exactly one place
  to enforce — do **not** add a second authorization site in the server.

## Verify
- I1/I2: `tests/routing.test.ts` + `tests/ws-org-isolation.test.ts` (03) — cross-org read/event
  denied; a request can't select another org via params.
- I3 / DAL backstop: `tests/dal-store.test.ts` (04) — SQLite cross-org `loadAgents` returns
  empty even though both rows share one DB (proves the explicit predicate, not just RLS).
- Audit: a mutation through `applyCommand` writes one `audit` row under the actor's org and none
  under another org.
- Presence: in DB mode, `/api/presence` / federation snapshot for org A contains no org-B repo.

## Resolution

DONE — overview Plane tracking says OMPSQ-37/P2 landed, including OMPSQ-47. P3 OMPSQ-36 also landed, and the recorded gate passed: `bun run check` + `bun test` → 417 pass / 0 fail.
