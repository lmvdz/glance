# M02 — cross-host merged fleet view

STATUS: open
PRIORITY: p3
REPOS: glance-desktop
COMPLEXITY: architectural
TOUCHES: src/modules/fleet/store/fleetRosterStore.ts (poll N daemons, merge), FleetUnit (daemon/host tag), RosterView (host grouping/badge), the attention/bell lanes (daemon-scoped)
BLOCKED_BY: M01

## Goal

The fleet roster spans every connected daemon: units from all hosts in one attention-ranked view, each tagged by which daemon/host it lives on. Supervising a fleet across a laptop + a workstation + a remote box becomes one screen.

## Ground truth (recon first)

- `fleetRosterStore.ts` today re-derives the single URL/token and polls one `GET /api/agents` with module-level `timer`/`inFlight`/`notifiedAttention` (one per app). It does NOT read the connection store — it uses the globals directly. M02 generalizes it to poll each connection from M01's list and merge.
- Attention rank / sort (`fleetRoster.ts`) is pure and per-unit — it works unchanged on a merged list once each unit carries a daemon tag for disambiguation (unit ids can collide across daemons).

## Approach

1. Add a `daemonId` (+ display host/label) to each `FleetUnit` as it's ingested, so merged units are disambiguated and actions route back to the right daemon's client.
2. Generalize the poller: one poll cycle fans out to every connected daemon (M01's list), each with its own client, and merges results into one roster; a per-daemon failure degrades that host only (keep the others), not the whole view.
3. The attention bell / OSC lane becomes daemon-scoped (dedupe `notifiedAttention` by `daemonId:unitId`).
4. RosterView groups or badges by host; intervene/steer/takeover route through the unit's `daemonId` client (not "the active daemon").

## Acceptance

- Two daemons connected → the roster shows units from both, host-badged, attention-ranked across hosts; one daemon going unreachable degrades only its rows. RAN / result (two scratch daemons).
- Intervening on a unit targets its OWN daemon (not the active one). RAN / result.
- Gate: tsc + lint + vitest + build. Merge/dedupe logic unit-tested.

## Non-goals / deferred

- A single global "land train" across hosts (each daemon lands its own units).
- Cross-daemon unit migration.
