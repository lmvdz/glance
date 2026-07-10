# Shared send/mint helper (single-flight console mint + prompt builder)
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/lib/chat/sendCore.ts, webapp/src/components/AssistantChat.tsx, webapp/src/components/AssistantChat.test.tsx

## Goal
Extract the console-agent-mint and prompt-command construction out of `AssistantChat.handleSend` into one shared core that both the typed path and the future voice dispatcher (concern 07) call. Kills two red-team findings pre-emptively: the two-minters race (voice tool call and typed send both minting console agents concurrently) and prompt-shape drift (a spoken prompt silently losing the fleet/task/page context injection a typed one gets).

## Approach
- New `webapp/src/lib/chat/sendCore.ts` exporting:
  - `ensureConsoleAgent(deps, sessionId): Promise<string>` — single-flight: caches the in-flight mint promise per session so concurrent callers await the same `POST /api/console` instead of double-minting. Carries the roster-liveness re-mint check (AssistantChat.tsx:735-746) and `selectedModel` (line 738 — a voice-path mint must not drop the operator's model choice).
  - `buildPromptCommand(ctx, textToSend, opts): ClientCommand` — the context assembly currently inlined at AssistantChat.tsx:751-760 (fleet/activity/page snapshots + displayText + clientTurnId), with an `opts.source` passthrough (concern 03's field) and an `opts.displayText` override (voice will pass the user's spoken caption).
- Rewire `handleSend` to call both. **Pure refactor of the typed path** — pendingSends/clientTurnId optimistic machinery stays in the component; the helper only owns mint + command shape. If extraction reveals coupled behavior that can't move without changing semantics, report rather than force.
- The helper takes its dependencies (apiJson, sendConsoleCommand, roster, currentProject, selectedModel) as arguments — no module-level socket, no new context. Concern 07 threads the same deps from TaskContext.

## Cross-Repo Side Effects
None.

## Verify
- `bun test` green; existing AssistantChat tests unchanged in behavior.
- New unit test: two concurrent `ensureConsoleAgent` calls for the same session issue exactly one `/api/console` POST (mock fetch, assert call count).
- Live smoke: typed chat still mints on first send, streams reply, dedupes optimistic echo.
