# Voice tool dispatcher (async-ack, human-turn gating, transcript coherence)
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/lib/voice/tools.ts, webapp/src/hooks/useVoiceDispatcher.ts, webapp/src/context/TaskContext.tsx, webapp/src/lib/voice/tools.test.ts
BLOCKED_BY: 03, 04, 06

## Goal
The bridge from voice-model `function_call`s to the fleet — under the invariant that the voice model is mouth/ears only, and under the async-ack contract: mutating tools acknowledge immediately, completion is narrated later from the fleet's own event stream.

## Approach
- `webapp/src/lib/voice/tools.ts` (pure, no socket): the 4 function-tool JSON schemas — `prompt_agent(message)` (NO id param; dispatcher fills the pinned binding), `spawn_agent(prompt)`, `fleet_status()`, `interrupt()` — admin verbs (kill/restart/remove/fork) are omitted from the schema entirely; plus `function_call_output` formatters. Outputs are **structured status objects** (state + truncated, clearly-delimited-as-data excerpt), never raw agent transcript — fleet transcripts are untrusted.
- `webapp/src/hooks/useVoiceDispatcher.ts`, threaded under `TaskContext` (NOT a standalone lib module — `connectSquad` is a factory; a lib module would open a second socket; the one live socket reaches components only as `sendConsoleCommand` via TaskContext.tsx:537):
  - **Async-ack**: `prompt_agent`/`spawn_agent` return a `function_call_output` ack within ~1s ("dispatched — working; results land in the timeline"). NEVER await fleet completion inside a tool call — fleet ops take minutes; a pending realtime call causes re-issued tools, and a re-issued prompt becomes a **steer** of live work (rpc-agent.ts streamingBehavior retry).
  - **Completion narration**: on the bound console agent's `message_end` (already in `useSquad`'s transcript store — broadcast to every socket, no new plumbing), if the session is live and quiescent, inject `conversation.item.create` (local-heuristic summary: last message_end, truncated, delimited-as-data) + `response.create`. If PTT is held, queue (06's rule 2). If the session died, the timeline is the source of truth — no orphan.
  - **Human-turn gating** (injection defense): mutating tools execute only when the triggering response was initiated by user speech; a `function_call` arising from an injected completion narration gets an output of "confirm with the user first" and is NOT executed. `fleet_status` (read-only) is exempt. Single-flight guard per tool+target regardless (providers can emit parallel calls).
  - **Binding**: pinned at call start (session id + console agentId via 04's `ensureConsoleAgent`); session delete ends the call; session/project switch keeps the pin (08 renders the banner). Roster-liveness check before every send (mirror AssistantChat.tsx:736) + "no transcript echo with my clientTurnId within N seconds" → honest failure output ("the agent is gone — want me to start a new one?"); on mid-call re-mint of the console agent, tell the model it's a fresh agent with no memory. (applyCommand silently no-ops on unknown ids — squad-manager.ts:4881-4882 — so the dispatcher must detect, the daemon won't.)
  - **Transcript coherence**: voice prompts go through 04's `buildPromptCommand` with `source:"voice"` (03's field) and the user's spoken caption as displayText → durable Message + clientTurnId machinery + a "spoken" marker; spoken summaries persisted as lightweight model messages so reload keeps both halves. Non-tool voice chit-chat is ephemeral **by documented decision** (noted in code comment + help).
  - `interrupt` applies the same debounce the UI's handleStop has (AssistantChat.tsx:565-570) — voice must not spam interrupts the UI rate-limits.

## Cross-Repo Side Effects
None.

## Verify
- Unit tests: ack within one tick (mock session); duplicate `function_call` for same target while in flight → single dispatch; completion narration queued while userRecording; human-turn gate blocks a mutation from an injected-narration response; dead-agent send → failure output (mock roster); voice prompt carries source:"voice" + caption displayText.
- Live: speak "ask the agent to list open PRs" → immediate spoken ack → minutes later the completion is narrated when message_end lands → timeline shows the spoken turn with marker; kill the console agent mid-call from Fleet view → next voice command gets the honest "agent is gone" response, not silence.

## Resolution
Shipped (commit af6ce7d; audit hardening 593bc16). Async-ack tool contract + human-turn injection gate (fail-closed on non-`user` trigger, verified un-bypassable by 3 independent reviewers), 4 tools (admin verbs omitted), structured outputs with agent text fenced as untrusted data, single-flight, dead-agent detection, spawn-response guard. Decision core exhaustively matrix-tested.
**Live-verification OWED**: real dispatch through a live session (speak → fleet → narrated completion) not run (no key).
