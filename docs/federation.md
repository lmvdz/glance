# Federation: cross-host coordination over the tailnet

omp-squad coordinates agents on **one** machine through the shared registries
under `~/.omp/squad` (presence + leases, one file per claim, heartbeat-TTL).
Federation promotes that coordination **across machines** over a Tailscale
tailnet, so two operators working the same repo from different hosts see each
other's agents and file leases.

```
 host A                         coordinator                    host B
 ┌───────────────┐    ws        ┌───────────┐      ws       ┌───────────────┐
 │ omp-squad up  │─presence────▶│  relay    │◀────presence──│ omp-squad up  │
 │ federation-   │─leases──────▶│ (fan-out) │─────leases───▶│ federation-   │
 │   sync        │◀─leases──────│           │◀────leases────│   sync        │
 └───────────────┘              └───────────┘               └───────────────┘
```

## 1. The coordinator (`coordinator.ts` / `coordinator-main.ts`)

A dumb, protocol-agnostic WebSocket relay: every frame received from one client
is rebroadcast verbatim to every **other** client. It never parses frames, so
the wire protocol stays owned by the buses. Run one anywhere on the tailnet:

```sh
OMP_SQUAD_COORDINATOR_PORT=7900 bun src/coordinator-main.ts
# → omp-squad coordinator listening on ws://127.0.0.1:7900
```

Put it on a Tailscale node and point every operator at its tailnet address.
WireGuard encrypts the wire; Tailscale ACLs gate who can reach it; identity is
the tailnet SSO login resolved via `tailscale whois` (see `federation.ts`).

## 2. Cross-host file leasing (`federation-sync.ts` / `-main.ts`)

Leasing already prevents two agents on one host from clobbering the same file
(advisory soft-block-with-override; see the lease-hook). `federation-sync`
extends that across hosts, **decoupled from the daemon** — it works purely off
the on-disk registries:

- **publish** — every tick it reads *this operator's own* live leases per repo
  and gossips them, keyed by the repo's **cross-host identity** (the normalized
  git origin URL — `git@github.com:acme/app.git`, `https://github.com/acme/app`,
  and `ssh://git@github.com/acme/app.git` all collapse to `github.com/acme/app`).
  It never re-broadcasts leases it mirrored from a peer.
- **mirror** — a peer's leases for a repo you *also* have locally are written
  into your local lease registry (preserving the remote operator/host). From
  there everything just works: the lease-hook's `holdersOf` warns when you edit
  a file a remote teammate holds, and the command center's "Files in flight"
  panel shows it. The TTL prunes a mirrored lease once the peer stops gossiping.

```sh
OMP_SQUAD_COORDINATOR=ws://<coordinator-host>:7900 \
OMP_SQUAD_OPERATOR=alice \
bun src/federation-sync-main.ts
# watches the cwd repo + $OMP_SQUAD_FED_REPOS (comma-separated) +
# every repo discovered in the local presence registry
```

Repo identity uses `git config --get remote.origin.url` (the raw configured URL,
**not** `git remote get-url`, which expands per-machine `insteadOf` rewrites) so
two hosts that cloned the same origin agree. A repo with no origin falls back to
`name:<dir>` — best-effort, advisory only.

## 3. Presence

The squad daemon already publishes its operator presence to the coordinator via
its own bus (`TailnetFederationBus`, wired in `squad-manager`); `mergeRosters` /
`detectCollisions` (in `federation.ts`) fold peer rosters into a roster-of-rosters
and flag repos where agents owned by different operators share a branch.

The local command center surfaces this through **`GET /api/federation`** (bearer-gated
like the rest), which returns `{ coordinator, operators, collisions }` —
`federationView` (self + peers merged via `mergeRosters`, branches shared across
operators flagged via `detectCollisions`). The server reaches peer rosters with a
listener-only `PeerPresenceTracker` (a second, read-only `TailnetFederationBus`
connection that never publishes), created in `server.start()` only when
`OMP_SQUAD_COORDINATOR` is set; stale peers prune at the 90s presence TTL. The web
dashboard renders it as the **Federation** panel — peer operators + their agents
plus any shared-branch collisions — hidden whenever no coordinator is configured
or there is nothing remote to show. Best-effort throughout: with the coordinator
unset the feed is absent, the endpoint returns just `self` (no peers, no
collisions), and nothing errors.

## 4. Remote commands are viewer-only (trust boundary)

The coordinator is a content-blind relay, so **every byte of a `{kind:"command"}`
frame is peer-controlled** — including the `actor.role` and `actor.origin` fields.
The receive path therefore NEVER trusts them. `TailnetFederationBus.resolveActor`
stamps the actor via `remoteCommandActor`, which:

- forces `origin: "remote"` and drops any wire-asserted `role`, so `effectiveRole`
  resolves the peer to the read-only **`viewer`** tier (reads + transcript
  subscription only — never kill/restart/remove/create/commission);
- takes identity **only** from the tailnet (`tailscale whois <peer-ip>`); the
  claimed id is kept solely for audit when no IP can be verified.

The manager's single `applyCommand` chokepoint then enforces the tier, so a peer
cannot self-grant `admin`/`local` and drive the local fleet (OMPSQ-162). Granting
a remote peer more than `viewer` requires a transport that *verifies* a role — the
wire claim alone is ignored.

## Status

- ✅ Coordinator relay — built, tested.
- ✅ Lease gossip protocol + reconnect re-announce — built, tested.
- ✅ Cross-host repo identity — built, tested.
- ✅ `federation-sync` publish + mirror — built, tested end to end (a peer's
  lease blocks a local omp agent's edit, which overrides on re-issue).
- ✅ Surfacing **remote presence** in the local command center — `GET /api/federation`
  + the Federation panel, fed by the listener-only `PeerPresenceTracker`. Cross-operator
  branch collisions key on the host-local repo path (`detectCollisions` over `AgentDTO.repo`),
  so they fire reliably for same-path checkouts; full cross-host collision matching still
  wants a normalized `repoId` on `AgentDTO`.
- ⏳ Daemon auto-start of `federation-sync` is a one-liner in `server.start()`
  once the daemon entry settles; today run it as the companion process above.
