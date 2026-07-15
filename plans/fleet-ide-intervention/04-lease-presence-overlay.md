# I04 — lease + presence overlay (who holds which file)

STATUS: in-review (glance-desktop#17)
PRIORITY: p2
REPOS: glance-desktop
COMPLEXITY: architectural
TOUCHES: src/modules/fleet/ (a leases/presence client + store, an overlay in the intervene pane; optional editor-gutter integration)
BLOCKED_BY: none (reads the ALREADY-existing /api/leases + /api/presence; I02 enriches it with the human's own holds)

## Goal

Surface "who holds which file" in the cockpit so a human intervening in a shared worktree can see what the unit (and any other session) is touching — the file-contention awareness that makes concurrent human+agent editing safe. Starts as a panel in the intervene pane; the editor-gutter indicator is a stretch.

## Ground truth

- `GET /api/leases?repo=<abs>` → `LeaseEntry[] {id, repo, file (repo-relative), operator, session, host, since, heartbeat}` (`src/leases.ts:30-41,173`; route `src/server.ts:767`). TTL 120s — a lease is live only if heartbeated. This is the FILE-level data (presence is repo-level only).
- `GET /api/presence?repo=` → `PresenceEntry[]` (repo-level: who's working this repo at all).
- Neither is on the WS event union → **poll** (they're never pushed), same as the roster.

## Approach

- `FleetClient.leases(repo)` + `.presence(repo)`; a `fleetWorkspaceStore` polling both for the SELECTED unit's repo on ~3s while the intervene pane is open (leases change slower than the roster — 3s is fine).
- Overlay UI in the intervene pane: a compact "Working here" strip — each held file with its holder (`session` label), grouped by holder; the unit's own leases vs other sessions (incl. the human, once I02 lands) visually distinguished. Stale (TTL-expired) leases filtered client-side by `heartbeat`.
- Stretch (own concern if it grows): a gutter/badge in the terax editor when the open file is held by another session — needs the editor module's decoration API; scope only if cheap, else defer and note.

## Acceptance

- Live (scratch-daemon): seed a lease via the omp lease path (or I02's POST /api/leases) for the unit's repo → the overlay lists the held file + holder; let it TTL-expire → it drops from the overlay; a file held by the human (post-I02) shows distinctly.
- Unit tests: the stale-lease filter (drop entries older than TTL) + the holder-grouping as pure functions.
