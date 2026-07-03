# Federation: cross-host coordination over the tailnet

glance coordinates agents on **one** machine through the shared registries
in the state dir — default `~/.glance`, legacy `~/.omp/squad` (presence +
leases, one file per claim, heartbeat-TTL).
Federation promotes that coordination **across machines** over a Tailscale
tailnet, so two operators working the same repo from different hosts see each
other's agents and file leases.

```
 host A                         coordinator                    host B
 ┌───────────────┐    ws        ┌───────────┐      ws       ┌───────────────┐
 │ glance up  │─presence────▶│  relay    │◀────presence──│ glance up  │
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
# → glance coordinator listening on ws://127.0.0.1:7900
```

The relay **binds `127.0.0.1` by default** and ships a **pre-shared-token auth gate**.
Without a token any peer that can reach the port snoops every presence/lease frame
and can spoof/impersonate, so:

- **Loopback (default):** no token needed — only this host can reach it.
- **Exposed (`OMP_SQUAD_COORDINATOR_HOST=0.0.0.0`):** set `OMP_SQUAD_COORDINATOR_TOKEN`
  on the coordinator **and** on every client (the daemon, `federation-sync`, and the
  command center read the same env var). A non-loopback bind with no token is **refused**
  unless you set `OMP_SQUAD_INSECURE=1` to lean on tailnet ACLs alone, deliberately.

```sh
OMP_SQUAD_COORDINATOR_HOST=0.0.0.0 \
OMP_SQUAD_COORDINATOR_TOKEN=$(openssl rand -hex 32) \
OMP_SQUAD_COORDINATOR_PORT=7900 bun src/coordinator-main.ts
# → glance coordinator listening on ws://127.0.0.1:7900 (token-gated)
```

Put it on a Tailscale node and point every operator at its tailnet address.
WireGuard encrypts the wire; the token gates who may join; Tailscale ACLs gate who
can reach it; identity is the tailnet SSO login resolved via `tailscale whois` (see
`federation.ts`). The token is presented over the WS handshake as the `ompsq-token`
subprotocol, exactly like the daemon's bearer token.

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

Capability metadata is a separate, safer surface: **`GET /api/federation/capabilities`**
returns enabled pack id/source/framework/slug/version/checksum/title/description,
compatibility, and declared context summary only. It deliberately excludes source
files, tenant install bindings, transcripts, and exported context. Context sharing
requires an enabled `CapabilityContextPolicy` with explicit namespaces, redaction,
retention, peer allowlists, and audit.

Public capability discovery is intentionally separate from federation:
`GET /api/capability-catalog` returns built-in catalog metadata — profiles,
workflows, tools, skills, required env, checksums, and descriptions — that an
admin can import into the local trusted source list. Catalog visibility does not
enable a capability, install it, or expose tenant files.

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

## 5. `LocalFederationBus` — the daemon default

`LocalFederationBus` is the **default bus** since federation shipped. It provides:

- **Single-host loopback** — on every pub/sub call it fires local subscribers immediately
  (your own roster, presence, and leases are live and observable in-process without any
  coordinator). The `NullFederationBus` is explicitly opted in with `OMP_SQUAD_FEDERATION=0`.
- **Cross-host extension** — when `OMP_SQUAD_COORDINATOR` is set it additionally opens a
  `TailnetFederationBus` to that coordinator; local publishes are forwarded to peers and
  inbound peer frames fan out to local subscribers + update the `PeerRoster`.
- **Resilient startup** — a bad/unreachable coordinator never throws or blocks `start()`; the
  inner Tailnet bus reconnects on its own capped backoff (500 ms → 30 s).

The daemon auto-starts `federation-sync` (cross-host lease gossip) in file mode when a
coordinator URL is configured — no companion process needed.

## Status

- ✅ Coordinator relay — built, tested.
- ✅ Lease gossip protocol + reconnect re-announce — built, tested.
- ✅ Cross-host repo identity — built, tested.
- ✅ `federation-sync` publish + mirror — built, tested end to end.
- ✅ `LocalFederationBus` as the daemon default — single-host works with zero config.
- ✅ Cross-host collision detection keyed on **normalized git origin URL** (`repoId` on
  `AgentDTO`) — same-GitHub-repo / different-machine checkouts now collide; same-basename
  unrelated repos no longer false-collide.
- ✅ `/api/federation`, `/api/leases`, `/api/fabric` — real data (per-org scoped in DB mode).
- ✅ Daemon auto-start of `federation-sync` when a coordinator is configured.
- ✅ Remote steering — outbound `sendCommand` + `POST /api/federation/command`, addressed
  frames, coordinator ip-stamping, reply/ack channel, Federation-panel steer UI; a
  two-daemon E2E over a real coordinator pins the wire path + viewer security floor (§6).
- ⏳ Delegation/availability policy — verified peers stay viewer until authz.ts grows a
  backing system; granting more is deliberately NOT modeled yet.
- ⏳ `tailscale whois` on a REAL tailnet — see the second-host runbook (§7). The whois call
  is timeout-bounded (3 s) so a missing binary can't stall inbound command processing.

## 6. Remote steering (send side + ack) — live

Both halves exist now. Sending:

```bash
# From alice's daemon, steer bob's agent (operator-tier token required):
curl -X POST "$ALICE/api/federation/command" \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"to":"bob","cmd":{"type":"prompt","id":"<bob-agent-id>","message":"run the tests"}}'
# → { ok, sent, to, cmdId, ack: { outcome: "applied"|"denied"|"error", detail? } | null }
```

- Frames are **addressed** (`to`): peers drop commands not meant for them.
- The coordinator **stamps the sender's real socket address** as `ip` on command frames
  (any client-sent `ip` is overwritten) — the receiver's `tailscale whois <ip>` therefore
  verifies the true sender, never a claimed identity. `whois` is bounded at 3 s; timeout ⇒
  unverified.
- The receiver authorizes independently at `applyCommand`: an unverified (or verified but
  role-less) peer is **viewer** — mutating commands are denied until a delegation policy
  exists. Sending grants nothing; the security floor is pinned by
  `tests/federation-e2e.test.ts` (two live managers over a real coordinator).
- The ack is advisory (it resolves a local waiter and a UI toast; it carries no authority).
  `ack: null` after ~4 s ⇒ sent, peer offline or older version.
- UI: the command center's Federation panel has an inline **steer** input per peer agent.

## 7. Second-host runbook (real tailnet)

What the single-host E2E cannot cover is `tailscale whois` resolving a REAL peer IP. To
bring up a genuine two-host federation:

1. **Both hosts on one tailnet.** Install tailscale, `tailscale up`, confirm each host can
   `ping` the other's 100.x address and that `tailscale whois <peer-ip>` prints the peer's
   SSO login. That login string is the verified `Actor.id` commands arrive under.
2. **Deploy the coordinator** on either host (or any third tailnet node):
   `OMP_SQUAD_COORDINATOR_HOST=0.0.0.0 OMP_SQUAD_COORDINATOR_TOKEN=<shared> bun src/coordinator-main.ts`
   (a non-loopback bind REFUSES to start without a token).
3. **Point both daemons at it:** `OMP_SQUAD_COORDINATOR=ws://<coordinator-tailnet-ip>:7900`
   `OMP_SQUAD_COORDINATOR_TOKEN=<shared>` — restart each daemon; boot logs show the bus
   connecting, and each Federation panel lists the other operator within one presence tick.
4. **Verify the trust boundary before granting anything:** steer a peer agent from the
   panel — expect the toast `Peer denied it: … requires operator …`. That denial is the
   system working: identity resolved (check the peer's audit log actor id = your tailnet
   login), authority correctly withheld. Granting verified peers more than viewer is the
   deferred delegation-policy work (authz.ts) — do NOT shortcut it by trusting wire roles.
5. **Collision check:** open the same GitHub repo on both hosts on the same branch — the
   Federation panel should flag the shared-branch collision keyed on the normalized origin
   URL, not the host paths.
