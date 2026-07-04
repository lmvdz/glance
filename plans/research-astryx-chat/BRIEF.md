# Research brief — facebook/astryx chat components → omp-squad webapp chat

- **Date**: 2026-07-03
- **Source**: https://github.com/facebook/astryx @ `deb5aa0` (MIT — code may be copied with attribution headers preserved)
- **Target**: omp-squad webapp chat — `webapp/src/components/AssistantChat.tsx` + `useSquad.ts` + `ws.ts`
- **Question**: can we take parts of astryx's chat components to make our web UI chat better?
- **Answer**: yes — 11 ranked transferable concepts; borrow patterns + lift 2-4 dependency-free MIT hooks verbatim; do NOT adopt `@astryxdesign/core` as a dependency.
- **Pipeline**: /research → SCOUT (astryx + self-map) → COMPARATOR → STRATEGIST → this brief. Next: /plan on the strategist's slices A-D.

---

# Strategist — ranked transferable concepts for the omp-squad webapp chat

Target: `webapp/src/components/AssistantChat.tsx` (1,396 lines) + `webapp/src/hooks/useSquad.ts` + `webapp/src/lib/ws.ts`. Webapp is React 19.2 + Tailwind CSS v4 + `react-markdown@10`/`remark-gfm`, WS transport with in-place transcript upserts. All paths verified against the working tree 2026-07-03.

## Overall build-vs-buy verdict

**Borrow patterns; lift two algorithm files nearly verbatim; do NOT adopt `@astryxdesign/core`.**

- Adopting the package is technically possible (React ≥19 requirement met) but would introduce StyleX-precompiled CSS, a theme provider, and a parallel token system alongside Tailwind v4 + our `--wf-*` tokens — two design systems in one app for one panel. Rejected.
- MIT license means the *algorithmic* files — explicitly free of StyleX/astryx-internal imports — can be copied with attribution headers preserved: `useChatStreamScroll.ts`, `useChatNewMessages.ts`, `useStreamingText.ts`, `useSpeechRecognition.ts`.
- Everything else transfers as a pattern reimplemented in our idiom (Tailwind, textarea, remark).

## Ranked concepts

### 1. Scroll lock state machine + resize-driven follow + "new messages" pill

**Concept**: Stick-to-bottom as an explicit lock/unlock state machine, not an unconditional scroll command.
**Pattern**: The list is "locked to bottom" by default. Any *user-initiated* upward scroll unlocks; settling back within ~10px of the bottom re-locks. While locked, content growth (detected by a ResizeObserver on the list content, not by data events) triggers a spring-animated `scrollTop` follow. Scroll events caused by content resize (`scrollHeight`/`offsetHeight` changed since last event) are filtered out and never change lock state. When unlocked and a new message lands, show a "jump to latest" pill instead of moving the viewport.
**Mechanism**: Port astryx's `useChatStreamScroll.ts` (rAF spring: `velocity = (damping·v + stiffness·diff)/mass`, wheel `deltaY<0`/`touchmove` interrupt the animation, `scrollend` re-lock) and `useChatNewMessages.ts` (shared ResizeObserver → `scrollIfLocked`; last-element identity change while unlocked → pill). Both are React-only, no styling deps — near-verbatim lifts.
**Value for omp-squad webapp**: Kills the #1 documented pain point — `AssistantChat.tsx:913-920` fires `scrollIntoView('smooth')` on every transcript/session/loading change, yanking the viewport down while the operator is reading history mid-run. The synthetic-scroll filter specifically covers our resize sources: TodoPanel collapse, tool `<details>` toggling, GateWidget appearing. The pill gives operators who scrolled up a way to know output landed.
**Where it applies**: Replace `scrollToBottom`/effect at `AssistantChat.tsx:913-920` (+ `messagesEndRef` L804/L1303); the same hooks should back the `TranscriptTimeline` embed in `TaskDetail.tsx:1457-1490`.
**Build vs Buy**: Lift the two hooks (MIT, keep copyright headers), restyle the pill in Tailwind. Known limitation to carry over: discrete large height jumps can outrun the spring (astryx issue #2282) — acceptable; add a snap threshold if it bites.

### 2. Stop control with `isStopShown` semantics

**Concept**: The send button becomes a stop button while the agent runs — modeled as "is the stop affordance visible," not "is the transport streaming."
**Pattern**: Composer state exposes `canSend`, `isStopShown`, `onStop`. One circular button toggles between send (primary, arrow) and stop (secondary, square). The flag is UI-semantic, deliberately decoupled from transport state, so multiple busy states (agent running vs. local optimistic send) don't conflate.
**Mechanism**: Derive `isStopShown` from the active session's agent status / presence of a `running` transcript entry; `onStop` sends the already-defined `{type:'interrupt', id}` `ClientCommand` over the WS (escalate to `kill` on second press or via a long-press menu).
**Value for omp-squad webapp**: The transport half already exists and is dead code — `interrupt`/`kill` are in the `ClientCommand` union (`src/web/dto.ts:337`, mirrored in webapp dto) but no chat button sends them. An agent console without a stop button is a factory-control gap, not just polish. Highest value-per-effort item found.
**Where it applies**: Send button at `AssistantChat.tsx:1377`; `handleSend`/`sendConsoleCommand` plumbing L972-1008; `isLoading` state L791.
**Build vs Buy**: Build — ~30 lines of wiring. Only the naming discipline is borrowed.

### 3. Live-region accessibility: `role="log"` + `aria-live="polite"` + `aria-busy`

**Concept**: The message list is a live region that announces completed messages once, not every streamed token.
**Pattern**: Scroll container gets `role="log"` `aria-live="polite"` `tabIndex={0}`; while any entry is streaming, `aria-busy=true` suppresses announcements so screen readers read the finished message once when it flips false. Messages render as `<article aria-label="Message from {sender}">`.
**Mechanism**: We already track `status:'running'` per `TranscriptEntry` — `aria-busy` is a one-line derivation. Also: remove or wire the decorative attach/mic buttons (`AssistantChat.tsx:1369-1374`) whose `aria-label`s promise functionality that doesn't exist (see concept 10 for the mic).
**Value for omp-squad webapp**: Closes an audit-flagged a11y hole at near-zero cost; makes streaming transcripts usable with a screen reader.
**Where it applies**: Messages scroll body `AssistantChat.tsx:1237`; `TranscriptEntryView` L421; same treatment in `TaskDetail.tsx`'s timeline embed.
**Build vs Buy**: Build — attributes only.

### 4. Streaming artifact suppression (pre-parse tail cleaning)

**Concept**: Clean the unsettled tail of streaming markdown before parsing so half-typed syntax never flashes raw.
**Pattern**: Before rendering a `running` assistant entry, transform only the streaming tail: trim unclosed `[`/`![` links and unpaired trailing `` ` ``/`*`/`~~`; auto-close mid-line unclosed `**bold` so formatting appears live rather than hidden; hold back bare `- ` bullets and lone table-header lines until structurally complete (once a table is established, new rows render immediately).
**Mechanism**: A pure string function `trimStreamingArtifacts(tail)` applied to the markdown string before it reaches `react-markdown`, only while `status === 'running'`. Port astryx's rules from `Markdown/parser.ts` (`trimStreamingArtifacts` + `trimUnsettledStructural`) as a standalone util with unit tests; no parser replacement.
**Value for omp-squad webapp**: Removes the torn-markdown flicker (stray `**`, half-built tables) in exactly our live-transcript path — agents emit heavy GFM (tables, code fences) constantly.
**Where it applies**: New `webapp/src/lib/streamingMarkdown.ts`; call sites at the two markdown invocations `AssistantChat.tsx:541` and `:1269` (which concept 8 merges into one).
**Build vs Buy**: Build — port the rule set, keep remark.

### 5. Settled-prefix memoization around react-markdown

**Concept**: Never re-parse markdown that has already structurally settled.
**Pattern**: Split streaming text at the last blank line outside a fenced code block ("settled boundary"). Render the settled prefix through a memoized component (re-renders only when the prefix string changes — i.e., when the boundary advances); re-parse only the small unsettled tail every tick. On stream end, collapse to a single render.
**Mechanism**: `findSettledBoundary(text)` (track fence state line-by-line, remember last blank line outside a fence) + `<MemoizedMarkdown text={settled}/><Markdown text={cleanedTail}/>`. Borrow the boundary algorithm from astryx's incremental parser; remark itself stays untouched.
**Value for omp-squad webapp**: Currently every WS frame re-runs remark over the full accumulated string for the growing entry; long assistant turns (multi-KB plan output) make that quadratic-ish over a turn. This bounds per-frame parse cost to the tail. Pairs with killing the 1s `now`-clock full-panel re-render (`AssistantChat.tsx:892-899` — move elapsed-time labels into a leaf component).
**Where it applies**: Same new `streamingMarkdown.ts` util + the shared assistant-markdown renderer from concept 8.
**Build vs Buy**: Build — the technique, not their 1,481-line parser. Explicitly do NOT replace remark.

### 6. Caret-anchored trigger-menu combobox for @-mentions

**Concept**: Trigger-character autocomplete as a proper caret-tracked combobox — on a plain textarea, skipping the contentEditable tax.
**Pattern**: Detect the trigger by scanning backward from `selectionStart` to an unconsumed `@` (not by splitting on spaces); anchor the popover at the caret; debounce the query; full combobox ARIA (`role="combobox"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`, `role="option"` items, `mousedown.preventDefault()` so focus stays in the input); insertion replaces the exact `[triggerStart, selectionStart)` range.
**Mechanism**: A `useTriggerMenu(textareaRef, triggers)` hook using `selectionStart`/`setRangeText`. Astryx's own tradeoff analysis says full contentEditable (~1,900 lines of caret/echo/portal edge cases) is a tax we shouldn't pay for one internal composer — token *chips* are the only thing we give up; a highlighted `@task-slug` text convention is enough.
**Value for omp-squad webapp**: Replaces the self-admittedly broken heuristic (`AssistantChat.tsx:1048` — "in a real app this would use a proper cursor/range detection"; `setTimeout(0)` + `split(' ')` breaks on multi-word task titles and mid-string edits) and gives the popup its missing ARIA. Extensible to a `/` command trigger (models, verify, land) later.
**Where it applies**: `handleKeyDown`/`insertMention` `AssistantChat.tsx:1038-1071`, popup L1324-1346.
**Build vs Buy**: Build — reimplement the pattern for textarea; their `useTriggerMenu.tsx` is contentEditable-coupled.

### 7. Tool-call chain collapse (latest + count)

**Concept**: Long tool-call runs summarize to the most recent call plus a count, expanding on demand.
**Pattern**: Consecutive tool entries group; collapsed state shows the latest call's row (spinner while running, tinted check/✗ when done, name/target/duration) plus "N previous steps"; expanding (grid-rows `0fr→1fr` animation) reveals all rows, each with its own expandable detail; rows keyboard-activatable (`role="button"`, Enter/Space, `aria-expanded`).
**Mechanism**: Group adjacent `kind:'tool'` entries in `TranscriptTimeline`; render a `ToolCallGroup` wrapping the existing per-call `<details>` renderer (keep its IN/OUT/ERR panes and raw-payload view as the row detail).
**Value for omp-squad webapp**: Our transcripts are dominated by tool chains — a 40-call implement run currently renders 40 stacked `<details>` blocks (`AssistantChat.tsx:437-506`), which is most of the scroll bloat and most of the un-virtualized DOM weight. Collapsing chains attacks the 800-entry jank risk without virtualization (astryx's deliberate no-virtualization bet + paging validates skipping a virtual list, which would fight `role="log"`).
**Where it applies**: `TranscriptTimeline` `AssistantChat.tsx:357-419` + tool renderer L437-506; benefits `TaskDetail.tsx` embed for free.
**Build vs Buy**: Build — presentation pattern only. Our `TranscriptTool` DTO already matches astryx's data-prop philosophy (independent convergence; keep it).

### 8. Single message model (kill the dual store)

**Concept**: One message representation, one render path; the UI owns zero conversation state it can't reconcile.
**Pattern**: Astryx components take one message array and render it; all state lives in the consumer's single model. Our chat instead holds two mutually-exclusive stores — localStorage `Message[]` vs live `TranscriptEntry[]` — switched by `hasTranscript ? [] : messages` (`AssistantChat.tsx:815`), which forces two duplicated markdown/bubble render paths and makes the optimistic user message vanish when the transcript attaches.
**Mechanism**: Convert legacy `Message` records to `TranscriptEntry` shape at read time (`{kind: role==='user'?'user':'assistant', format:'markdown', ...}`); render everything through `TranscriptTimeline`; delete the legacy bubble path (L1252-1290) and reconcile optimistic sends by `clientTurnId` instead of hiding them.
**Value for omp-squad webapp**: Kills three documented pain points at the root — duplicated markdown config (L541 vs L1269), duplicated user-bubble markup (L422-434 vs L1254-1262), and the vanishing optimistic message. Also the natural moment to split the 1,396-line monolith: `chat/` directory with `TranscriptTimeline`, `Composer`, `ToolCallGroup`, `useChatScroll` — and to move `TaskDetail`'s import off the monolith.
**Where it applies**: `AssistantChat.tsx` state L787-820, render paths L1237-1290; `Message`/`Session` types L15-55; `AssistantChat.test.tsx` contract.
**Build vs Buy**: Build — an internal refactor astryx's architecture validates rather than provides.

### 9. Styling contract: data attributes + design tokens for chat

**Concept**: Chat components expose stable machine-readable hooks (`data-sender`, `data-status`) and consume the app's token system instead of hardcoded utility colors.
**Pattern**: Every message/bubble/tool row emits data attributes reflecting its semantic state; visual values route through CSS custom properties (`--wf-*`) so theme changes (the planned indigo→ember dashboard pass) reach chat for free; components get grouping-aware styling (`group=first|middle|last` corner tightening) and an explicit ghost-vs-filled bubble variant.
**Mechanism**: Add `data-sender`/`data-kind`/`data-status` in `TranscriptEntryView`; swap raw `gray-*`/`amber-*` utilities for the `--wf-*` bridge classes already used by `webapp/src/components/ui/` primitives; extract `MessageBubble`/`MessageMetadata` (timestamp · footer · status) shared by both senders.
**Value for omp-squad webapp**: Chat is currently the only major surface ignoring our own token system (glance rebrand memory: dashboard token pass is pending — this prevents chat drifting again); data attributes give the e2e tests and future theming a stable contract.
**Where it applies**: `TranscriptEntryView` L421-545, bubble markup, `index.css` tokens L6-50.
**Build vs Buy**: Build — the `themeProps()` idea, not StyleX.

### 10. Composer quality bundle (textarea-native)

**Concept**: Terminal-grade composer ergonomics without a rich-text editor.
**Pattern & mechanism**:
- **Auto-grow**: textarea height tracks content up to `maxRows` (astryx caps at 8 lines) — replace fixed `min-h-12 max-h-40` (`AssistantChat.tsx:1348-1356`).
- **History recall**: ArrowUp/Down at edge positions cycles the session's prior user messages, preserving the current draft and select-all on recall.
- **Paste-as-chip**: pastes >200 chars (logs/diffs pasted at the fleet) collapse to a chip above the textarea with preview/expand/remove, appended to the outgoing prompt on send — the concept without contentEditable.
- **Honest mic**: lift astryx's headless `useSpeechRecognition` (start/stop/toggle/transcript, React-only) to make the existing no-op mic button (`L1369-1374`) real; skip the noise-floor/equalizer/plop-sound polish layer. Wire or remove the no-op attach button the same way (paste-as-chip infrastructure gives attach a home).
**Value for omp-squad webapp**: The composer is the operator's primary control surface for the fleet; these are the gaps between "demo input" and "daily-driver console". Each item is independently shippable.
**Where it applies**: Composer `AssistantChat.tsx:1322-1391`.
**Build vs Buy**: Build; `useSpeechRecognition.ts` is a verbatim-lift candidate (MIT).

### 11. Streaming text fade-in (optional polish)

**Concept**: New streamed text fades in via CSS `@starting-style`, keyed by stable length-boundary spans — zero JS animation.
**Pattern/Mechanism**: Ring buffer of recent text-length boundaries splits fresh text into spans with stable keys; each fades via `@starting-style { opacity: 0 }`. Optionally pair with `useStreamingText` chunk smoothing (rAF drains ~10 chars/tick) — but only if WS chunks prove bursty; our upsert granularity may already be smooth. Verify chunk size first.
**Value**: Perceived-quality polish; strictly after 1-10.
**Build vs Buy**: Build (CSS) + optional verbatim lift of `useStreamingText.ts`. Respect the existing reduced-motion guard (`index.css:196-202`).

## Explicitly rejected / deferred

- **Adopt `@astryxdesign/core`** — second design system alongside Tailwind v4; rejected.
- **Custom markdown parser** — keep remark; borrow techniques (concepts 4, 5).
- **ContentEditable composer + token chips** — astryx's own admitted complexity tax (~1,900 lines); textarea + concept 6/10 gets ~90% of the value.
- **CSS Custom Highlight API + hand-rolled tokenizer** — bigger lift with Safari fallback burden; revisit only if Prism re-highlight jank is *measured* during streaming. Cheap interim if needed: highlight only on `status!=='running'`.
- **Virtualized transcript list** — would fight `role="log"`/`aria-live`; astryx's deliberate no-virtualization bet + tool-chain collapse (concept 7) + optional scroll-up paging of the 800-entry cap is the chosen path.
- **Swizzle/codemod distribution machinery** — not applicable to an internal single-consumer app.
- **Vibe-tests / agent-docs injection** — out of chat scope, but noted as a separate idea worth its own thought: benchmark how well omp-squad's own conventions (plan-doc frontmatter, dispatch/land pipeline docs) steer fleet agents, the way astryx benchmarks its AGENTS.md. Candidate for a future `/research` or `/plan`.

## Suggested implementation slicing (for /plan)

- **Slice A — behavior fixes, no refactor** (concepts 1, 2, 3): scroll hooks + stop button + live-region ARIA. Small, independently landable, immediate operator value.
- **Slice B — streaming render quality** (4, 5, 11): `streamingMarkdown.ts` util + memoized settled prefix + optional fade.
- **Slice C — structure** (8, 9, 7): single message model, monolith split into `webapp/src/components/chat/`, tool-chain collapse, token/data-attribute contract.
- **Slice D — composer** (6, 10): trigger-menu combobox, auto-grow, history recall, paste-as-chip, honest mic/attach.

A→D is dependency-ordered but B/C/D are independent of each other once A lands.

---

# Comparator — concept extraction: astryx chat vs. omp-squad AssistantChat

Astryx commit `deb5aa0` (2026-07-03) vs. `webapp/src/components/AssistantChat.tsx` (1396 lines, single-file monolith) + `useSquad.ts`/`ws.ts`/`dto.ts`.

## Concept table

| Concept | How astryx implemented it | Target's current state | Transferable? | Why / why not |
|---|---|---|---|---|
| **Spring-based stick-to-bottom with lock/unlock state machine** | `useChatStreamScroll.ts`: rAF spring (`damping/stiffness/mass`) animates `scrollTop`; any upward scroll unlocks; `scrollend` within 10px of bottom re-locks; wheel/touch deltas interrupt immediately; filters Chrome synthetic-scroll events caused by `scrollHeight`/`offsetHeight` growth so resize ≠ user intent | `scrollToBottom()` via unconditional `scrollIntoView({behavior:'smooth'})` fired on *every* transcript/session/loading change (`AssistantChat.tsx:913-920`) — the target's own map calls this out as the #1 pain point: it yanks the viewport even when the user has scrolled up to read history | **Yes — highest priority** | Direct 1:1 match between a named astryx mechanism and a named target bug. The synthetic-scroll filter is especially relevant: target's own resize sources (TodoPanel collapse, tool-call `<details>` opening, GateWidget appearing) are exactly the "content resize, not user scroll" case astryx built the filter for. |
| **"New messages" pill via ResizeObserver on last-message element** | `useChatNewMessages.ts` — shared ResizeObserver drives scroll-follow while locked and flags "new message while unlocked" to surface `ChatLayoutScrollButton` | No affordance at all when scrolled up and new content arrives | Yes, pairs with the row above | Cheap once lock-state exists; without it, users who scroll up during a long agent run currently have no way to know new output landed. |
| **Chunk-smoothing rAF text reveal (`useStreamingText`)** | Drains ~10 chars/tick, theme-driven speed (duration token /10), snaps to full text when `isStreaming` flips false | Text arrives as whole-string upserts via WS (`appendTranscriptEntry` replaces by `entry.id`); reveal cadence = whatever the agent SDK's chunking produces, no artificial smoothing | Partial | Only worth it if the WS transcript stream is bursty (large chunks, not token-by-token). Unknown from the map — needs a look at the actual chunk granularity from the agent SDK before investing; if chunks already arrive small and frequent, this is solving a problem the target doesn't have. |
| **Incremental markdown parsing with settled-prefix caching** | `Markdown/parser.ts`: splits at the last blank line outside a fenced block, caches parsed AST for the settled prefix, only reparses the streaming tail | `react-markdown` re-renders (and remark re-parses) the full string on every transcript delta for `running` assistant entries | **Yes, as a pattern** | This is the single most relevant *performance* concept for "renders agent transcripts... over a WebSocket." Target is committed to the remark/GFM ecosystem (correctly — see Design Tensions), so the transferable piece isn't astryx's custom parser, it's the *technique*: memoize parsed blocks for text that hasn't changed since the last render, only re-run remark on the tail. Long assistant turns with growing markdown will otherwise rebuild the whole AST on every WS frame. |
| **Streaming artifact suppression** (`trimStreamingArtifacts`) | Auto-closes mid-line unclosed `**bold**`; holds back bare `- ` bullets and lone table-header rows until they're structurally complete; trims unclosed links | None — raw markdown syntax (stray `**`, half-built tables) likely flashes unstyled while an assistant entry is `status:'running'` | **Yes, directly** | Concrete, reproducible visual noise in exactly the target's live-transcript path. Pure string transform, no contentEditable/StyleX dependency — cleanly portable regardless of markdown engine choice. |
| **Per-span fade-in via `@starting-style`, stable boundary keys** | `Markdown/streaming.ts` + `StreamingCursor` — ring-buffer of length boundaries, each new span fades in via CSS only | No fade; new/updated text just appears | Yes, low priority | CSS-only, cheap, but polish — lower ROI than the scroll fix or artifact suppression for a transcript reader prioritizing legibility over transitions. |
| **Composer dock as sticky/fixed frosted-glass overlay** | `ChatLayout.tsx` — backdrop-blur dock, sticky↔fixed depending on `scrollRef` | Composer already docked at panel bottom, solid background | Partial, cosmetic | Implementation detail more than concept; only worth adopting during a broader visual pass. |
| **ContentEditable rich composer with token chips (portal-rendered)** | `ChatComposerInput.tsx` (707 lines) + `useChatComposerTokens.ts` — ~1,900 lines total of caret/selection/paste/echo edge cases (`pendingEchoValueRef`, NBSP dance, `ensureCaretInside`) | Plain `<textarea>`; @-mention is a `setTimeout(…,0)` + `split(' ')` last-word heuristic the code itself admits is a placeholder ("in a real app this would use a proper cursor/range detection") | **Pattern only, with caution** | Astryx's own §5 tension calls this a complexity tax it pays deliberately. Recommend NOT porting full contentEditable — instead lift the trigger-menu/combobox pattern onto the existing textarea via `selectionStart`/caret-offset tracking. Full rich-text is a large, ongoing maintenance cost for one internal composer. |
| **Trigger-menu combobox** (`useTriggerMenu.tsx`) — debounced `SearchSource`, full ARIA combobox (`aria-expanded`, `aria-controls`, `aria-activedescendant`, `role="option"`) | Caret-anchored popover, keeps focus in the editable via `mousedown.preventDefault()` | @-mention popup exists but has zero ARIA relationship to the input and the documented last-word-split bug (breaks on multi-word task titles, mid-string edits) | **Yes — directly fixes a named target bug** | This is the scoped fix for the exact fragility the target's own comment flags. Doesn't require contentEditable — a textarea + caret-offset detection + combobox ARIA gets 90% of the value without the ~1,900-line tax. |
| **Paste-as-token** (`useChatPasteAsToken.ts`) — long pastes (>200 chars) collapse into a chip with expand | HoverCard preview + "Expand" back into text; file pastes route to `onFiles` | Textarea just inlines whatever is pasted (including large log/diff dumps a user might paste in) | Yes | Agent-transcript composers routinely receive large pasted logs/diffs from users debugging with the agent; a textarea-based analog (detect paste length → store as attachment → render chip above textarea) captures the concept without contentEditable. |
| **ArrowUp/Down message-history recall with draft preservation** | Terminal-style recall in `ChatComposerInput` | Not implemented — only Enter/Shift+Enter wired | Yes, cheap | Target already has session `Message[]` history to recall from; low effort, familiar UX. |
| **`isStopShown` composer semantics** — deliberately named "is the stop button visible," decoupled from "is streaming" (codemod-migrated from `isStreaming` in v0.0.15) | `ChatSendButton` reads `canSend`/`isStopShown`/`onStop` from composer context | **No stop/interrupt button exists at all** in the composer, despite `interrupt`/`kill` already being first-class members of `ClientCommand` (`dto.ts:337`) | **Yes — highest priority, near-zero transport cost** | The hard part (transport capability) is already built and unused. This is purely a UI-state-naming and wiring gap. Astryx's naming discipline is directly the right model since target has multiple distinguishable busy states (agent running vs. local optimistic send) that a naive `isLoading` boolean conflates. |
| **Tool-call collapse-to-latest + count, expandable rows** (`ChatToolCalls.tsx`) | 1 call renders inline; >1 collapses to latest+count with a grid-row expand animation; per-row expandable `resultDetail` | Every tool call gets its own always-rendered `<details>` (`AssistantChat.tsx:437-506`), no grouping for long chains | **Yes** | Target explicitly renders "agent transcripts (tool calls...)" — long tool-call sequences are the norm, not the edge case, for this product. Collapsing chains directly reduces scroll length; native `<details>` can keep its simplicity wrapped in a "show N more" collapse. |
| **Tool-call data-prop philosophy** — "accept raw arrays shaped like the LLM API already returns," no compound components | `ChatToolCalls` takes `calls: ChatToolCallItem[]` directly | `TranscriptEntry.tool` (`dto.ts:198`) is already structured this way (name/argsText/partialText/resultText/durationMs) | N/A — already adopted | Confirms target's existing DTO shape is sound, not an accident — validated by a mature design system converging on the same shape independently. No action needed. |
| **Bubble grouping** (`group='first'\|'middle'\|'last'` tightens sender-side corner radii for consecutive same-sender bubbles) | `ChatMessageBubble` | No grouping concept — every consecutive message (including runs of tool/assistant entries) renders as a fully independent bubble | Yes, low effort | Cheap density win; secondary to the functional gaps above. |
| **Ghost bubble variant** (no background, padding only — recommended for AI markdown/code responses) | `ChatMessageBubble variant='ghost'` | Assistant markdown already renders in unstyled `prose` typography, functionally already "ghost" by convention rather than by an explicit variant system | Partial — already achieved ad hoc | No new capability; would only formalize what's already the de facto pattern. |
| **Dedicated message-metadata slot** (timestamp/footer/5-state status row) | `ChatMessageMetadata` | Ad hoc inline metadata duplicated across the transcript path and the legacy `Message[]` path | Yes, as componentization | Doesn't add capability but directly resolves a documented target pain point (duplicated bubble markup) by giving both render paths one shared component to call. |
| **`ChatSystemMessage`** — explicitly-non-sender centered divider | Dedicated component | `format:'stage'` divider already exists (`L439-448`) | N/A — already adopted independently | Astryx validates the pattern; no change needed. |
| **`role="log"` + `aria-live="polite"` + `aria-busy` toggling once per stream completion** | `ChatMessageList.tsx` — `aria-busy` set from `isStreaming` so screen readers announce the finished message once, not every token | Messages scroll region has **no role/aria-live at all** — flagged independently in the target's own audit as an a11y gap | **Yes — trivial effort, high value** | Near-zero-cost fix, independently flagged as missing on both sides. Target already tracks `status:'running'` per entry — the state exists, it's just not exposed to the accessibility tree. |
| **Combobox ARIA on the trigger-menu input** | Full `aria-expanded`/`aria-controls`/`aria-activedescendant`/`role="option"` wiring | @-mention popup has zero ARIA relationship to the textarea | Yes, pairs with the trigger-menu row | Screen-reader users currently get no signal that an autocomplete menu opened. |
| **CSS Custom Highlight API + cooperative (`scheduler.yield()`) hand-rolled tokenizer** | `CodeBlock/tokenizer.ts` — per-line regex tokenizer, Safari fallback via span rendering | Lazy-loaded Prism (`vscDarkPlus`), full synchronous grammar-based re-tokenization, no yielding | **Pattern only, low urgency** | Prism has no incremental/yielding mode; a long fenced code block growing char-by-char during a streaming assistant turn could jank the main thread on full re-highlight each tick. The transferable idea is "yield during highlighting of growing blocks," not the CSS Highlight API itself — that's a bigger lift (Safari fallback, StyleX-free reimplementation) with no signalled Safari constraint in target. Watch for reported jank before investing. |
| **`themeProps()` — stable class + `data-*` attribute contract, private component CSS vars** | Every astryx component emits `data-sender`, `data-density`, etc. plus vars like `--_chat-composer-radius` | Chat uses raw Tailwind `gray-*`/`amber-*` utilities directly in JSX; target's own `--wf-*` design-token system (used by the dashboard `ui/` primitives) is **not** applied to chat at all | Yes, as an internal-consistency fix | Target already built the token system this validates — it just isn't wired to chat. Also gives a natural e2e/test-targeting hook (`data-sender="user"`) that the target currently lacks. |
| **Dictation stack** (noise-floor calibration, mic-volume equalizer bars, sustained-volume mode, interim-text DOM insertion) | `useChatDictation.ts` + `useSpeechRecognition.ts` (~950 lines) + `ChatDictationButton` | Mic button exists in the composer with an `aria-label` promising dictation but **no onClick** — a decorative no-op explicitly flagged as an a11y-misleading gap in the target's own audit | **Yes, but scope narrowly** | Target already has the slot and the aria promise; lift only the headless `useSpeechRecognition` (start/stop/toggle/transcript) to make the existing button honest. Defer the noise-floor/equalizer/plop-sound polish layer — that's Meta-scale investment, not required to close the flagged gap. |
| **Zero owned conversation state** — presentational components take strings/arrays, consumer owns the message model | Four tiny contexts only; no store, no reducer | **Two parallel, only-partially-reconciled stores**: localStorage `Message[]` + live `TranscriptEntry[]` via context, reconciled by the fragile `hasTranscript ? [] : messages` mutual-exclusion hack, each with its own duplicated markdown/bubble render path | **Yes, as an architectural argument** | Astryx's stance validates collapsing target's dual-store split into one message model (e.g., converting legacy `Message[]` sessions to `TranscriptEntry`-shaped records at read time). This kills two of target's own documented pain points — duplicated markdown logic, duplicated user-bubble markup — at the root instead of patching each duplicate independently. |
| **Deliberate "no virtualization" bet** — justified by `role=log`/a11y simplicity; long history via paginated infinite-scroll-up loader instead | `ChatMessageList` `scrollToTopAction` + IntersectionObserver sentinel | Renders all `TRANSCRIPT_CAP=800` entries un-virtualized — target's own audit flags this as a jank risk for big runs | Yes, as reassurance + a concrete alternative | Astryx made the identical bet at Meta's scale for identical a11y reasons. Legitimizes *not* reaching for a virtualized list (which fights `role=log`/`aria-live`) and instead solving the jank risk astryx's way — an infinite-scroll-up loader with a "load more history" affordance rather than virtualization, if 800 entries proves too slow in practice. |
| **Swizzle / copy-in ejection model** (`npx astryx swizzle` pulls one component's full source, rewrites imports) vs. npm-install-a-library distribution | CLI command | N/A — target has one internal consumer (its own webapp), no distribution model | No | Considered and correctly excluded — not relevant to a single-app internal codebase. |
| **Codemod-based API-churn migration** (`astryx upgrade --apply`, e.g. `isStreaming→isStopShown`) | CLI + jscodeshift | N/A — no external API surface to migrate | No | Same reasoning as above; a distribution-model concept. |
| **"Agent ready" docs machinery** — `.doc.mjs` manifests, CLAUDE.md/AGENTS.md marker-block injection, dense-language docs, `vibe-tests` benchmarking how well the docs make an LLM generate correct code | `packages/cli/src/commands/agent-docs.mjs`, `internal/vibe-tests/` | Not applicable to chat specifically — omp-squad isn't a component library; its "consumers" are the fleet's own agents calling internal APIs (Plane pipeline, plan-doc frontmatter, WS protocol), not humans importing an npm package | **Conceptually yes, but redirect away from chat** | The meta-move — measure whether your own docs make an LLM produce correct code against your system, and iterate on docs like a product — is a good fit for omp-squad's *own* internal conventions (dispatch/land/plan pipeline), not for the chat UI. Judged seriously, but scoped out of this comparison's target surface. |

## Design tensions

1. **ContentEditable complexity tax vs. target's fragile @-mention.** Astryx pays ~1,900 lines of caret/selection/paste/echo edge cases to get tokens and rich composer features; the target's textarea-based heuristic is simpler but admittedly broken for multi-word titles. The tension resolves the same way astryx itself frames it: don't adopt full contentEditable for one internal composer — lift only the trigger-menu/combobox ARIA pattern onto the existing textarea. Full rich-text is the wrong trade for this codebase's scale.
2. **Custom markdown parser (owns incremental settling + artifact suppression) vs. target's `react-markdown`/`remark-gfm` ecosystem dependency.** Astryx pays a 1,481-line parser to maintain in exchange for streaming-native behavior remark can't do mid-stream. Target should NOT replace remark (GFM completeness, ecosystem maintenance matter more here than at Meta's component-library scale) — but should borrow the *techniques* (settled-prefix caching, artifact trimming) as a thin layer around remark rather than inside a hand-rolled parser.
3. **No virtualization, in both projects — but for different reasons.** Astryx made this a deliberate, reasoned bet (a11y simplicity). Target arrived at the same place by default and is now worried about it. The astryx precedent argues for fixing the actual symptom (800 un-virtualized entries) with pagination/infinite-scroll-up rather than reaching for virtualization, which would undermine the `role=log` fix this brief also recommends.
4. **Modern-browser bets** (`CSS.highlights`, `@starting-style`, `scrollend`, container queries, `scheduler.yield()`) are cheap to adopt piecemeal in an internal tool with no stated Safari/legacy constraint — but the CSS Custom Highlight API specifically requires a fallback path astryx had to build; not worth the lift until Prism's synchronous re-highlight is a *measured* problem, not a theoretical one.
5. **Presentational-only "own zero state" philosophy vs. target's dual-store reality.** Astryx's stance isn't just a nice architecture — it's a direct indictment of the target's `hasTranscript ? [] : messages` mutual-exclusion hack and the two duplicated render paths it forces. This is the one tension where astryx isn't offering a new feature so much as validating that the target's existing pain (self-documented) has a known, principled fix.
6. **Meta-flavored tool-call schema** (`node`, `additions/deletions` baked into the generic `ChatToolCalls` API) vs. target's own `TranscriptTool` shape, which is already domain-fitted (paired with a separate `DiffReviewPanel` for diffs). No real tension — target's separation of concerns is arguably cleaner for its use case; the only thing worth borrowing is the *presentation* pattern (collapse-to-latest+count), not the schema.

## Strongest signals

1. **Scroll lock state machine (`useChatStreamScroll`)** — the cleanest 1:1 match in the whole comparison: astryx's named mechanism directly solves the target's own named #1 pain point (unconditional `scrollIntoView` yanking the viewport). Includes a synthetic-scroll filter that matches target's own resize sources almost exactly.
2. **`isStopShown` + wire up interrupt/kill** — the transport capability (`ClientCommand.interrupt/kill`) already exists and is unused; this is pure UI wiring with a well-reasoned state-naming model, not new infrastructure. Highest value-per-effort item on the list.
3. **Streaming artifact suppression** — a pure string-transform algorithm, no contentEditable/StyleX dependency, that removes a concrete visual defect (torn markdown flashing) in exactly the target's live-transcript path.
4. **`role="log"` + `aria-live="polite"` + `aria-busy`** — trivial to add, independently flagged as missing in both briefs, and the underlying state (`status:'running'`) already exists in the target's data model.
5. **Trigger-menu combobox pattern** — fixes a bug the target's own code comments admit is broken (last-word-split @-mention heuristic), without requiring the full contentEditable rewrite astryx paid for.
6. **Tool-call collapse-to-latest + count** — directly relevant given the target's product is specifically an agent-transcript viewer with long tool-call chains; reduces the exact kind of scroll bloat this UI is most prone to.
7. **Incremental markdown parsing as a pattern (settled-prefix caching around remark, not a parser rewrite)** — the strongest *performance* concept for exactly the target's use case (WS-driven, incrementally-growing assistant markdown), scoped correctly to avoid replacing the remark ecosystem.
8. **Single message-model architecture** — not a component to port but the validating argument for a refactor the target's own audit already wants: collapsing the dual local/live stores kills two documented duplication problems (markdown logic, user-bubble markup) at the source.

---

# RESEARCH BRIEF — facebook/astryx: chat / AI-conversation components

Investigated at commit `deb5aa0` (2026-07-03), via shallow clone. All paths below are repo-relative.

## 1. What astryx is

Astryx is Meta's open-source React design system (grew inside Meta over ~8 years, "13,000+ apps"), shipped as pre-built npm packages with StyleX-authored styles, CSS-custom-property theming, and a CLI whose docs/templates are explicitly co-designed for AI coding agents ("agent ready"). Beta since Jan 2026, ~4.4k stars, `@astryxdesign/core` at v0.1.2.

### Architecture / distribution

- **Monorepo layout**: `packages/core` (150+ components + theme system, the only runtime dep is `@stylexjs/stylex ^0.18.3`; peer React >=19), `packages/cli` (docs/templates/scaffolding/codemods; deps: commander, jscodeshift, zod, jiti, @clack/prompts), `packages/build` (StyleX build plugins — optional, source builds only), `packages/themes/{neutral,butter,chocolate,matcha,stone,gothic,y2k}` (each theme = a package of CSS var overrides, e.g. `packages/themes/neutral/src/neutralTheme.ts` ~28KB), `packages/lab` (experimental, unpublished — includes `ChatReasoning`), `packages/vega` (charts, unpublished).
- **Distribution model is npm-first, not shadcn copy-in**: you `npm install @astryxdesign/core` + a theme, import three pre-built CSS files, wrap in a theme provider — no build plugin. The copy-in escape hatch is `npx astryx swizzle <Component>`, which ejects a component's full source into your project and rewrites relative imports to package subpaths (`packages/cli/src/commands/swizzle.mjs`). Block/page **templates** are copy-in via `npx astryx template` (`packages/cli/templates/blocks/components/` holds ~1,200 example files, incl. ~40 chat examples).
- **Styling**: authored in StyleX (`stylex.create` in every component) but invisible to consumers — components accept `className`, `style`, and `xstyle` (StyleX override). Every component also emits stable theming hooks via `themeProps()` (`packages/core/src/utils/themeProps.ts`): a stable class (`astryx-chat-message-bubble`), variant classes, and reflected data attributes (`data-sender="user"`, `data-density`), so themes/consumers target `@scope`d data-attribute selectors. Tokens are CSS vars (`--spacing-*`, `--color-*`, `--radius-*`, `--duration-*`, `--ease-*`) exposed to StyleX via `packages/core/src/theme/tokens.stylex.ts`; themes override them via `defineTheme`. Components additionally expose private component vars, e.g. `--_chat-composer-radius`.
- **"Agent ready" concretely means**:
  - Every component has a machine-readable `.doc.mjs` (typed `ComponentDoc` — props, best-practice do/don't bullets, anatomy, theming targets/vars) readable at runtime: `node node_modules/@astryxdesign/core/docs.mjs <Component>`.
  - `npx astryx agent-docs` generates a CLI cheat sheet and injects it into CLAUDE.md / AGENTS.md / .cursorrules between `<!-- ASTRYX:START/END -->` markers, with per-tool presets (`packages/cli/src/commands/agent-docs.mjs`).
  - Docs have a token-compressed "dense" language: `astryx component Button --lang dense` reads a `docsDense` translation authored per the `.claude/skills/dense-compression-protocol.md` skill.
  - `internal/vibe-tests/` is a benchmark harness that measures how well AGENTS.md makes LLMs generate correct astryx code (personas: naive/experienced/adversarial, 10-turn degradation curves) — driven by the root `CLAUDE.md` `/vibe-test` command.
  - Codemod-based upgrades (`astryx upgrade --apply`), e.g. `rename-isStreaming-to-isStopShown` (v0.0.15), `rename-attachments-to-drawer` (v0.0.13) — API churn is machine-migratable.
  - README principle: "Every change that made Astryx easier for AI made it easier for people too."

## 2. Chat component inventory

Core chat family lives in `packages/core/src/Chat/` (~9,100 lines incl. tests); supporting renderers in `packages/core/src/Markdown/`, `CodeBlock/`, `Citation/`; the smoothing hook in `packages/core/src/hooks/useStreamingText.ts`. Storybook stories in `apps/storybook/stories/Chat*.stories.tsx`.

| Component | File | What it does |
|---|---|---|
| `ChatLayout` | `Chat/ChatLayout.tsx` | Full-chat shell: message area in page flow + composer fixed in a bottom "frosted glass dock" (backdrop-blur layer w/ gradient mask). Owns default scroll behavior by composing `useChatStreamScroll` + `useChatNewMessages`; renders default `ChatLayoutScrollButton`. Supports external `scrollRef` (e.g. `document.documentElement`) — dock switches sticky↔fixed accordingly. Density prop compact/balanced/spacious; `containerType: 'inline-size'` for container queries. |
| `ChatMessageList` | `Chat/ChatMessageList.tsx` | Purely presentational `role="log"` `aria-live="polite"` container. `isStreaming` prop sets `aria-busy` so SRs announce the finished message once instead of every token. Flex column with a `flex:1` spacer that pushes messages to the bottom; `scrollToTopAction` = async infinite-scroll loader via IntersectionObserver sentinel + `useTransition` spinner; `emptyState`; density/gap via context. |
| `ChatMessage` | `Chat/ChatMessage.tsx` | Sender wrapper (`sender: 'user'|'assistant'|'system'`) rendered as `<article>` with `aria-labelledby` the name or `aria-label="Message from {sender}"`. Handles avatar column, name row, alignment (user = `row-reverse`), and provides sender+density context. |
| `ChatMessageBubble` | `Chat/ChatMessageBubble.tsx` | The styled bubble. Reads sender from context; `variant='filled'|'ghost'` (ghost = no background, keeps inline padding — recommended for AI markdown/code responses); `group='first'|'middle'|'last'` tightens sender-side corner radii for consecutive-bubble grouping; `name`/`metadata` slots aligned to bubble padding; `max-width: max(80%, 280px)`; dedicated `--radius-chat` (28px) decoupled from card radius. |
| `ChatMessageMetadata` | `Chat/ChatMessageMetadata.tsx` | `timestamp · footer · status` row; `status: 'sending'|'sent'|'delivered'|'read'|'error'`; direction reverses for user sender. |
| `ChatSystemMessage` | `Chat/ChatSystemMessage.tsx` | Centered muted notices/date separators (`variant="divider"`); explicitly not a sender message. |
| `ChatComposer` | `Chat/ChatComposer.tsx` | Slot-based composer shell: `drawer`, `headerActions`, `headerContext`, `input`, `footerActions`, `sendActions`, `sendButton`, `status` (+`statusPosition`). Controlled or uncontrolled `value`; `onSubmit` (trims, clears), `onStop` + `isStopShown` for streaming stop; publishes all of it via `ChatComposerContext` so child parts "just work". Click-on-empty-space focuses the editable (skips interactive targets). Status bar is a colored strip that slides out from behind the rounded body via negative margins. Concentric radius: `--_button-radius = max(--radius-element, calc(--_chat-composer-radius − --_chat-composer-padding))`. |
| `ChatComposerInput` | `Chat/ChatComposerInput.tsx` (707 lines) | ContentEditable rich input (not a textarea): trigger menus (@/slash) via `triggers[]`, inline token chips, Enter/Shift+Enter, ArrowUp/Down message history with draft preservation, paste/drop file handling (`onFiles`), paste-as-token, `maxRows` (8 × 22px line height), `handleRef` imperative handle (`insertToken/expandToken/insertText/focus/getValue`). iOS zoom guard: `@media (pointer: coarse)` font-size `max(1rem, …)`. |
| `ChatSendButton` | `Chat/ChatSendButton.tsx` | Circular send/stop toggle reading `canSend`/`isStopShown`/`onStop` from composer context; primary+arrowUp vs secondary+stop. |
| `ChatComposerDrawer` | `Chat/ChatComposerDrawer.tsx` | Collapsible panel above the input (attachments, context chips); collapsed state shows `count` + `label` badge; `grid-template-rows: 0fr→1fr` height animation. |
| `ChatToolCalls` | `Chat/ChatToolCalls.tsx` (632 lines) | Tool/function-call display. **Data-prop, not compound**: takes `calls: ChatToolCallItem[]` "matching the shape LLM APIs already return" (name, status pending/running/complete/error, target, duration, node pill, additions/deletions ±diff stats, errorMessage, resultDetail). 1 call renders inline; >1 collapses to the latest call + count, expanding (grid-rows animation) to all rows; per-row expandable `resultDetail`; spinner while running, tinted check/x when done; keyboard-activatable rows (`role="button"`, Enter/Space). |
| `ChatTokenizedText` | `Chat/ChatTokenizedText.tsx` | Renders a plain message string with token values replaced by inline badges — same `ChatComposerToken` definitions work for input and display. |
| `ChatLayoutScrollButton` | `Chat/ChatLayoutScrollButton.tsx` | Scroll-to-bottom pill in the dock; fades/translates in, expands to show a label ("New messages"). |
| `ChatDictationButton` + `useChatDictation` + `useSpeechRecognition` | `Chat/ChatDictationButton.tsx`, `useChatDictation.ts` (488), `useSpeechRecognition.ts` (449) | Voice input: headless SpeechRecognition wrapper (start/stop/toggle, transcript, mic volume via AudioContext analyser) + a full hook adding noise-floor calibration, frequency bands, synthesized "plop" feedback sounds (sine oscillator envelopes), sustained-volume "CAPS LOCK" mode, and interim-text DOM insertion into the input (`data-astryx-dictation-interim`). Button renders live equalizer bars from real mic input. |
| `ChatReasoning` (lab, unpublished) | `packages/lab/src/ChatReasoning/ChatReasoning.tsx` | Compact one-line collapsible "thinking" display: label + duration + ellipsized preview, shimmer animation while `isStreaming`, expandable to full reasoning. |
| `Markdown` | `Markdown/Markdown.tsx` (1,738) + `parser.ts` (1,481) + `streaming.ts` | Zero-dependency markdown renderer mapping AST→astryx components (CodeBlock, Table, List, CheckboxList, Blockquote, Citation…). Streaming-native (see §3). `components` overrides per node type, `inlinePlugins` (Lexical-style TextMatchTransformer: pattern/getEndIndex/render), `sources`+`citationStyle` for citations, `headingLevelStart`, `contentWidth` (prose capped, tables/code full-width), opt-in GFM `autolink`. |
| `Citation` | `Citation/Citation.tsx` | Inline citation chip; `variant 'label'` (title+icon pill) or `'number'` (superscript badge). Markdown turns `[id]`/`【id】` matching a source key into these, numbering in encounter order. |
| `CodeBlock` | `CodeBlock/CodeBlock.tsx` (835) + `tokenizer.ts` + `highlightRanges.ts` | Custom regex-based per-line tokenizer (no shiki/prism; cooperative-yields via `scheduler.yield()`); highlights via the **CSS Custom Highlight API** (`CSS.highlights`, Range objects per line) with span fallback (auto-detects Safari rendering bugs); copy button, line numbers, `highlightLines`, collapsible with threshold, `width: fit-content` default, `container: 'card'|'section'`, pluggable `tokenizer` prop. |
| `useStreamingText` | `hooks/useStreamingText.ts` | The chunk-smoothing hook (see §3). |

Also chat-adjacent: `Typeahead` `SearchSource` (shared search abstraction powering trigger menus, sync/async + `cancel()` + `createStaticSource()`), `Timestamp`, `Avatar`, `Skeleton`, `Spinner`.

## 3. Key mechanisms (the interesting engineering)

### Streaming pipeline (three cooperating layers)
1. **`useStreamingText(targetText, isStreaming, {speed})`** (`hooks/useStreamingText.ts`) — decouples bursty chunk arrival from display: rAF loop drains ~10 chars per tick (`natural`; `fast`=4 chars at half the tick interval; `instant` bypasses). Tick interval is derived from the theme's motion token `--duration-fast-min` /10 (≈13ms), floored at 4ms — animation speed is *themeable*. Snaps to full text the moment `isStreaming` flips false; resets when target clears.
2. **Incremental parser** (`Markdown/parser.ts` `parseMarkdownIncremental` + `IncrementalState`) — splits input at the last blank line *outside* fenced code (`findSettledBoundary`); settled prefix blocks are cached and only the delta is re-parsed (with adjacent-list merging per CommonMark §5.3 via `mergeSettledBlocks`); the unsettled tail is re-parsed each tick. Cache invalidates if the settled prefix mutates or the `autolink` option flips.
3. **Artifact suppression** (`trimStreamingArtifacts` + `trimUnsettledStructural`, same file) — the streaming tail is cleaned before parse: unclosed `[`/`![` links trimmed; trailing unpaired backticks/`*`/`~~` trimmed; **mid-line unclosed `**bold` is auto-closed rather than hidden** so formatting appears live; bare `- ` bullets, lone table-header lines (until the separator row arrives), and orphan separators are held back — once a table is established, new rows render immediately.
4. **Fade-in rendering** (`Markdown/streaming.ts` + `Markdown.tsx` `StreamingCursor`) — a mutable character-offset cursor is threaded through the whole render tree; a ring buffer of recent length boundaries (`computeBoundaries`, capped at `maxSpans = min(ceil(fadeDuration/tick), 12)`, computed from motion tokens) splits new text into spans (`computeSegments`) with stable React keys (`fade-{node}-b{boundary}`); each new span fades in with CSS `@starting-style { opacity: 0 }` — no JS animation. Evicted boundaries merge into the "settled" span.

### Auto-scroll / stick-to-bottom (`Chat/useChatStreamScroll.ts`)
- Not `scrollIntoView`: a **rAF spring** (`velocity = (damping·v + stiffness·diff)/mass`, defaults damping 0.7 / stiffness 0.05 / mass 1.25, time-normalized to 60fps) animates `scrollTop` toward bottom while "locked".
- Lock state machine: **any upward scroll unlocks** (direction detected by comparing `scrollTop` to last value — works for wheel/touch/scrollbar/keyboard); `scrollend` within `lockThreshold` (10px) of bottom **re-locks**; `wheel` deltaY<0 and `touchmove` interrupt the animation immediately (they fire before scroll position updates).
- **Chrome synthetic-scroll filter**: scroll events caused by `scrollHeight`/`offsetHeight` changes (content resize, on-screen keyboard) are detected by tracking both values and never change lock state — the classic streaming-chat bug.
- Scrollbar is hidden during programmatic animation via `[data-astryx-scrolling]` + `scrollbarWidth: none` (ChatLayout styles).
- Companion `useChatNewMessages` (`Chat/useChatNewMessages.ts`): a shared ResizeObserver on the list content fires `onResize → scrollIfLocked` (this is how streaming growth triggers follow), and detects "new message while unlocked" by watching the last `.astryx-chat-message` element change → drives the "New messages" pill. Known limitation documented in `apps/storybook/stories/ChatAutoScroll.stories.tsx` (issue #2282): discrete large height jumps (tool calls, big custom blocks) can outrun the spring.

### Composer input (contentEditable, not textarea)
- Serialization walks the DOM: text nodes as-is, `data-astryx-token` spans contribute `data-astryx-token-value`, `<br>` → `\n` (`ChatComposerInput.tsx` `serialize`).
- Tokens are non-editable inline spans whose React content (Badge or custom `render()`) is rendered **via `createPortal` into DOM-created spans** (`useChatComposerTokens.ts`); Backspace/paste adjacency edge cases handled manually; NBSP trailing spacer removed together with its token.
- Controlled-value echo problem solved with a one-shot `pendingEchoValueRef`: skip exactly one resync of the value we just emitted (resync would collapse the caret and drop fast keystrokes); genuine external sets rewrite `textContent` and restore caret to end.
- Trigger menus (`useTriggerMenu.tsx`, 711 lines): detects trigger chars, opens popover at caret, debounced (150ms) `SearchSource` search, full **combobox ARIA** on the textbox (`aria-expanded`, `aria-controls`, `aria-activedescendant`, `aria-haspopup="listbox"`, `role="option"` items, mousedown-preventDefault to keep focus in the editable).
- Paste-as-token (`useChatPasteAsToken.ts`): pastes >200 chars become a chip (`ChatPastedTextToken` = badge + HoverCard preview + "Expand" back into text). File pastes route to `onFiles`.
- Message history: ArrowUp/Down recall with current-draft preservation and select-all on recall (mirrors terminal UX).
- `chatComposerSelection.ts` `ensureCaretInside`: browsers don't create a Selection Range on programmatic focus — centralizes placing a collapsed caret at end before any imperative insert/paste.

### Accessibility summary
- List: `role="log"` + `aria-live="polite"` + `aria-busy` during streams (changeset `.changeset/chat-streaming-aria-busy.md`); `tabIndex={0}` scrollable region.
- Message: `<article>` + label; composer editable: `role="textbox"` `aria-multiline` + combobox pattern; status bar `role="alert"`/`role="status"`; tool-call rows and group headers keyboard-activatable with `aria-expanded`; scroll button always has an accessible label.
- Motion/animation exclusively via theme duration/ease tokens; expand/collapse via `grid-template-rows 0fr→1fr`; fades via `@starting-style`.

### State management
No store, no reducer, no message model. Astryx deliberately owns **zero conversation state** — you keep messages/streams in your own state (or Vercel AI SDK etc.) and pass strings/arrays down. Coordination is via four tiny contexts (`Chat/ChatContext.tsx`: message sender/density, list density, composer value/handlers, layout scroll refs). `ChatToolCalls` takes raw arrays shaped like LLM API responses by design (stated rationale in the file header).

## 4. Tech stack of the chat parts

- React ≥19 (uses `use()`, ref-as-prop, `useTransition`), TypeScript, StyleX 0.18 (pre-compiled for consumers).
- **Zero third-party runtime deps** in the chat/markdown/code path: hand-written markdown parser, hand-written tokenizer, CSS Highlight API, Web Speech API, AudioContext, ResizeObserver/IntersectionObserver, `scrollend`, `@starting-style`, container queries, `scheduler.yield()` — a very modern-browser posture.
- No virtualization anywhere in the chat list (long histories = plain DOM + infinite scroll loader).
- Tests: vitest colocated (`*.test.tsx`) incl. parser perf tests (`Markdown/parser.perf.test.ts`); Storybook demos incl. failure-mode stories.

## 5. Design tensions / tradeoffs observed

1. **Presentational-only vs. batteries**: components render state but never manage the conversation — maximum flexibility, but every consumer re-implements the message model, stream plumbing, and persistence (contrast with assistant-ui/useChat-style integrations).
2. **ContentEditable complexity tax**: tokens/mentions/paste-chips force contentEditable, which drags in ~1,900 lines of selection/caret/echo/portal edge-case code (the pendingEcho and NBSP dances are symptomatic). The plain-textarea path exists but loses tokens.
3. **Custom markdown parser vs. ecosystem**: owning the parser enables incremental settling + artifact auto-closing + citation syntax (`【id】`) that remark can't easily do mid-stream, at the cost of CommonMark completeness (documented GFM deviations, e.g. autolink entity peeling) and a 1,481-line parser to maintain.
4. **ResizeObserver-driven follow vs. discrete jumps**: smooth for token streams, acknowledged-broken (#2282) for sudden large blocks — spring can decouple from very fast growth.
5. **No virtualization**: `role="log"` + real DOM keeps a11y and CSS simple; long sessions rely on `scrollToTopAction` paging instead.
6. **Modern-browser bets**: `scrollend`, `@starting-style`, CSS Highlight API, container queries — Safari fallback exists only for the Highlight API; older browsers degrade unhandled.
7. **Meta-flavored tool-call schema**: `node`, `additions/deletions` fields bake a code-agent aesthetic into the generic `ChatToolCalls` API.
8. **isStopShown rename** (was `isStreaming`, codemod v0.0.15): composer deliberately models "stop button visible" not "streaming" — decouples UI state from transport state.

## 6. License

**MIT** (root `LICENSE`, Copyright (c) 2026 Meta Platforms, Inc.; every source file headed `// Copyright (c) Meta Platforms, Inc. and affiliates.`). Code can be copied/adapted with attribution preserved. Note the chat components import astryx-internal infrastructure (StyleX token files, `themeProps`, `mergeProps`, Icon/Badge/Button/Spinner, Typeahead SearchSource), so lifting a component means also lifting or shimming that substrate — the algorithmic files (`useChatStreamScroll.ts`, `useStreamingText.ts`, `Markdown/streaming.ts`, `parser.ts` incremental section, `useChatNewMessages.ts`) are the most cleanly extractable (React-only, no styling deps).

## Key file index (for follow-up fetches)

```
packages/core/src/Chat/ChatLayout.tsx                 # shell, dock, blur, scroll wiring
packages/core/src/Chat/useChatStreamScroll.ts         # spring stick-to-bottom + lock state machine
packages/core/src/Chat/useChatNewMessages.ts          # ResizeObserver follow + new-message pill
packages/core/src/Chat/ChatMessageList.tsx            # role=log, aria-busy, infinite scroll
packages/core/src/Chat/ChatMessage.tsx / ChatMessageBubble.tsx / ChatMessageMetadata.tsx / ChatSystemMessage.tsx
packages/core/src/Chat/ChatComposer.tsx               # slot shell + context
packages/core/src/Chat/ChatComposerInput.tsx          # contentEditable input
packages/core/src/Chat/useTriggerMenu.tsx             # @/slash combobox menus
packages/core/src/Chat/useChatComposerTokens.ts       # token chips via portals
packages/core/src/Chat/useChatPasteAsToken.ts / ChatPastedTextToken.tsx
packages/core/src/Chat/chatComposerSelection.ts       # caret helpers
packages/core/src/Chat/ChatSendButton.tsx / ChatLayoutScrollButton.tsx / ChatComposerDrawer.tsx
packages/core/src/Chat/ChatToolCalls.tsx              # tool-call rendering
packages/core/src/Chat/useChatDictation.ts / useSpeechRecognition.ts / ChatDictationButton.tsx
packages/core/src/hooks/useStreamingText.ts           # chunk smoothing
packages/core/src/Markdown/Markdown.tsx / parser.ts / streaming.ts
packages/core/src/CodeBlock/CodeBlock.tsx / tokenizer.ts / highlightRanges.ts
packages/core/src/Citation/Citation.tsx
packages/lab/src/ChatReasoning/ChatReasoning.tsx      # thinking display (unpublished)
packages/core/src/Chat/Chat.doc.mjs                   # agent-readable docs + best practices
packages/cli/src/commands/agent-docs.mjs / swizzle.mjs
apps/storybook/stories/ChatAutoScroll.stories.tsx     # documented auto-scroll failure modes (#2282)
```

---

# Appendix — target map at research time

# Chat UI Map — omp-squad webapp (target project)

**Everything lives in one file:** `webapp/src/components/AssistantChat.tsx` (1396 lines). It exports the `AssistantChat` panel plus ~10 sub-components, and even exports `TranscriptTimeline` which `TaskDetail.tsx` reuses. `WorkbenchPane.tsx` does **not** render chat (its lone `transcript` reference at line 344 is Web Speech API voice-to-task, unrelated).

## 1. Architecture

**Component tree (render path, chat view is `AssistantChat.tsx:1201-1394`):**
```
AssistantChat  (panel shell, resizable)
├─ Header (back / export / clear / maximize / close)  L1205-1228
├─ AgentMetaBar  L611 → renders AgentLandControls L630 (Verify/Land buttons)
├─ TodoPanel  L553 (phase/task progress bar, collapsible)
├─ Messages scroll body  L1237
│   ├─ if hasTranscript → TranscriptTimeline  L357
│   │     ├─ RunStatusHeader  L249  ("Worked for 2m" + collapse toggle)
│   │     ├─ TranscriptEntryView (per entry)  L421
│   │     │     ├─ user bubble / thinking <details> / system / tool <details> / assistant markdown
│   │     │     └─ CodeBlock  L109 → CodeHighlight (lazy Prism)
│   │     ├─ GateWidget  L275 (inline approval/question prompt)
│   │     └─ DiffReviewPanel  L332 (changed-files <details>)
│   └─ else → legacy Message[] bubbles + ThumbsUp/Down reactions  L1252-1290
├─ isLoading bouncing-dots indicator  L1291
├─ Suggestion chips  L1308 (deriveSuggestionChips L731)
└─ Composer  L1322 (textarea + @-mention popup + model <select> + attach/mic/send)

Session-list view (activeSessionId == null): L1119-1199
```

**State management — two parallel stores:**
1. **Local session store** (localStorage-backed): `sessions: Session[]` / `activeSessionId`, seeded by `readInitialChatState` (`L83`), persisted every render via `localStorage.setItem` inside a scroll effect (`L917-920`). `Message` = `{role:'user'|'model', text, timestamp, reaction}` (`L15`). Key `assistant-chat-sessions` (`L55`).
2. **Live transcript store** — comes from context: `useTaskContext()` (`L788`) → `TaskContext.tsx` → `useSquad()` hook at `webapp/src/hooks/useSquad.ts`. Transcripts live in a `Map<agentId, TranscriptEntry[]>` (`useSquad.ts:77`).

**Data flow, server → screen:**
- Transport is a **WebSocket**, not SSE/polling: `webapp/src/lib/ws.ts`. `connectSquad` opens `ws(s)://host/ws` with a subprotocol bearer token (`ws.ts:29`), auto-reconnects with exponential backoff+jitter (`ws.ts:43-49`), and queues commands sent while disconnected (`ws.ts:19-24,56-62`).
- Server pushes `SquadEvent` frames (`dto.ts:326`). `useSquad.ts:147-153` handles `type:"transcript"` by calling `appendTranscriptEntry` (`useSquad.ts:61-70`) — upserts by `entry.id` (so streaming deltas replace in place), dedupes id-less entries, and caps at `TRANSCRIPT_CAP = 800` (`useSquad.ts:6`).
- Outbound: chat send → `sendConsoleCommand({type:'prompt', id, message, clientTurnId})` (`AssistantChat.tsx:1002`). First send lazily POSTs `/api/console` to spin up an agent (`L986`) then `subscribeConsole(agentId)` to receive its transcript. `ClientCommand` union: `prompt/subscribe/set-model/interrupt/kill/restart/remove/snapshot` (`dto.ts:337`).
- `TranscriptEntry` shape (`dto.ts:218`): `kind: user|assistant|thinking|tool|system`, `status: running|ok|error|cancelled`, `format: markdown|command|stage|plain`, `tool?: {name,argsText,partialText,resultText,durationMs,...}`, `pending?` (gate requests).

**Key architectural quirk:** the local `Message[]` and the live `TranscriptEntry[]` are mutually exclusive per render — `hasTranscript ? [] : messages` (`L815`). Once an agent is attached, the hand-authored `Message[]` bubbles are hidden entirely and only the transcript renders. The user's optimistic message (`L978`) disappears from view the moment the transcript arrives (it reappears as a transcript `user` entry from the server).

## 2. Feature inventory (what the chat DOES today)

- **Streaming:** yes, via WS transcript upserts. `status:'running'` drives `shimmer` text animation and pulsing dots. `thinking` entries auto-open while streaming (`L512`).
- **Markdown:** `react-markdown` + `remark-gfm` + `remark-breaks` (`L541`, `L1269`). Rendered inside Tailwind-Typography `prose` classes.
- **Code blocks:** custom `CodeBlock` (`L109`) with a copy button + language label; delegates highlighting to `CodeHighlight.tsx` = **lazy-loaded Prism** (`vscDarkPlus` theme) with a `<pre>` fallback to keep grammars out of the main bundle.
- **Tool calls:** rich `<details>` renderer (`L437-506`) — status dot, tool name, IN/OUT/ERR panes, exit code, duration, and a "Raw payload" nested `<details>` (Args/Partial/Result JSON).
- **Reasoning/thinking blocks:** yes, collapsible "Thinking" section (`L509-524`).
- **Workflow stage markers:** `format:'stage'` renders as a divider (`L439-448`).
- **Todo/plan progress:** `TodoPanel` (`L553`) with percent bar and per-phase checklist.
- **Inline approval gates:** `GateWidget` (`L275`) renders option buttons or a textarea reply for `PendingRequest`s; answer via `answerCommand` (`L1248`).
- **Verify + Land controls:** `AgentLandControls` (`L630`) — POST `/api/agents/:id/verify` and `/land`, with a one-shot "Force land" arming on proof-gate 409.
- **Diff review:** `DiffReviewPanel` (`L332`), fed by `GET /api/agents/:id/diff` (`L876`).
- **Auto-scroll:** `scrollToBottom()` via `scrollIntoView({behavior:'smooth'})` on every sessions/loading/transcript change (`L913-920`).
- **Sessions:** multi-session list with create/delete/clear/switch, status+stage+task badges, persisted to localStorage.
- **@-mention tasks:** popup task picker triggered by typing `@` (`L1038-1071`, `L1324`).
- **Suggestion chips:** context-derived prompts (`deriveSuggestionChips`, `L731`).
- **Model picker:** `<select>` fed by `/api/models`; `set-model` command (`L967`).
- **Export:** downloads history as `.txt` blob (`L1026`).
- **Reactions:** thumbs up/down on legacy `model` messages only (`L1010`, `L1271`) — **not** on transcript entries.
- **Resizable panel:** pointer-drag handle + keyboard arrows, width persisted (`L1075-1116`).
- **Maximize/minimize:** fixed-inset fullscreen toggle (`L792`, `L1097`).
- **Keyboard:** Enter=send, Shift+Enter=newline (`L1059`); Cmd/Ctrl+Enter in GateWidget (`L308`).

**Notably missing:** no interrupt/stop button in the chat composer (the `interrupt`/`kill` commands exist in the DTO but aren't wired to any chat button), no retry/edit/copy on individual messages (copy only exists per code-block), attach & mic buttons are **decorative no-ops** (`L1369-1374` — no onClick), no message-level copy.

## 3. Pain points / weaknesses

- **Monolith:** 1396 lines, ~15 components + ~20 helpers in one file. `TaskDetail.tsx` imports `TranscriptTimeline` from it, coupling a 106KB component to the chat file.
- **Naive scroll:** unconditional `scrollIntoView('smooth')` fires on *every* transcript/session change (`L917`) — no "am I near the bottom?" check, so it will yank the viewport down even when the user has scrolled up to read history. No scroll-anchoring, no "jump to latest" affordance.
- **No virtualization:** the whole `TranscriptEntry[]` (capped at 800) and all message bubbles render at once; long tool outputs each get their own scroll panes. Will jank on big runs.
- **localStorage write on every render-ish:** `localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(sessions))` runs inside the same effect as scroll, keyed on `[sessions, isLoading, activeSessionId, transcriptEntries]` (`L917-920`) — serializes all sessions on unrelated transcript ticks (up to 1×/sec while running due to the `now` timer, `L892-899`).
- **Duplicated markdown logic:** the assistant-bubble markdown+`CodeBlock` config appears twice — transcript path (`L540-542`) and legacy path (`L1268-1269`) — with slightly different `prose` classes. `CodeBlock` also duplicates copy logic that Prism/CodeHighlight could own.
- **Duplicated user-bubble markup:** `TranscriptEntryView` user bubble (`L422-434`) vs legacy user bubble (`L1254-1262`) — near-identical, different max-width (`88%` vs `85%`) and radius.
- **Fragile @-mention:** admits it in a comment — "in a real app this would use a proper cursor/range detection" (`L1048`); uses `setTimeout(…,0)` + `split(' ')` last-word heuristic, breaks with multi-word task titles and mid-string edits. Inserted mention is plain text, not a token.
- **Effect-driven `now` clock:** a 1s `setInterval` re-renders the whole panel while any agent runs (`L892-899`) just to update elapsed-time labels.
- **Reactions mutate in place:** `toggleReaction` does `delete updated[idx].reaction` / assignment on a shallow-copied array (`L1014-1019`) — mutates message objects; and `updated[idx]` can be undefined-unsafe.
- **Auto-promote side effect in a render effect:** POSTs `/api/features/from-plan` when it regex-detects `plans/<dir>/` in tool text (`L922-932`, `detectedPlanDirs` L776) — a network mutation triggered by transcript content parsing.
- **a11y gaps:** the messages scroll region has no `role="log"`/`aria-live`, so streaming updates aren't announced. Decorative attach/mic buttons have `aria-label`s but do nothing (misleading to AT). No focus management when switching session views.
- **Textarea doesn't auto-grow** to content (fixed `min-h-12 max-h-40`, `rows={1}`, `L1348-1356`); relies on native scroll.
- **No TODO/HACK/FIXME markers** found in the chat files — the debt is structural, not annotated.

## 4. Styling approach

- **Tailwind CSS v4** (`@import "tailwindcss"` in `webapp/src/index.css:1`) + `@tailwindcss/typography` plugin (`prose`/`prose-invert` used for markdown).
- **Dark mode:** class-based via `@custom-variant dark (&:where(.dark, .dark *))` (`index.css:4`); every chat element carries explicit `dark:` variants. Theme toggled through `ThemeContext.tsx`.
- **Design tokens:** CSS custom properties in `@theme` and `.dark` — `--wf-*` palette (paper/surface/border/text/accent), accent is amber/orange `#F0A35A` (`index.css:6-50`). But note the chat component mostly uses raw Tailwind `gray-*`/`amber-*` utilities, **not** the `--wf-*` tokens (those are used by the dashboard `ui/` primitives).
- **Custom utilities** (`index.css:75-167`): `.scrollbar-custom`, `.scrollbar-hide`, `.shimmer`/`.shimmer-bg` (streaming animation, `@keyframes shimmer` L169), reduced-motion guard (`L196-202`), `.wf-surface-scoped` token bridge.
- **Fonts:** system sans + JetBrains Mono (`index.css:7-8`); base font-size 14px.

**UI primitives in `webapp/src/components/ui/`** (dashboard design layer, exported via `ui/index.ts`): `PanelShell`, `VerdictBadge`, `Sparkline`, `StatTile`, `Callout`, `SectionCard`, `HeatGrid`, `HeatTree`, `AttentionRow`, plus `toneClasses`/`Tone` tokens and `relativeAge`. **Important:** `AssistantChat` uses **none** of these — the chat is styled entirely with inline Tailwind, so there is no shared Button/Input/Message primitive to build on yet.
**Block primitives in `webapp/src/components/blocks/`** (for plan/doc rendering, not chat): `AnnotatedCodeBlock`, `CalloutBlock`, `ColumnsBlock`, `FileTreeBlock`, `MermaidBlock`, `QuestionsBlock`, `WireframeBlock`.

## 5. Precise file/line targets

| Concern | Location |
|---|---|
| **Composer (textarea + toolbar)** | `AssistantChat.tsx:1322-1391` (textarea L1348; model select L1359; no-op attach/mic L1369-1374; send L1377) |
| **Composer keyboard/@-mention** | `handleKeyDown` L1038-1063; `insertMention` L1065-1071; mention popup L1324-1346 |
| **Send / streaming handler** | `handleSend` L972-1008 (agent spin-up L985-993, `sendConsoleCommand` L1002) |
| **Message renderer (transcript)** | `TranscriptEntryView` L421-545; `TranscriptTimeline` L357-419 |
| **Message renderer (legacy bubbles)** | L1252-1290 |
| **Markdown + code block** | `CodeBlock` L109-146; markdown invocations L541 & L1269; `CodeHighlight.tsx` (whole file, lazy Prism) |
| **Tool-call rendering** | L437-506; `toolView` helper L179-196 |
| **Thinking/reasoning** | L509-524 |
| **Scroll logic** | `scrollToBottom` L913-915; triggering effect L917-920; `messagesEndRef` L804, L1303 |
| **Streaming data plumbing** | `useSquad.ts:61-70` (`appendTranscriptEntry`), `:147-153` (event handler), `ws.ts` (whole file) |
| **Transport / types** | `dto.ts:198-345` (`TranscriptTool` 198, `TranscriptEntry` 218, `SquadEvent` 326, `ClientCommand` 337) |
| **Panel state / hooks** | L787-820 (state), L825-932 (effects incl. width persist L865, diff fetch L869, now-clock L892) |
| **Resize handle** | `startChatResize` L1075-1089; `nudgeChatWidth` L1091-1095; handle JSX L1099-1116 |
| **Sub-panels** | `AgentMetaBar` L611; `AgentLandControls` L630; `TodoPanel` L553; `GateWidget` L275; `DiffReviewPanel` L332; `ComposerStats` L701 |
| **Suggestion chips** | `deriveSuggestionChips` L731-771; render L1308-1320 |
| **Reused in TaskDetail** | `TaskDetail.tsx:1457-1490` (imports `TranscriptTimeline`, import at L16) |
| **CSS / tokens** | `index.css` — tokens L6-50, scrollbar/shimmer L75-176 |

**Test coverage exists:** `AssistantChat.test.tsx` (7.3KB) — worth reading before refactoring to know the contract.
