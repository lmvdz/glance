# Promote/adopt bridge UI

STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/components/chat/AgentMetaBar.tsx, webapp/src/components/chat/SpawnStatusCard.tsx (pattern precedent), webapp/src/components/AssistantChat.tsx, webapp/src/lib/chat/sendCore.ts, src/server.ts (new GET /api/presence route), webapp/src/lib/api.ts, webapp/src/components/ui/AttentionRow.tsx or a new AdoptCard component (new), tests (webapp)
BLOCKED_BY: 02

## Goal

Both `SquadManager.promote` (squad-manager.ts:4054, `POST /api/agents/:id/promote`, server.ts:2490) and `SquadManager.adopt` (squad-manager.ts:4251, `POST /api/agents/adopt`, server.ts:2368) are fully built, gated, and idempotent server-side — and have ZERO callers anywhere in `webapp/` today (verified: no match for either route in the webapp source tree). This concern is pure bridge work: give the operator a button. "Make this a unit" turns a casual `here`/console chat into a gated, landable working unit without losing context; a presence-detected ad-hoc CLI session (raw `claude`/`omp` running outside glance) gets a one-click "adopt into glance" affordance instead of vanishing from view.

## Approach

**Promote affordance in the chat surface.** Add a "make this a unit" action to the chat surface's meta bar (`webapp/src/components/chat/AgentMetaBar.tsx` — the existing home for per-agent chrome above the transcript) or as a message-adjacent action, visible only for console/`here`-class chats (the same `isConsolePrompt`-derived identity `SquadManager.promote` itself gates on, squad-manager.ts:4054-4080). On click: `POST /api/agents/:id/promote` with an optional task string (default: a short synthesized summary of the chat so far, or empty — `promote`'s own idempotent re-steer behavior means a bare promote-then-prompt-later is a safe fallback if summarization is skipped for v1). Reuse the existing card/button visual language from `SpawnStatusCard.tsx` (button + `onClick` handler pattern already proven in this surface, webapp/src/components/chat/SpawnStatusCard.tsx:43-51) rather than inventing new chrome. On success (`{ok:true, agent}`), the DTO already reflects `promoted:true` — re-render the same thread with its now-visible unit chrome (whatever the roster already shows for a working unit; no new state machine needed, this is the SAME agent id, same transcript, only its `promoted` flag flipped).

**Ephemeral project durability, for free.** Concern 02 tracks casual sessions' auto-registered repos in an in-memory `ephemeralProjects` set that gets cleaned up (`unregisterProject`) on ordinary session end. When a promote call succeeds for an agent whose repo is in that set, remove the repo from `ephemeralProjects` in the SAME code path (squad-manager.ts, inside `promote()`) — "promote makes the project durable" becomes a one-line side effect of an already-built call, not new registry machinery. No webapp change needed for this half; it is server-only and this concern's UI button is what triggers it.

**Adopt flow surface.** There is currently NO webapp-visible list of presence-detected ad-hoc sessions at all — `cmdWho`/`allPresence` (src/presence.ts, consumed directly by the CLI at src/index.ts:856-869) reads presence off the local filesystem, which only works because the CLI runs on the same machine as the daemon; the browser has no filesystem access, so there is no existing REST route to bridge this. Add a small `GET /api/presence?repo=<repo>` (server.ts, operator-tier per the authz map's default for everyday-driving reads — mirror the tier already used for `/api/projects`) that calls the same `who`/`all` presence read and returns entries `{harness, operator, agent, repoName, branch?, heartbeatMs}`. Render these as a small list of "ad-hoc session detected" cards (new `AdoptCard` component, or a section within the existing roster/attention surface, e.g. alongside `AttentionRow.tsx`) — each with an "adopt into glance" button that calls `POST /api/agents/adopt` with `{harness, sessionId, cwd}` derived from the presence entry (the entry already carries enough identity to reconstruct the `AdoptBodySchema` shape server.ts:2367 decodes). On success, the new unit appears in the roster like any other; on the documented `409`/`{ok:false, reason}` failure shapes (`adopt`'s own validity gates — squad-manager.ts:4251+: cwd must resolve to the registered project's git root, presence claimId must still be live, no re-adopt of the same session@HEAD), surface `reason` verbatim rather than a generic error.

**Scope discipline.** This concern does not change `promote`'s or `adopt`'s server-side behavior — both are already correct and gated (idempotent promote, DoS-capped and symlink-safe adopt). It also does not build a general "ad-hoc session monitor" beyond what the adopt button needs — a simple polled list, refreshed on the same cadence the roster already polls at, is sufficient; no new WS event type.

## Cross-Repo Side Effects

none (glance-desktop's cockpit has its own chat panel per the completed fleet-first-ide program; this concern is the omp-squad webapp's bridge only — a cockpit-side promote/adopt affordance, if wanted, is a separate concern in that repo, not scope here)

## Verify

- Webapp unit tests: promote button calls `/api/agents/:id/promote` with the expected body and re-renders on `{ok:true}`; adopt card calls `/api/agents/adopt` with the presence entry's fields and surfaces `reason` on `{ok:false}`.
- New `GET /api/presence` route test: returns the same entries `cmdWho`/`allPresence` would report for the same repo, tier-gated correctly (unauthenticated/viewer-only requests refused per the authz map).
- Live: from a `glance here` chat, click "make this a unit," confirm the SAME thread now shows as a working unit in the roster with its history intact (not a new agent id, not lost context). Separately, start a raw `claude` CLI session in a registered project's directory (with harness-hook-reporting from fleet-ide-bridge/03 wired, if landed) or a synthetic presence entry, confirm it appears as an adopt card in the webapp, and adopting it produces a gated unit with the session's uncommitted diff replayed.

## Resolution

(filled in when this concern executes)
