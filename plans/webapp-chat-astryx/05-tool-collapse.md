# Collapse tool-call chains to latest + count
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/chat/ToolCallGroup.tsx (new), webapp/src/components/chat/ToolCallGroup.test.tsx (new), webapp/src/components/AssistantChat.tsx

BLOCKED_BY: 04

## Goal
A 40-tool-call run renders as one compact group (latest call + "N previous steps") instead of 40 stacked `<details>` blocks. This attacks transcript scroll bloat and un-virtualized DOM weight at its actual source.

## Approach
1. **`chat/ToolCallGroup.tsx`** (new file — buildable and testable standalone): takes `entries: TranscriptEntry[]` (all `kind:'tool'`, consecutive). Collapsed: renders only the newest entry's row — status dot/spinner, tool name, duration — plus a "N previous steps" toggle when N>0. Expanded: all rows. Reuse the existing per-call renderer for row detail (IN/OUT/ERR panes, raw payload `<details>` at `AssistantChat.tsx:437-506`) — extract it as `ToolCallRow` inside the new file, moving (not duplicating) that markup.
2. Rows are keyboard-activatable: `role="button"`, Enter/Space toggle, `aria-expanded`. Expansion animation via `grid-template-rows: 0fr -> 1fr` (astryx pattern; plain CSS, respects reduced-motion).
3. **Integration** (the only `AssistantChat.tsx` edit): in `TranscriptTimeline`'s render loop (`L357-419`), group runs of adjacent `kind:'tool'` entries (a pure `groupToolRuns(entries)` helper, unit-testable) and render each run through `ToolCallGroup`. Single tool entries (run length 1) render exactly as before.
4. A group containing a `status:'running'` entry is auto-expanded to show the live call; it collapses when the run moves on. Stamp `data-chat-message` on the group root (keeps concern 03's detection working).
5. Preserve entry identity for memoization (01): pass entries through, don't clone.

## Cross-Repo Side Effects
None. TaskDetail's embedded `TranscriptTimeline` gets the grouping for free — that's desired.

## Verify
- `bun test`: `groupToolRuns` (runs split correctly around non-tool entries; singletons pass through); static markup for collapsed (latest + count) vs expanded; running group auto-expands; `data-chat-message` present.
- Existing `AssistantChat.test.tsx` tool-render assertions updated in the same commit (this intentionally changes tool markup — not a pure move).
- Manual: dispatch an implement-style run; verify chain collapses live, expanding shows full history, raw payloads still reachable.
