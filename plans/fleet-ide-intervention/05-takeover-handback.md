# I05 — take over / hand back (the explicit peer handoff)

STATUS: in-review (gd#19 — cockpit-composed, no daemon change; daemon-atomic primitive deferred)
PRIORITY: p2
REPOS: glance-desktop, omp-squad
COMPLEXITY: architectural
TOUCHES: glance-desktop src/modules/fleet/ (a takeover control); omp-squad src/server.ts + src/squad-manager.ts (an optional takeover/handback primitive), tests
BLOCKED_BY: I02, I03, I04

## Goal

A first-class "Take over" / "Hand back": Take over pauses the agent and marks the human as driving (presence claimed, agent quiesced, mode → observe); Hand back releases the human's presence, restores the prior mode, and resumes the unit with a "continue — I edited X" prompt so its next turn picks up the human's worktree changes deliberately. This is the capstone that turns "steer + edit" into a clean peer handoff.

## Ground truth

- No single takeover primitive exists (surface map #5, #7). The PARTS exist: `interrupt` command (`src/squad-manager.ts:5225` → ACP `session/cancel`), `POST /api/agents/:id/mode` (observe/assist/autodrive, `src/server.ts:2044`) — but `transitionMode` does NOT pause a running turn (`src/squad-manager.ts:3995`); observe only GATES future actions. Presence WRITE is I02. Edits are seen next turn automatically (shared worktree).

## Approach

- **Decision to make in EXPLORE**: compose in the cockpit (call interrupt + set-mode + presence-write as separate client calls) vs. a daemon primitive `POST /api/agents/:id/takeover` / `/handback` that does it atomically + records a "human-driving" flag on the DTO. Prefer the daemon primitive IF the atomicity matters (a half-applied takeover — interrupted but mode not set — is a confusing state); otherwise compose in the cockpit and keep the daemon untouched. Lean daemon-primitive for a clean, auditable state, but confirm against the code first.
- Take over: claim presence (I02) for the worktree; `interrupt` the current turn; set mode → observe; the DTO reflects "human driving" (new optional field or derived from presence+observe). The worktree Space (C06) is where the human then works.
- Hand back: restore the prior mode; release the human's presence/leases; send a `{type:"prompt"}` "resume — I changed <files>" (files from the lease/diff delta) so the agent re-reads the tree on purpose.
- Cockpit UI: a Take over / Hand back toggle in the intervene pane header; while taken-over, the conversation composer is framed as "you're driving"; the overlay (I04) shows the human holding files.

## Acceptance

- Live (scratch-daemon): Take over a working unit → its turn interrupts, mode shows observe, the human appears in presence/leases; edit a file in the worktree Space; Hand back → mode restored, human presence released, the agent receives the resume prompt and its next turn reflects the edit.
- Unit tests: the takeover/handback state machine (pure) — valid transitions, restore-prior-mode, idempotent double-takeover.

## Review

If a daemon primitive is added, cross-lineage review (codex + grok) — it mutates agent run state (interrupt) + autonomy + presence in one call; watch for a partial-apply/rollback hole and a takeover that can't be handed back (stuck observe).
