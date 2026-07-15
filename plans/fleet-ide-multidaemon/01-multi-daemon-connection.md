# M01 — multi-daemon connection model

STATUS: in-review (gd#23) — Sonnet-implemented + reviewed (caught a legacy-token orphan bug); cockpit-only, no gauntlet
PRIORITY: p3
REPOS: glance-desktop
COMPLEXITY: architectural
TOUCHES: src/modules/fleet/lib/fleetConfig.ts (connections list), fleetKeyring.ts (per-daemon tokens), store/fleetConnectionStore.ts (N connections + active selector), src/settings/sections/FleetSection.tsx (list CRUD + switcher). FleetClient unchanged.
BLOCKED_BY: —

## Goal

The cockpit connects to N daemons instead of one. A user adds several daemons (local + remote https), each with its own label and token, and switches the active one (M02 then spans them all). This is the foundation the cross-host fleet view sits on.

## Ground truth (recon first)

- Today is a hard singleton: `fleetConfig.ts` (scalar `daemonBaseUrl`), `fleetKeyring.ts` (one fixed token account), `fleetConnectionStore.ts` (single `baseUrl` + `initPromise`), `FleetSection.tsx` (single-row form). `FleetClient` is ALREADY stateless per-instance — do not change it; generalize only the config/keyring/store/UI above it.
- Remote is just a URL variant: CSP allows `https:`, `FleetClient` is host-agnostic, worktree-open is already gated to loopback (`RosterView.tsx:135`). A remote daemon effectively requires a token (FleetSection currently calls the token "optional for a loopback daemon" — enforce/warn for remote).

## Approach

1. `fleetConfig`: replace the scalar with a `DaemonConnection[] { id, label, baseUrl }` list + an `activeDaemonId`. Migrate the existing single `daemonBaseUrl` into a one-element list on first read (don't orphan the user's configured daemon).
2. `fleetKeyring`: key tokens by daemon id (`TOKEN_ACCOUNT` → `fleet-daemon-token:<id>`); migrate the existing single token to the migrated daemon's id.
3. `fleetConnectionStore`: hold a map of per-daemon `{status, detail}` + `activeDaemonId`; `client(id?)` builds a `FleetClient` for the given (or active) daemon; probe each on add/refresh.
4. `FleetSection`: a list of daemons (add / edit / remove / set-active / test each), replacing the single-row form. Remote rows show a "remote — token required, worktree-open unavailable" hint.
5. Keep every existing single-daemon consumer working by routing through "the active daemon" until M02 makes them span.

## Acceptance

- Add two daemons, switch active, each keeps its own token; the roster/intervene panes follow the active daemon. RAN / result (needs a second daemon — a scratch daemon on another port suffices).
- The pre-existing single configured daemon + token migrate into the list with no re-entry. RAN / result.
- Gate: tsc + lint (baseline) + vitest + build. Migration + active-selector logic unit-tested.

## Non-goals / deferred

- The merged cross-host roster (M02).
- SSH tunneling (not in the fork; https only).
