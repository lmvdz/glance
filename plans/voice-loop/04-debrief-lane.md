# Debrief lane: ts-cursor, REST fetch, fenced spoken backlog, durable voice spawns
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 03
TOUCHES: webapp/src/lib/chat/sessionStore.ts, webapp/src/lib/chat/sessionStore.test.ts, webapp/src/lib/voice/tools.ts, webapp/src/lib/voice/tools.test.ts, webapp/src/hooks/useVoiceDispatcher.ts, webapp/src/hooks/useVoiceDispatcher.test.ts, webapp/src/context/VoiceCallContext.tsx, webapp/src/lib/api.ts

## Goal
Starting a voice call on a session whose tracked agents finished work since the last debrief
opens with a spoken "while you were away" summary (max 3 entries + "and N more"), built from
durable transcript truth, idempotent under barge-in/teardown, and covering voice-spawned agents.

## Approach
1. **Cursor persistence** (sessionStore.ts): optional `Session.metadata.voiceDebrief?: {
   cursorTs: number; lastCallEndedAt?: number }` — wall-clock ts ONLY (never seq: seq is assigned
   at stream start, mutated in place, and resets on daemon restart; `finishAssistantStream`
   re-stamps `ts` at completion so `ts > cursorTs` correctly captures turns that were mid-stream
   at hang-up). Pure mutator `advanceVoiceDebriefCursor(sessions, sessionId, cursorTs, now)` that
   BUMPS `updatedAt` (MEDIUM-3 class: a non-bumping write gets clobbered by mergeSessions) + a
   browser-side wrapper following the appendSpokenSummary pattern. Never move the cursor backward.
2. **Transcript fetch** (api.ts): `fetchAgentTranscript(agentId): Promise<TranscriptEntry[]>` via
   `GET /api/agents/:id/transcript` (apiJson). The WS `transcripts` mirror is NOT used — it is
   empty on a cold page load and replay has no completion marker.
3. **Debrief builder** (tools.ts): pure `buildVoiceDebrief(input: { perAgent: Array<{ label:
   string; entries: TranscriptEntry[] }>; cursorTs: number; nowTs: number })` returning
   `{ items: unknown[]; maxCompletionTs: number } | null`. Qualifying entries:
   `kind === 'assistant' && status !== 'running' && ts > cursorTs`, clamped to the last 24h
   (`nowTs - 24h` floor when it exceeds cursorTs). Cap 3 entries across agents (newest last),
   count the rest into "…and N more". Each entry fenced per buildCompletionInjectionItems
   conventions with two hardenings: strip `[\r\n\t]+` → space in the DATA payload (a transcript
   tail must not forge a second trusted bracket header) and 400-char truncation. The preamble
   MUST instruct: narrate briefly, DO NOT call any tools in this turn, ask the operator what they
   want to do next (MAJOR-3: this response is injection-triggered, mutating tools are fail-closed
   blocked — the model must not be steered into narrating a gate refusal as its opening line).
   When history was visibly truncated (oldest surviving entry ts > cursorTs) prefix "history was
   truncated — partial report". Also strip `[\r\n\t]` in the existing buildCompletionInjectionItems
   DATA payload (same forgery gap, found in review).
4. **Durable voice spawns** (useVoiceDispatcher.ts + sessionStore.ts): `dispatchSpawnAgent`
   currently records only an in-memory watcher — a voice-spawned agent is invisible to the next
   call's debrief. Add an `onAgentSpawned?: (agent: { id: string; name: string }) => void` dep to
   the dispatcher options; VoiceCallContext persists it into the bound session's `spawnedUnits`
   via a new small sessionStore mutator (match the existing SpawnedUnitRecord shape — read it from
   `webapp/src/lib/spawnProposal.ts` — fill required fields honestly; source is the voice lane).
5. **Wiring** (VoiceCallContext.tsx), inside the callToken-keyed construction effect:
   - Tracked set: `binding.agentId` (may be undefined pre-bootstrap) + `spawnedUnits[].agentId`
     of the bound session, pruned against the live roster.
   - After `session.connect()` resolves (still epoch-valid), fetch transcripts for the tracked
     set (Promise.allSettled — a dead agent's 404 must not sink the debrief), build the debrief;
     if null and no cursor exists, skip silently (first call — no backlog chatter); if non-null,
     `session.queueInjection(items, ({ cancelled }) => { if (!cancelled)
     advanceVoiceDebriefCursor(sessionId, maxCompletionTs) })` — the two-phase commit. NEVER
     advance the cursor from effect cleanup (StrictMode's synthetic cleanup would eat the debrief
     in dev) and never at call end unconditionally.
   - Also stamp `lastCallEndedAt` (+ cursor floor for cursorless sessions =
     `max(lastCallEndedAt, now - 24h)`) via `endCall()`'s explicit handler (a real user intent),
     not the effect cleanup.
   - Live narrations already spoken mid-call by sweepPromptWatchers: pass the same style of
     commit — extend the sweep's `queueInjection` call to advance the cursor to that completion's
     entry `ts` on `{cancelled:false}` (the sweep already holds the completion entry). This keeps
     "cursor == what was actually heard" as the single invariant across both lanes.
6. **Tests**: builder (qualify/clamp/cap/fencing/no-tools instruction/truncation-honesty/newline
   strip, maxCompletionTs correctness); cursor mutator (bump updatedAt, never backward); spawn
   record persistence; dispatcher onAgentSpawned firing. Context wiring stays the untested
   imperative shell per package convention — keep every decision in pure helpers.

## Cross-Repo Side Effects
None (webapp only).

## Verify
`cd webapp && bun test && bunx tsc --noEmit` green. Manual loop: voice-dispatch work, hang up,
let it finish, start a new call on the same session → spoken "while you were away" naming the
agent; barge into the debrief mid-sentence, hang up, call again → debrief REPEATS (cursor never
committed); let it finish speaking, call again → silence about old items.
