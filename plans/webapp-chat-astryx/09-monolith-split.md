# Split AssistantChat.tsx into components/chat/
STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/components/chat/* (new: TranscriptTimeline.tsx, Composer.tsx, TodoPanel.tsx, GateWidget.tsx, DiffReviewPanel.tsx, AgentMetaBar.tsx, SettledMarkdown.tsx, CodeBlock.tsx, index.ts + colocated tests), webapp/src/components/AssistantChat.tsx, webapp/src/components/TaskDetail.tsx, webapp/src/components/AssistantChat.test.tsx

BLOCKED_BY: 08

## Goal
The chat is a directory of focused modules instead of one ~1,400-line file; `TaskDetail` imports `TranscriptTimeline` from its real home; `AssistantChat.tsx` shrinks to the panel shell + state orchestration. Zero behavior change.

## Approach
One concern, sequential commits (one logical group per commit), single PR. Move order: leaf components first.
1. **Pure moves** into `chat/`: `CodeBlock` (+`SettledMarkdown` and its `streamingMarkdown` import — red-team catch: forgetting it creates a `chat/ -> ../AssistantChat` import cycle), `TodoPanel`, `GateWidget`, `DiffReviewPanel`, `AgentMetaBar` (+`AgentLandControls`, `ComposerStats`), `RunStatusHeader`, `TranscriptEntryView` + `TranscriptTimeline` (one module), `ToolCallGroup` is already there, `ScrollToLatestPill` is already there.
2. **Declared state-relocation (the one non-pure move)**: `Composer.tsx` takes the composer JSX (`L1322-1391`) AND owns input/mention/trigger-menu state (`input`, the useTriggerMenu wiring from 08). Parent passes `onSend(text)`, `isStopShown`, `onStop`, `models` etc. as props. This is flagged as behavior-relevant: `handleSend`'s context-assembly stays in the parent.
3. **Repoint `TaskDetail.tsx:16`** to `./chat/TranscriptTimeline` in the same commit as that move (atomic — never a follow-up).
4. **Tests move with their components** (colocated `chat/*.test.tsx`); assertions unchanged for pure moves. No temporary re-exports left behind: `AssistantChat.tsx` must not re-export moved components at the end state (grep check), and the test file imports from the new paths.
5. **Acceptance checks** (all must hold):
   - `git diff` on moved component bodies shows relocation only (whitespace/import-path changes aside) except `Composer`.
   - `grep -r "from '\.\./AssistantChat'" webapp/src/components/chat/` → empty (no cycle).
   - Full webapp test suite green with assertions for pure-moved components unmodified.

## Cross-Repo Side Effects
None.

## Verify
- `bun test` (webapp suite) green; typecheck green; `bun run build` (webapp) succeeds.
- Manual smoke after the final commit: open chat, stream a run, Verify/Land buttons, answer a gate with Cmd/Ctrl+Enter, expand diff panel, tool group expand — all identical to before the split.

## Resolution
`AssistantChat.tsx` shrank from 1492 to 753 lines. New `webapp/src/components/chat/` modules, each a pure move except `Composer.tsx`:

- `CodeBlock.tsx` — the markdown `code` renderer.
- `SettledMarkdown.tsx` — imports `CodeBlock` and `streamingMarkdown` directly (not via `AssistantChat`), the cycle-guard called out in DESIGN.md.
- `TodoPanel.tsx`, `GateWidget.tsx` — pure moves.
- `DiffReviewPanel.tsx` — pure move; also now the home of the `AgentFileDiff` interface (previously in `AssistantChat.tsx`), since both `DiffReviewPanel` and `TranscriptTimeline` need the type without importing back across the cycle boundary.
- `AgentMetaBar.tsx` — `AgentMetaBar` + `AgentLandControls` + `ComposerStats` and their private formatting helpers.
- `TranscriptTimeline.tsx` — `TranscriptTimeline` + `TranscriptEntryView` + `RunStatusHeader` (+ `ElapsedClock`, `entryAction`, and the transcript-splitting helpers) as one module. `transcriptIsRunning`/`agentIsRunning`/`runStatusLabel` are exported and imported forward into `AssistantChat.tsx` (same "one definition, forward import" pattern already used for `ToolCallGroup`). The `messages` prop is typed `{ timestamp: number }[]` instead of the app's `Message` type — the only field this module actually reads — so `Message` never has to cross the `chat/` boundary.
- `Composer.tsx` — the one declared state-relocation: owns the composer's `input` state and the `@`-mention trigger-menu wiring (`useTriggerMenu`, `mentionTriggers`, `composerTextareaRef`), plus the suggestion-chip row and `ComposerSendButton`. Exposes `onSend(text: string)`; `AssistantChat.tsx`'s `handleSend` still owns context-assembly (fleet snapshot, task context, agent creation) and now takes the already-validated text as a required argument instead of reading `input` state directly.
- `index.ts` — barrel re-export for the whole directory (not used by `TaskDetail.tsx`, which imports `TranscriptTimeline` directly per the plan).

`TaskDetail.tsx:16` repointed to `./chat/TranscriptTimeline` in the same commit. `AssistantChat.test.tsx` updated to import each moved export from its new home; all pre-existing assertions unchanged. `grep -r "from '\.\./AssistantChat'" webapp/src/components/chat/` is empty (no cycle). `bun test` (webapp): 405 pass / 0 fail. `bunx tsc --noEmit` and `bun run build` both clean.
