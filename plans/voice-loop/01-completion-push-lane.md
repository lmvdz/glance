# Completion push lane: one push per voice dispatch, alive after restarts
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/push.ts, src/server.ts, src/squad-manager.ts, src/types.ts, tests/push.test.ts (or sibling)

## Goal
When work dispatched by voice finishes, the daemon sends a web push — exactly one per voice
dispatch, never for operator-cancelled work, with a name-only body, without disturbing the
existing input/error escalation lane, file-mode only, and surviving daemon restarts.

## Approach
1. **Arm/disarm latch** (squad-manager.ts): add `voicePushArmed?: boolean` to the persisted agent
   options (rides `persist()` for free — restart-safe). ARM when a `prompt` command whose meta
   carries `source:'voice'` is applied to the agent (the same place audit tagging reads it). For
   voice `spawn` (source:'voice' on /api/spawn), arm but only fire on the TERMINAL signal: in the
   `workflow_done` / stopped handling, not intermediate `agent_end` idles — a workflow unit cycles
   working→idle per node (see agent_end at ~squad-manager.ts:5930; deriveStatus in
   agent-lifecycle.ts). DISARM on: (a) the push being sent, (b) an `interrupt` command with
   source:'voice' (the operator killed the work — "finished" would be a lie).
   Expose armed-ness on the emitted AgentDTO (new optional field, e.g. `voicePushArmed`) so the
   server-side hook can read it off the event without reaching into the manager.
2. **Payload** (push.ts): new pure `voiceDonePayload(prev, a, seeded)` next to `escalationPayload`:
   fires only when `seeded && prev !== undefined && prev !== a.status && a.status === 'idle'` AND
   the DTO says armed. Title like `✅ <name> finished`; body EXACTLY "Tap to open glance — call back
   for the spoken debrief." — NO transcript/summary content (lock-screen privacy; today's bodies
   only carry pending-question titles/errors). `url: /#/agent/<id>`, `tag: done:<id>` — the `done:`
   namespace is load-bearing: same-tag would REPLACE an unactioned "needs you" notification
   (sw.js renotify) and share its debounce slot.
3. **Hook** (server.ts `maybePushAlert`, ~2589): compute BOTH payloads; keep the escalation path
   byte-identical. For the done payload: separate debounce key (`done:` + id in `lastPush`), and
   assert file-mode — the method is only reachable from `broadcast()` today, but guard explicitly
   (`if (this.registry) return` or equivalent) so future `broadcastTo` wiring cannot silently ride
   a global subscription list across orgs. After a successful send, tell the manager to disarm
   (add a small manager method, e.g. `clearVoicePushArmed(id)`), which persists.
4. **Seed fix (also fixes the EXISTING escalation lane)**: `pushSeeded` only becomes true via a
   `roster` event through `broadcast()`, which only the legacy client's `snapshot` command
   produces — the React webapp never sends it, so after any daemon restart the whole push lane is
   dead until a legacy client connects. Seed `lastStatus` from `manager.list()` and set
   `pushSeeded = true` during server start (file-mode branch, where `singleManager` exists),
   right after managers are wired. Keep the roster-event seeding too (idempotent).
5. **Tests**: pure-function tests for `voiceDonePayload` (armed/unarmed, idle vs other statuses,
   seeded gate, tag/body content — pin that body contains NO agent text); manager tests for
   arm-on-voice-prompt, disarm-on-voice-interrupt, persistence round-trip; server-level test that
   a done push and an escalation within 3s of each other BOTH send (separate debounce keys); a
   startup-seed test (restart → agent goes input → push fires without any snapshot command).

## Cross-Repo Side Effects
None (daemon only). AgentDTO gains an optional field — webapp DTO type may need the optional
field added for tsc, no behavior.

## Verify
`bun test tests/` green at root. Manual: file-mode daemon, subscribe push in the webapp, dispatch
a voice prompt (or simulate: prompt with meta.source='voice'), close the tab, let the agent
finish → exactly one OS notification, name-only body; run again with an interrupt → no push.
Restart the daemon, drive an agent to `input` → escalation push still fires (seed fix).
