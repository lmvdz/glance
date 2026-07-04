# Memoize transcript entries, isolate the clock, split persistence
STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/components/AssistantChat.tsx, webapp/src/components/AssistantChat.test.tsx

Line numbers below are as of plan time (2026-07-03); re-locate by anchor if drifted.

## Goal
Stop re-rendering (and re-parsing markdown for) every transcript entry on every WS frame and every 1-second clock tick, and stop re-serializing all sessions to localStorage on unrelated transcript updates.

## Approach
1. **`React.memo(TranscriptEntryView)`** (component at `AssistantChat.tsx:421`). `appendTranscriptEntry` (`useSquad.ts:61-70`) preserves object identity for untouched entries, so a default shallow-prop memo suffices. Verify props are stable: if `TranscriptEntryView` receives inline lambdas or a `now` prop, hoist/remove them (see step 2).
2. **Clock leaf**: the 1s `setInterval` at `AssistantChat.tsx:892-899` sets state that re-renders the whole panel just for elapsed-time labels. Extract a leaf component (e.g. `ElapsedTime({since})`) that runs its own interval internally, and delete the panel-level `now` state. Every call site currently reading `now` for labels uses the leaf instead.
3. **Split the combined effect** at `AssistantChat.tsx:917-920`: localStorage persistence (`localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(sessions))`) moves to its own effect keyed on `[sessions]` only. Leave `scrollToBottom()` in the old effect untouched — concern 03 replaces it; this concern must not change scroll behavior.
4. **Do not touch** the adjacent auto-promote effect (`AssistantChat.tsx:922-932`) — it is out of scope for the whole plan.

## Cross-Repo Side Effects
None.

## Verify
- `bun test webapp/src/components/AssistantChat.test.tsx` passes unchanged (memo must not alter static markup).
- Add a test: render twice with the same `transcriptEntries` array identity — assert `TranscriptEntryView` output stable (or unit-test the memo comparator if extracted).
- Manual: during a streaming run, React DevTools profiler (or a render-count probe) shows settled entries not re-rendering on WS frames; localStorage writes no longer fire on transcript-only updates (breakpoint or wrap setItem).

## Resolution
`TranscriptEntryView` memoized, elapsed-time extracted into its own leaf component with an internal interval, and localStorage persistence split into a `[sessions]`-keyed effect separate from scroll handling. Verified via `AssistantChat.test.tsx`.
