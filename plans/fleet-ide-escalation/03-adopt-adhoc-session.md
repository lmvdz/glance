# E03 — adopt an ad-hoc CLI session

STATUS: in-review (daemon omp-squad#187 + cockpit gd#22) — cross-lineage-hardened (codex+grok), 8 findings fixed+live-verified
PRIORITY: p3
REPOS: omp-squad + glance-desktop
COMPLEXITY: architectural
TOUCHES: omp-squad src/server.ts (POST /api/agents/adopt) + src/squad-manager.ts / a new intake helper (diff capture → worktree → apply → briefed unit) + src/schema/ + tests; glance-desktop src/modules/fleet/ (adoptable-session surface + Adopt action) + fleetClient.ts
BLOCKED_BY: B03 (merged)

## Goal

A developer starts `claude` (or another harness) in a terminal, outside the cockpit, and does real work. Epic B's hooks already make the daemon *aware* of that session (presence `harness:<sessionId>`, source "other"). "Adopt" turns that awareness into a handle: capture the session's uncommitted work into an isolated worktree, wrap it in a gated fleet unit, and let the developer supervise/land it like any other unit — without losing what they already did.

## Ground truth (recon first — this is the highest-risk concern)

- **All the daemon has today is identity, not substance** (`src/harness-hooks.ts`, `src/presence.ts:28`): `harness` (e.g. `"claude-code"`), `sessionId`, `cwd` (resolved to a registered project root), and heartbeat. **No diff, no transcript, no real session PID** (the stored `pid` is the daemon's own). So "adopt" cannot recover the conversation — it can only recover the **working tree state** at the cwd. Set expectations accordingly: adoption captures *work*, not *context*; the adopted unit is briefed ("a developer did X here, continue"), it does not inherit the ad-hoc agent's memory.
- The cwd is typically the developer's **main checkout**, not an isolated worktree. Adoption must NOT run a new agent in that live dir (it would collide with the human and with `git worktree` assumptions). The honest flow: `git diff` (+ untracked) in cwd → cut a fresh `squad/<id>` worktree from the same HEAD → apply the captured patch there → create a briefed gated unit rooted in the new worktree. The developer's original checkout is left untouched.
- Existing substrate to reuse, not rebuild: worktree creation (`resolveWorktree`, `src/worktree.ts:206`), the create chokepoint (`createWithId`), the verify routing (`routeIntake`). The genuinely new daemon code is **diff capture + patch apply into the fresh worktree** — there is no diff-intake path today (confirmed absent).
- Edge cases to design against up front: a dirty index vs working tree, untracked files, binary diffs, a cwd whose HEAD diverged from origin, a patch that fails to apply cleanly (must fail closed — no partially-applied worktree presented as a clean unit). Path-safety on `cwd`/`sessionId` (they come from a client; same class as the B03 sessionId→filename traversal already hardened).

## Approach

1. Daemon: `POST /api/agents/adopt` Schema body `{ harness, sessionId, cwd }` (or `{ presenceId }` resolving to those). Verify the cwd matches a live B03 presence entry for that harness/session (don't adopt an arbitrary attacker-supplied path — reuse `harnessEventDecision`'s "must be a registered project" gate). Capture the diff, cut the worktree, apply, `create({ repo, existingPath: <new worktree>, task: <brief>, autoRoute:true })`, return the `AgentDTO`. Fail closed on any apply conflict.
2. Cockpit: surface adoptable sessions — presence entries with source "other" and a `harness:<sessionId>` label that aren't already fleet units — in the fleet roster (a distinct "ad-hoc" section) and/or the fleet bell. An "Adopt" action calls `FleetClient.adopt(...)`; on success open the new worktree as a Space + intervene pane.

## Cross-lineage review (REQUIRED — git-write + spawn)

codex AND grok before the PR. Hazards: (a) patch capture/apply correctness (untracked files, binary, index vs worktree, CRLF); (b) can `cwd` be spoofed to capture/apply a diff from a path the actor shouldn't reach (cross-tenant, outside any project)? (c) fail-closed on apply conflict — is there ANY path that presents a half-applied worktree as a clean adopted unit? (d) does adoption ever touch the developer's original checkout (it must not)? (e) resource/DoS on a huge diff.

## Acceptance

- A `claude` session started in a registered project, with uncommitted work, appears as adoptable in the cockpit; adopting it produces a fresh-worktree gated unit whose tree matches the captured diff, leaving the original checkout untouched. RAN / result (live, real ad-hoc claude session + scratch-daemon).
- A patch that won't apply cleanly fails closed with a clear error and creates no unit. RAN / result.
- Spoofed/out-of-project cwd is refused. RAN / result.
- Gate (both repos) green; cross-lineage findings fixed+pinned.

## Non-goals / deferred

- Recovering the ad-hoc session's *conversation* (impossible from presence alone — the harness transcript isn't exposed to the daemon). If a future B-epic concern streams harness transcripts to the daemon, richer adoption becomes possible; out of scope here.
- Adopting non-`verified` harnesses (only `claude-code` reports via hooks today).
- This concern is p3: Epic E's chat↔unit core (E01 + E02) delivers the headline value without it. Adopt is the "meet developers where they already are" extension.
