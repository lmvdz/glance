# I02 — cockpit presence + lease WRITE

STATUS: done (PR #182, merged)
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/server.ts (new POST routes), src/schema/http-body.ts (bodies), src/authz.ts (tier), src/presence.ts + src/leases.ts (reuse claim/heartbeat/release, claimLease/releaseSession), tests
BLOCKED_BY: none

## Goal

The cockpit can register the HUMAN as present in a unit's worktree and as holding a file — so the running agent's advisory lease-hook sees "a human is here / editing this file", and other surfaces (`glance who`, the roster) show the operator as a peer. This is what makes intervention a SHARED workspace rather than a one-way steer: presence flows both directions.

## Ground truth

- Presence + leases are GET-only over HTTP (`/api/presence` `src/server.ts:1875`, `/api/leases` `src/server.ts:767`). The claim/heartbeat/release primitives EXIST (`src/presence.ts` claim/heartbeat/release; `src/leases.ts` claimLease/holdersOf/heartbeatSession/releaseSession) but are reachable today only via the in-agent omp hook — no HTTP write path for an external client (the cockpit).
- `PresenceEntry.source` already has an `"other"` variant (`src/presence.ts`) — the cockpit registers as `source:"other"`, `agent:"glance-cockpit:<sessionId>"` (the same shape B03 used for harness events).

## Approach

- `POST /api/presence` — claim/refresh a presence entry: body `{repo, agent, branch?, task?, id?}` → `claim({...source:"other"})`, returns the claim id. `DELETE /api/presence?id=&repo=` → `release`. Heartbeat = repeat POST with the same id (claim is create-or-refresh).
- `POST /api/leases` — claim/refresh a file lease: body `{repo, file, session, id?}` → `claimLease`. `DELETE /api/leases?...` → `releaseSession`. So the cockpit can mark the file the human is editing.
- **Scope + safety** (mirror B03's discipline): drop/deny writes whose `repo` is not a registered project (the daemon is the scope authority); bodies through Effect Schema decode (never cast — `HarnessEventBodySchema` is the template in `src/schema/http-body.ts`); refuse in DB/registry mode (presence is suppressed there anyway — `/api/presence` returns `[]` under a registry). Authz tier: **operator** (a presence/lease WRITE mutates the shared roster — same reasoning as B03's harness-events bump).
- Cockpit side (lands with I04/I05, but the endpoint is I02): when a worktree Space is open for a unit, heartbeat presence; when the editor focuses a file in that worktree, claim its lease; release on close.

## Acceptance

- Unit tests: schema decode accepts a well-formed body, 400s a malformed one; a write for an UNregistered repo is dropped; DB/registry mode 403s; authz requires operator.
- Live (scratch-daemon): register a project, POST /api/presence → appears in `GET /api/presence?repo=`; POST /api/leases → appears in `GET /api/leases?repo=` with the right `file`; DELETE removes them; a write for an unregistered cwd is dropped.

## Review

Cross-lineage (codex + grok) before shipping — this is a WRITE to shared multi-session state with an auth tier and a scope gate, the same class as B03. Watch for: scope-gate bypass, tier too low, session-id collision across cockpit instances, DB-mode leak.
