# Wire scroll lock + jump-to-latest pill into the chat panel
STATUS: closed
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

## Resolution

Wired the astryx-ported hooks (`useChatStreamScroll` + `useChatNewMessages`, landed in concern 02) into the live chat panel, replacing the unconditional `scrollIntoView` effect:

- New `ChatMessagesViewport` component (in `AssistantChat.tsx`, above `AssistantChat` itself) owns the scroll container: `scrollRef` from `useChatStreamScroll`, `contentRef` (carrying `space-y-4`, the transcript/legacy-bubble/loading-indicator content) from `useChatNewMessages` with `onResize={scrollIfLocked}`. `AssistantChat` renders it as `<ChatMessagesViewport key={activeSessionId ?? 'none'} .../>` — keying by session forces a full remount (fresh hook instances) on session switch so lock state and scroll position never leak across sessions, sidestepping the "ref object identity doesn't retrigger effects" gotcha that a plain `key` on the inner `<div>` alone would have hit.
- Deleted `messagesEndRef`, the old `scrollToBottom` (`scrollIntoView({behavior:'smooth'})`), the sentinel div, and the scroll half of the old effect. The persistence effect (`localStorage.setItem`) and the auto-promote effect were left untouched, per concern 01's split and this concern's explicit out-of-scope rule.
- Stamped `data-chat-message` on the root element of all 5 `TranscriptEntryView` branches (user/assistant/thinking/tool/system, including the tool-kind's workflow-stage-marker sub-branch), both `GateWidget` branches (options / free-text), the legacy message-bubble path, and `DiffReviewPanel` — so a gate or diff panel appearing while scrolled up is detected by `useChatNewMessages`'s last-message tracking.
- New `chat/ScrollToLatestPill.tsx` (first file in `webapp/src/components/chat/`): absolutely positioned pill above the composer inside the same relative wrapper as the scroll viewport, shown when `hasNewMessages && !isLocked`, `aria-label="Jump to latest messages"`, click calls `scrollToBottom()` + `dismiss()`. Entrance uses a new `.pill-rise` utility in `index.css`, disabled under `prefers-reduced-motion` alongside the existing `.shimmer`/`.login-rise` rules (matches the repo's existing reduced-motion convention).
- Exported `GateWidget` (was file-local) so it — and the gate-mid-transcript detection path — is directly testable.
- Took the ported-hook path in full (no fallback needed); initial-mount instant jump and the reduced-motion snap are both handled inside `useChatStreamScroll` itself (already landed in concern 02), not reimplemented here.
- Added static-markup tests: `data-chat-message` presence on all 5 `TranscriptEntryView` kinds, the stage-marker sub-branch, both `GateWidget` branches, `DiffReviewPanel`, and a `TranscriptTimeline`-level test proving a gate created mid-transcript is still detectable (≥2 stamped elements). Added `ScrollToLatestPill` visibility/accessible-label tests. Fixed one pre-existing test whose literal `"<details open"` assertion broke once `data-chat-message` became the details element's first attribute.
- `bun test` (webapp): 364 pass, 0 fail. `tsc --noEmit` (webapp): clean. DOM-behavior items (a)-(g) in Verify are the scripted manual flows called for by DESIGN.md's "Test substrate" decision (no DOM emulator added) — not exercised in this automated pass, consistent with concern 02's precedent.
