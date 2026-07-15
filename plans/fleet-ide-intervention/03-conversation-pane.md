# I03 — conversation pane (the unit's live ACP conversation)

STATUS: in-review (glance-desktop#18)
PRIORITY: p1
REPOS: glance-desktop
COMPLEXITY: architectural
TOUCHES: src/modules/fleet/ (IntervenePane → conversation view, a transcript store, FleetClient.transcript())
BLOCKED_BY: I01

## Goal

Replace C07's one-shot steer composer with the unit's **live conversation**: the running transcript (your turns and the agent's, streaming in) above the composer, so intervening feels like talking to the unit, not firing a message into the void. The ACP session-continuity is already real (every prompt is a turn in the same `sessionId`), so this is purely surfacing what's already one conversation.

## Ground truth

- `GET /api/agents/:id/transcript` → `TranscriptEntry[]` ({id?, seq?, kind, text, ts, displayText?, status?, tool?, ...}, `src/types.ts:146-167`); I01 adds `?since=<seq>` for deltas.
- Send is the EXISTING `POST /api/command {type:"prompt", id, message}` (C07's `FleetClient.steer`) — reuse it verbatim; it continues the same ACP session.

## Approach

- `FleetClient.transcript(id, since?)` → `TranscriptEntry[]`; a `fleetTranscriptStore` (per-unit) that polls `?since=<lastSeq>` on ~1.5s while the pane is open, concatenating by `seq` and de-duping on `id`/`seq` (mirror the roster store's poll+refcount discipline; keep the last good transcript on a failed poll).
- Render turns: `kind` distinguishes user/agent/system/tool; show `displayText ?? text`; render `tool` entries compactly (name + status), thinking/status inline. Auto-scroll to bottom on new entries unless the user scrolled up.
- Keep the C07 steer composer as the input; on send, optimistically append the user turn, then let the poll reconcile.
- The why-stopped card + diff spine from C07 stay (collapse the diff by default when a conversation is active, so the conversation leads). This concern REPLACES the "steer only" body, not the whole IntervenePane.

## Acceptance

- Live (scratch-daemon with a unit that has transcript history): the pane shows the existing turns; sending a prompt appends the user turn and the agent's reply streams in via the delta poll (no full refetch flicker); a poll failure keeps the transcript and recovers.
- Unit tests: the transcript reducer (concat by seq, dedupe, keep-last-good on error) as a pure function.
- Invariant check (state it in the PR): send goes ONLY through `{type:"prompt"}` — no keystroke/PTY path (the terax `send_to_agent` anti-pattern must not reappear).
