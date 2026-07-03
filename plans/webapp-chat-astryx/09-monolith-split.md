# Split AssistantChat.tsx into components/chat/
STATUS: open
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
