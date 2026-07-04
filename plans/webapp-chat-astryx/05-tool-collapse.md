# Collapse tool-call chains to latest + count
STATUS: closed
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

## Resolution
Shipped as designed:
- **`webapp/src/components/chat/ToolCallGroup.tsx`** (new): `groupToolRuns(entries)` — pure helper grouping consecutive `kind:'tool'` entries (stage-marker dividers, `format:'stage'`, break a run same as any non-tool entry) into `{type:'entry'}` singles or `{type:'group', entries}` runs, entries passed through by reference (no cloning, memoization-safe). `ToolCallRow` — the per-call IN/OUT/ERR/raw-payload row, moved verbatim out of `TranscriptEntryView`'s `kind==='tool'` branch (not duplicated); takes `stampChatMessage` (default `true`) so a standalone entry keeps its own `data-chat-message` while rows inside a group don't. `ToolCallGroup` — collapsed renders only the latest call's row plus a keyboard-activatable (`role="button"`, `tabIndex`, Enter/Space, `aria-expanded`) "N previous step(s)" toggle; expanded mounts the older rows only while expanded (the actual DOM-weight fix — a 40-call run no longer keeps 40 `<details>` blocks mounted to hide them with CSS) inside a `.tool-group-rows` wrapper that animates open via `grid-template-rows: 0fr -> 1fr` (mount-then-flip-class on the next frame, since a transition needs a prior value to animate from); a run containing a `status:'running'` entry force-expands regardless of the manual toggle and reverts to the manual state once the run settles. The group root carries `data-chat-message` (concern 03's new-message detection stays intact — one atomic unit instead of every buried row).
- **`webapp/src/components/AssistantChat.tsx`**: imports `ToolCallGroup`/`ToolCallRow`/`groupToolRuns`/`toolView`/`fmtDuration` from the new file (helpers moved there since they're needed by rows first; `AssistantChat.tsx`'s remaining users — `entryAction`, `transcriptDownloadText`, `ComposerStats`, `RunStatusHeader` — import them back, a one-way forward import with no cycle). `TranscriptEntryView`'s tool branch now delegates to `<ToolCallRow entry={entry} />` for the non-stage case (single-entry rendering is byte-identical to before). `TranscriptTimeline` gained a `renderEntries(list)` helper that runs `groupToolRuns` over `promptEntries`/`hiddenWorkEntries` and renders `ToolCallGroup` for grouped runs, `renderEntry` (unchanged) for everything else — singleton tool runs render exactly as before.
- `webapp/src/index.css`: added `.tool-group-rows` / `.tool-group-rows-open` / `.tool-group-rows-inner` and folded the new transition into the existing `prefers-reduced-motion: reduce` block.
- **`webapp/src/components/chat/ToolCallGroup.test.tsx`** (new, 11 tests): `groupToolRuns` singleton/grouping/split-on-non-tool/split-on-stage-marker/empty-list cases with reference-identity assertions; `ToolCallGroup` collapsed markup (latest call visible, older calls absent from the DOM, singular/plural "step(s)"); running-entry auto-expand; single `data-chat-message` on the group root; `ToolCallRow` standalone-vs-in-group `data-chat-message` stamping.
- Verified: `cd webapp && bun test` — 380 pass / 0 fail (28 files). `bunx tsc --noEmit` — clean. Root suite (`PATH="$PWD/node_modules/.bin:$PATH" bun test`) — 940 pass / 2 fail, both pre-existing and unrelated (agent-host spawn timeout in `tests/squad.test.ts`/`rpc-agent.ts`, matching the documented known-flaky/docker-sandbox-unavailable pattern; neither touches `webapp/`).
