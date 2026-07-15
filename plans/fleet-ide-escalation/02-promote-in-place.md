# E02 — promote in place (chat → gated landable unit)

STATUS: open
PRIORITY: p2
REPOS: omp-squad + glance-desktop
COMPLEXITY: architectural
TOUCHES: omp-squad src/server.ts (POST /api/agents/:id/promote) + src/squad-manager.ts (the re-wire) + src/schema/ (body) + tests; glance-desktop src/modules/ai/ (Promote button) + src/modules/fleet/lib/fleetClient.ts (promote method)
BLOCKED_BY: E01

## Goal

Turn a chat into a work unit **without changing windows, and without losing the conversation**. A daemon-backed chat (E01) is already a console unit with a worktree and a live ACP session; "Promote to unit" re-wires that same unit into a gated, landable work unit — the agent keeps its exact context and worktree, and now runs the verify loop and can land. This is the reverse of intervene (I05): intervene drops the human into a running unit; promote lifts a chat up into one.

## Ground truth (recon first)

- Promote must be **in place**, not a fresh spawn: seeding a new unit's transcript is theater (see 00-overview — the harness owns its context, the daemon transcript is a mirror). The console unit already holds the real ACP session, so re-wiring it is the only faithful path.
- What "promote" must change on the record (verify each against `src/squad-manager.ts` + `src/autonomy.ts` + `src/intake.ts` before implementing):
  - **Clear the console restriction**: the unit was created with `appendSystemPrompt: CONSOLE_SYSTEM_PROMPT` (`src/server.ts:193`) which forbids commits/worktrees/features. Promotion must lift that so the agent may actually do the work. Confirm whether `appendSystemPrompt` is mutable post-create or whether it's only applied at session start — this determines whether promote can re-brief the live session or must issue a steering turn that supersedes the restriction.
  - **Wire a gate**: a console unit has `autoRoute:false` ⇒ no verify workflow. Promotion runs the same routing a task-spawn would (`routeIntake`/`detectVerify`, `src/intake.ts:63,157`) to attach a verify loop when the repo has a detectable verify command. Honesty: if no verify command is detectable, the unit is landable-but-ungated (manual admin land only) — same semantics as any gate-less spawn; the concern must NOT claim a gate it didn't wire.
  - **Flip autonomy**: console/chat likely runs at a conservative mode; promotion sets it to the operator-chosen mode (assist/autodrive) via the existing `POST /api/agents/:id/mode` machinery (`src/server.ts:2044`, `src/autonomy.ts`).
  - **Landability**: `isLandingUnit` (`src/is-landing-unit.ts:60`) is already true for a plain unit; confirm the promoted unit qualifies (not observe-mode, not flue).
- Auth: promote drives a unit the operator already owns → **operator** tier (matches create/prompt). Landing the result stays **admin** (unchanged; DB-mode org members can promote but not land — state this in the PR).

## Approach

1. Daemon: `POST /api/agents/:id/promote` with a Schema-decoded body `{ mode?, verify?, task? }` (task = an optional one-line objective to focus the promoted unit). In `SquadManager.promote(id, opts, actor)`: assert the unit is a console/chat unit, atomically clear the console restriction, wire the verify workflow (routeIntake or explicit `verify`), flip autonomy, persist. Return the updated `AgentDTO`. Emit an audit/automation-log line (promote is a state transition worth recording).
2. Guard rails: refuse promoting a non-console unit, a flue/observer unit, or a unit already mid-workflow. Make the re-wire atomic — a half-promoted unit (restriction cleared but no gate) is the dangerous state; either fully promote or leave the console unit untouched and return the error (mirror I05's recoverable-phase discipline).
3. Cockpit: `FleetClient.promote(id, opts)` → the endpoint. A "Promote to unit" affordance in the daemon-mode chat panel; on success, open the unit's worktree as a Space via `getWorktreeOpener()` (C06) and drop the user into the intervene pane (they're now supervising a real unit). Reflect the new gate/verify state in the roster.

## Cross-lineage review (REQUIRED — WRITE to run-state + gate wiring)

Before the PR: codex (`codex exec -s read-only`) AND grok (`grok -p ... --sandbox read-only`) on the promote re-wire. Specific hazards to point them at: (a) the half-promoted state (restriction lifted, gate not wired) — is the re-wire truly atomic? (b) can promote be used to escalate a unit the actor doesn't own, or a DB-mode cross-tenant unit? (c) does clearing `appendSystemPrompt` actually reach the live harness session, or is it a no-op that leaves the agent still refusing to work? (d) does the verify wiring fire on a unit that already has divergent worktree state from the chat phase?

## Acceptance

- A daemon-backed chat, promoted, becomes a gated landable unit that keeps its worktree and transcript; the agent (previously refusing under the console prompt) now performs work. RAN / result (live, scratch-daemon).
- Promoting when no verify command is detectable yields a landable-but-ungated unit and the UI says so (no false "gated" claim). RAN / result.
- Refusals: non-console unit, cross-owner, DB-mode land all behave as specified. RAN / result.
- Gate (both repos): omp-squad bun test + scratch-daemon live; glance-desktop tsc+lint+vitest+build. Cross-lineage findings fixed+pinned.

## Non-goals / deferred

- Promoting a purely-local BYOK chat (one that was never a daemon unit) — a *fallback* path that would digest→`create` a fresh briefed unit (accepting the context loss). Note it as a secondary affordance if cheap; it is NOT the spine and must be labelled as re-brief, not continuation.
- Adoption of external sessions (E03).
