# Wire scroll lock + jump-to-latest pill into the chat panel
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/AssistantChat.tsx, webapp/src/components/chat/ScrollToLatestPill.tsx (new), webapp/src/components/AssistantChat.test.tsx

BLOCKED_BY: 01, 02

## Goal
The chat viewport never moves against the operator's will: locked-to-bottom follows streaming growth via a spring; any upward scroll unlocks; new content while unlocked surfaces a "jump to latest" pill; clicking it re-locks. Replaces the unconditional `scrollIntoView` (the #1 documented chat bug).

## Approach
Line anchors as of plan time; 01 will have shifted them slightly.
1. **Scroll container** (`AssistantChat.tsx:1237`): attach `scrollRef` from `useChatStreamScroll`; add `key={activeSessionId ?? 'none'}` so switching sessions remounts the container (red-team catch: lock state and scrollTop otherwise leak across sessions).
2. **Content wrapper**: the messages currently render as direct children with `space-y-4`. Insert one inner `<div ref={contentRef}>` (from `useChatNewMessages`) carrying the spacing class — the ResizeObserver watches content growth distinct from the viewport.
3. **Delete** `scrollToBottom`/`messagesEndRef` (`L913-915`, `L804`, sentinel div `L1303`) and the scroll half of the old effect (persistence half was already split out by 01). Streaming growth now follows via `useChatNewMessages`'s `onResize -> scrollIfLocked`. **Do not touch** the auto-promote effect (`L922-932`).
4. **Stamp `data-chat-message`** on the root element of every entry-rendering branch: all 5 `TranscriptEntryView` kinds (user/assistant/thinking/tool/system), the legacy bubble path (`L1252-1290`, alive until concern 10), `GateWidget`, and `DiffReviewPanel` — a gate appearing while scrolled up must trigger the pill. Missing a branch silently breaks detection for that kind.
5. **Pill** (`chat/ScrollToLatestPill.tsx`, new — first file in the `chat/` dir): absolutely positioned above the composer, appears when `hasNewMessages && !isLocked` (per hook outputs), label "New messages", click → `scrollToBottom()` + dismiss. Tailwind, `dark:` variants, respects `.shimmer`-style reduced-motion conventions. Accessible label required.
6. Initial mount: lock + jump instantly (no spring) so opening a long transcript starts at the bottom.

Fallback if the ported hooks misbehave in real use (sanctioned de-scope, from DESIGN.md): a minimal isNearBottom check gating `scrollIntoView({behavior:'auto'})` + the same pill. Prefer the port; record the fallback in the PR if taken.

## Cross-Repo Side Effects
None. TaskDetail's embedded transcript is explicitly **not** wired (cut — see DESIGN.md); it keeps today's no-autoscroll behavior.

## Verify
- Existing tests pass; add static-markup assertions: pill markup renders when its state props say so; scroll container carries the session key and `data-chat-message` present on every branch (enumerate kinds in one test).
- Manual (dev webapp, streaming agent): (a) scroll up mid-stream → no yank, pill appears; (b) click pill → smooth return + re-lock; (c) settle back to bottom manually → re-locks (scrollend engines); (d) collapse TodoPanel / open a tool `<details>` while locked → no unlock (synthetic-scroll filter); (e) switch sessions → new session opens at bottom, locked; (f) drag the panel resize handle during streaming → no jank; (g) `prefers-reduced-motion` → instant jumps, no spring.
