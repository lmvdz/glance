# assistant-ui Control Tower thread replacement
STATUS: cancelled

> 2026-07-01 reconcile: marked done but the assistant-ui approach was never adopted —
> `@assistant-ui/*` is not a webapp dependency and none of the TOUCHES files exist (2026-06-30
> audit, re-verified today). The *goal* (a rich live thread) was later met differently: the custom
> `TranscriptTimeline` in AssistantChat.tsx plus Claude-Code-style tool rendering (`0d4bc20`) and
> the inline gate-answer widget (`192e7bf`). Treat the assistant-ui plan itself as rejected.
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/views/ConsoleView.tsx, webapp/src/components/assistant-ui/thread.tsx, webapp/src/components/assistant-ui/tool-fallback.tsx, webapp/src/components/assistant-ui/tool-group.tsx, webapp/src/lib/omp-thread.ts, webapp/src/lib/assistant-text.ts, webapp/src/hooks/useSquad.ts, webapp/src/components/agent/AgentDetail.tsx, webapp/src/components/agent/AgentActions.tsx, webapp/src/components/agent/Transcript.tsx, webapp/src/components/project/TaskDetail.tsx, webapp/src/**/*.test.ts

## Goal

Replace custom chat/transcript/composer surfaces with assistant-ui primitives fed by the live OMP session. The web UI should feel richer than the TUI while remaining the same daemon thread, not a separate AI chat.

## Approach

- Extract `OmpLiveSession` runtime logic into one reusable hook/component seam, e.g. `useOmpThreadRuntime({ agent, squad, pageContext })`.
- Keep `useExternalStoreRuntime`: OMP is not a ChatModelAdapter; the daemon WS/event spine is the store.
- Use assistant-ui features already installed/present:
  - `ThreadPrimitive`, `ComposerPrimitive`, `MessagePrimitive`, `ActionBarPrimitive`, queue, suggestions, branch picker, selection toolbar.
  - `ToolFallback` / `ToolGroup` with rich `argsText`, result, status, and `useToolCallElapsed` where useful.
  - `Reasoning`, `MarkdownText`, quote/copy/reload/edit action bars.
  - `ComposerPrimitive.TriggerPopover` + `unstable_useSlashCommandAdapter` over `squad.commands`.
  - `unstable_useMentionAdapter` for `@agent`, `@feature`, `@task` insertion from live roster/page context.
- Convert enriched `TranscriptEntry` fields from concern 01 into assistant-ui parts. Stop inferring a tool from `▸ text` except as legacy fallback.
- Treat pending human/tool requests as `tool-call` parts with `requires-action` status and inline `AnswerControls`, not as a separate unrelated panel when possible.
- Fix duplicate messages with `clientTurnId` from concern 01; never text-match optimistic turns.
- Reuse the same component in Control Tower, AgentDetail, and TaskDetail; delete or shrink duplicate `Transcript`/`AgentActions` renderers after migration.

## Cross-Repo Side Effects

None.

## Verify

- Repeated identical prompts appear once per submitted turn and never vanish on new-chat handoff/replay.
- Tool call with args/result/error renders as grouped assistant-ui tool UI; legacy flat tool text still renders.
- Slash command popover lists daemon commands from `commands` WS seed and `/api/agents/:id/commands` fallback.
- `@agent`/`@feature` mentions insert into composer and are sent as plain text with fenced page context only when explicitly submitted.
- AgentDetail and TaskDetail no longer use the old custom transcript/composer path.
- Stop button sends `interrupt`; reload resends last non-pending user turn; quote forwarding preserves selected quote text.
