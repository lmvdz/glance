# Port astryx scroll-lock hooks
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/hooks/chat/useChatStreamScroll.ts (new), webapp/src/hooks/chat/useChatNewMessages.ts (new), webapp/src/lib/sharedResizeObserver.ts (new), webapp/src/lib/scrollLockCore.ts (new), webapp/src/lib/scrollLockCore.test.ts (new)

## Goal
The three astryx scroll files exist in our tree, adapted to our conventions, with their decision logic extracted as pure functions under `bun test`. No consumer wiring (that's concern 03).

## Approach
1. Fetch pinned sources from `https://raw.githubusercontent.com/facebook/astryx/deb5aa0/packages/core/src/Chat/useChatStreamScroll.ts`, `.../useChatNewMessages.ts`, and the sibling `sharedResizeObserver` util it imports (find its exact path via the repo tree at that commit). MIT — **keep the Meta copyright header** in each ported file and add one line noting the source path + commit.
2. Port with these adaptations (from DESIGN.md):
   - Replace the two `.astryx-chat-message` class-selector references with `[data-chat-message]` attribute selectors.
   - Add a `prefers-reduced-motion` guard: when reduced, `scrollIfLocked`/`scrollToBottom` set `scrollTop` directly instead of running the rAF spring (upstream gap we close; pattern precedent at `webapp/src/index.css:196-202`).
   - Convert to the repo's TS style (webapp is strict TS, no semicolon/style surprises — match neighboring hooks in `webapp/src/hooks/`).
3. **Pure-core extraction** (`lib/scrollLockCore.ts`): the DOM-free decision logic — (a) scroll-event classification: given previous/current `{scrollTop, scrollHeight, offsetHeight}`, classify user-scroll-up / user-scroll-down / synthetic (content-resize) per astryx's filter; (b) lock-state transition: `(state, event) -> state` incl. the 10px re-lock threshold; (c) spring step: `(position, velocity, target, dt) -> {position, velocity}`. The hooks call the core; the core has zero DOM references. This is the test surface — no jsdom exists or is being added (DESIGN.md decision).
4. Known accepted degradations (document in a comment): `scrollend` missing on old engines → no auto re-lock (pill still works); discrete large height jumps can outrun the spring (upstream issue #2282).

## Cross-Repo Side Effects
None.

## Verify
- `bun test webapp/src/lib/scrollLockCore.test.ts` covering: synthetic-scroll classification (scrollHeight grew, scrollTop unchanged → not user intent); wheel-up unlock; re-lock within threshold of bottom; **front-trimmed transcript** (scrollHeight shrinks — spring diff goes negative, no NaN/oscillation); spring converges and terminates.
- `cd webapp && bunx tsc --noEmit` (or the repo's typecheck script) passes.
- Files carry Meta attribution headers.
