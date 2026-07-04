# Single message model (replay-as-truth) + clean echo text
STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts, src/web/dto.ts, webapp/src/lib/dto.ts, webapp/src/components/AssistantChat.tsx, webapp/src/components/chat/TranscriptTimeline.tsx, webapp/src/components/AssistantChat.test.tsx

BLOCKED_BY: 09

## Goal
One message representation and one render path. The `hasTranscript ? [] : messages` mutual-exclusion hack dies; the operator's sent message never vanishes, never duplicates after refresh, and never inflates into the injected context blob.

## Approach
Grounded in the red-team system facts: the server **persists** each agent transcript (800-cap) and **replays it in full on every `subscribe`** (`src/squad-manager.ts:2437-2440`), and it currently echoes the context-augmented `cmd.message` as the user entry (`:2462`).

**Server (small, do first):**
1. Add optional `displayText?: string` to the prompt `ClientCommand` (`src/web/dto.ts` + mirror in `webapp/src/lib/dto.ts`). In the prompt handler (`squad-manager.ts:~2462`), append the transcript user entry with `displayText ?? cmd.message` as its text while passing the full `cmd.message` to the agent. Older clients (no `displayText`) behave exactly as today.
2. `handleSend` sends `displayText: textToSend` (the pre-context-blob user text, `AssistantChat.tsx:~998`).

**Webapp:**
3. **Stop double-writing**: once a session has an `agentId`, `handleSend` no longer appends to the session's `messages` (the replayed server transcript is the durable record — proven above). `messages` remains only for pre-agent sessions (welcome text, chit-chat before an agent spins up).
4. **Read-time mapper** `messageToTranscriptEntry(msg): TranscriptEntry` (`kind: role==='user'?'user':'assistant'`, `format:'markdown'`, `status:'ok'`, stable synthetic id) for those pre-agent messages. Strip/tolerate legacy `reaction` fields in `normalizeAssistantSessions` (`AssistantChat.tsx:~77`) so old localStorage blobs stay loadable.
5. **Optimistic in-flight entries**: `handleSend` keeps a transient (state-only, never persisted) `pendingSends: TranscriptEntry[]` with the `clientTurnId` it already generates. Render list = `[...mapped(messages), ...transcriptEntries, ...pendingSends]` — **append at the end** (red-team: prepending renders new sends at the top). A pending entry is removed when a `kind==='user'` transcript entry with the same `clientTurnId` arrives (restrict matching to user-kind — gate answers reuse the field with requestIds) or after a timeout (leave it rendered with an error hint if the send never echoes).
6. **Delete** the legacy bubble render path (`L1252-1290` region) and the `hasTranscript ? [] : messages` switch; everything renders through `TranscriptTimeline`. Delete the thumbs up/down reaction UI + `toggleReaction` (sign-off recorded in 00-overview).
7. While here (same file surface, DESIGN.md contract): stamp `data-kind`/`data-status` on entry roots in `TranscriptTimeline` — the styling/test hook that replaced the cut token-migration concern.

## Cross-Repo Side Effects
Daemon change (1): the running daemon uses the **global install** — after landing, reinstall/restart the daemon (`omp-squad` global + supervisor restart) or the webapp sends `displayText` to a server that ignores it (harmless but unverified).

## Verify
- `bun test` (root, with node_modules/.bin on PATH — repo gotcha) covering: prompt handler stores `displayText` when present, full message still reaches the agent (server test near existing squad-manager tests); mapper role/kind + reaction stripping; pending-send lifecycle incl. gate-answer echo NOT clearing a pending user send; ordering (pending at end).
- Manual, the red-team scenarios: (a) send mid-run → message appears at the bottom instantly, does not inflate into the context blob when the echo lands; (b) refresh mid-run → no duplicated turns, full history via replay; (c) pre-agent session from old localStorage renders and survives refresh; (d) answer a gate → no pending-send weirdness.
- Daemon restarted and `/api` version confirmed before manual passes.

## Resolution
Implemented, then corrected after review found the first cut lost durability: the design is replay-as-truth **with client-side double-write restored**, not "stop double-writing." `displayText?: string` was added to the prompt `ClientCommand` (src/types.ts + webapp/src/lib/dto.ts); the server stores `displayText ?? cmd.message` as the transcript user entry's clean text while forwarding the full context-augmented message to the agent (src/squad-manager.ts), and the operator-facing render/export paths use `entry.displayText ?? entry.text`.

The webapp keeps writing every user turn into `session.messages` (with a `clientTurnId` and timestamp) in addition to the ephemeral `pendingSend` it also creates — the durable copy is not optional: the server transcript ring is 800-entries-capped and an agent record can be evicted or die, so for those sessions localStorage was the only surviving copy. The prior revision's load-time migration that stripped `role:'user'` messages from agent-backed sessions was a silent, permanent data-loss bug and has been deleted outright; there is no migration anymore.

Duplication is resolved at render time instead: `partitionSessionMessages` matches each durable user Message against the real transcript (by `clientTurnId`, falling back to an exact `displayText`/text match for pre-fix legacy blobs) or a live `pendingSend`, and suppresses whichever copy is redundant. An uncovered message is positioned by timestamp against the transcript's window (or the agent's `startedAt` when the transcript is still empty): older renders as a chronological prologue — how an orphaned send from a dead/evicted agent surfaces once a replacement agent's transcript exists — and newer renders in an always-visible trailing section after the transcript, never folded into the collapsible work section and never counted toward the fold's own "is a run in progress" calculation. A `status:'error'` user bubble (an undelivered send, `Message.undelivered` surviving reload once its `pendingSend` is gone) gets a red-tinted border, a "Not delivered" hint, and a copy-to-clipboard affordance (Composer keeps its typed-input state private, so restoring straight into the composer wasn't a clean option without touching that file).

Covered by tests/rich-transcript.test.ts and webapp/src/components/AssistantChat.test.tsx (coverage-dedupe by clientTurnId and by text fallback, prologue/trailing positioning including the orphaned-agent case, pendingSend-vs-durable-message suppression, undelivered-survives-reload, the work-fold-must-not-be-swallowed-by-a-pending-send regression, and the error-bubble markup).
