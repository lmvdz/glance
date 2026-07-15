# E01 — daemon-backed chat session (the substrate)

STATUS: in-review (gd#20 — cockpit-only, no gauntlet; in-app stream render NOT RUN, needs WSLg+key)
PRIORITY: p2
REPOS: glance-desktop (+ tiny omp-squad if needed)
COMPLEXITY: architectural
TOUCHES: glance-desktop src/modules/ai/ (a second ChatTransport + a mode toggle), src/modules/fleet/lib/fleetClient.ts (console-create + reuse transcript/steer); omp-squad only if the console transcript needs the user turn echoed
BLOCKED_BY: I01 (merged)

## Goal

The cockpit's BYOK chat panel gains a **daemon session mode**: instead of calling a model provider directly, the chat runs as a daemon `/api/console` unit — turns go in via `POST /api/command {type:"prompt"}`, replies come back by polling the transcript delta (I01). The chat is now a real (lightweight, console-mode, ungated) unit that shows up in the roster and carries a worktree, which is exactly what makes it **promotable in place** (E02). This is the substrate; nothing about "chat and units are the same thing" works without it.

## Ground truth (recon first — verify before building)

- `/api/console` (`src/server.ts:2321`) creates a unit `{repo, name:"chat", autoRoute:false, appendSystemPrompt: CONSOLE_SYSTEM_PROMPT}` and returns `{agentId}`. Confirm live: does the console unit's transcript stream user turns as well as assistant turns over `GET /api/agents/:id/transcript?since=`? If user turns aren't mirrored, the chat pane must render them optimistically (it already does this for steer — I03's `addOptimistic`). If the daemon needs a one-line change to echo the user turn into the transcript, that's the only omp-squad touch; keep it minimal and Schema-clean.
- The fork's chat is `Chat<UIMessage>` fed by a `ChatTransport<UIMessage>` selected in `chatRuntime.makeChat` (`store/chatRuntime.ts:21,101`). A transport is `{ sendMessages, reconnectToStream }`. The daemon transport's `sendMessages` calls `steer` and then streams the reply by draining the transcript-delta poll and converting `TranscriptEntry → UIMessage` parts.
- Reuse, do not rebuild: the I01 transcript-delta poll + store already exist in `src/modules/fleet/` (`fleetTranscriptStore`, `client.transcript(id, since)`). The chat transport consumes the same client.
- CSP forbids `ws://` — the reply stream is a poll loop (or HTTP-SSE if the daemon later offers it), not a socket. Latency parity with I03's conversation pane (~1-2s) is acceptable for chat.

## Approach

1. `FleetClient.createConsole(repo, model?, profileId?): Promise<{ agentId }>` → `POST /api/console`. (First write-ish method that spawns; `POST /api/console` is operator-tier.)
2. A `daemonChatTransport(client, opts)` implementing `ChatTransport<UIMessage>`: on `sendMessages`, ensure a console unit exists (lazy-create on first turn, remember `agentId` in the session), `steer` the user text, then poll `transcript?since` and yield a `UIMessageStream` mapping transcript entries → message parts until the turn settles (reuse the I01 poll cadence + the "turn done" heuristic from I03's conversation view).
3. A **mode toggle** in the chat panel: "Local (BYOK)" vs "Daemon" — selected in `makeChat`, defaulting to Local so nothing regresses. Persist the choice per session in `chatStore`.
4. Surface the daemon chat's `agentId` so E02's "Promote" button knows which unit to promote.

## Acceptance

- With a daemon connected, switching a chat session to Daemon mode and sending a message creates a console unit (visible in the fleet roster) and streams its reply into the chat pane. RAN / result.
- The unit's transcript and the chat pane agree (poll reconciles optimistic user turns). RAN / result.
- Local (BYOK) mode is unchanged — the existing transport is the default and untouched. RAN / result.
- Gate: tsc + lint (baseline) + vitest + build all green. Pure helpers (transcript→UIMessage mapping, lazy-create guard) unit-tested.

## Non-goals / deferred

- Promotion (E02) and adoption (E03).
- A truly worktree-less lightweight daemon chat — the console unit cuts a worktree today; a no-worktree session kind is a later daemon optimization, not required for the escalation loop.
- HTTP-SSE streaming from the daemon (poll is sufficient for v1; SSE is a latency nicety).
