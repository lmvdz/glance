# Epic I — Shared-workspace intervention (over ACP)

Parent: plans/fleet-first-ide/00-meta.md · Charter: plans/fleet-first-ide/03-shared-workspace-intervention.md
Expanded 2026-07-15 (trigger met: C04–C07 + B03 all merged). Grounded on a daemon surface map (see per-concern file:line refs).

## Outcome

Intervention stops being a form and becomes a shared workspace: from the cockpit you open a unit's worktree as a Space (C06), and you are a **peer of the running agent** — you see who holds which file (leases), you carry on the unit's actual ACP conversation (not a fire-and-forget steer), your edits in the worktree are visible to the agent on its next turn, and you can explicitly take over and hand back. The human's presence is visible to the agent, and the agent's is visible to you.

## Ground truth (from the daemon surface map — consume, don't rebuild)

- **EXISTS**: `GET /api/leases` → `LeaseEntry {id, repo, file (repo-relative), operator, session, host, since, heartbeat}` (`src/leases.ts:30-41,173`; route `src/server.ts:767`) — real FILE-level "who holds which file". `GET /api/presence` (repo-level, `src/server.ts:1875`). `GET /api/agents/:id/transcript` → `TranscriptEntry[]` with a monotonic `seq` (`src/server.ts:1994`, `src/types.ts:146-167`). ACP `prompt` reuses ONE persistent `sessionId` (`src/acp-agent-driver.ts:229,481`) — every steer is a turn in the SAME conversation, so "conversation over ACP, not keystroke injection" is already true at the driver. `POST /api/agents/:id/mode` (observe/assist/autodrive, `src/server.ts:2044`); `interrupt` command (`src/squad-manager.ts:5225`). Edits in `dto.worktree` are seen next turn (shared filesystem, implicit).
- **MISSING (the additive daemon work)**: incremental transcript over HTTP (`?since=seq` — WS-only today, but the fork's CSP blocks ws:// so the cockpit polls); a presence/lease WRITE endpoint so the COCKPIT can register the human as present/holding files (presence claim is omp-hook-only today, GET-only over HTTP); a first-class takeover/hand-back state (composed today from interrupt + set-mode, but no single primitive).

## Work

| Concern | Repo | Why it exists | Complexity | Depends |
|---|---|---|---|---|
| 01 transcript-delta | omp-squad | `GET /api/agents/:id/transcript?since=<seq>` — the cockpit conversation pane polls deltas, not the full transcript every 2s | mechanical | — |
| 02 cockpit-presence-write | omp-squad | `POST /api/presence` + `/api/leases` claim/heartbeat/release so the cockpit registers the HUMAN in a worktree — the agent's lease-hook then sees "a human is here / holds this file" | architectural | — |
| 03 conversation-pane | glance-desktop | upgrade C07's one-shot steer into the unit's live ACP conversation: transcript view (poll delta) + send (existing prompt = same session) | architectural | 01 |
| 04 lease-presence-overlay | glance-desktop | consume `GET /api/leases` + `/api/presence` — show in the intervene pane / worktree Space who holds which file (the unit, and the human once 02 lands) | architectural | (02 enriches) |
| 05 takeover-handback | glance-desktop + omp-squad | "Take over" = claim presence (02) + interrupt + set observe; "Hand back" = release + restore mode + a "resume — I edited X" prompt. The explicit peer-handoff. | architectural | 02, 03, 04 |

## Order

| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01, 02, 04 | disjoint: 01+02 are daemon-side additive endpoints; 04 reads the ALREADY-existing /api/leases+/api/presence (works before 02, gets richer after) |
| 2 | 03 | needs 01's delta endpoint |
| 3 | 05 | needs 02 (presence write), 03 (conversation), 04 (overlay) — the capstone that ties peer-presence + conversation + handoff |

## Discipline (inherited from the meta-plan)

- Daemon concerns (01, 02, part of 05): omp-squad worktree, standard gate (bun test + scratch-daemon live verify), cross-lineage review on any WRITE/auth surface (02's presence-write, 05's takeover — they mutate shared state). New HTTP bodies go through Effect Schema decode (never cast) per the repo convention; authz tier deliberate (presence-write is operator — it mutates the shared roster).
- Cockpit concerns (03, 04, part of 05): glance-desktop, additive `src/modules/fleet/` only, gate = tsc+lint+vitest+build (cargo check with the PKG_CONFIG_PATH fix), poll (CSP blocks ws://). Reuse the C05/C07 client + store patterns.
- The ACP-not-keystroke-injection invariant is load-bearing: the conversation pane sends via `POST /api/command {type:"prompt"}` (same ACP session), NEVER anything resembling terax's `send_to_agent` PTY injection (the negative proof in the research brief).
