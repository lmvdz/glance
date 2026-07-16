# Draft persistence — versioned localStorage store for the composer

STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/components/chat/Composer.tsx (input `useState` :356, `promptHistory`/`recallState` :367-368, paste-chips `chips`/`expandedChipId` :372-373, image attachments `images`/`annotatingId` :379-380), webapp/src/lib/chat/draftStore.ts (new), webapp/src/components/AssistantChat.tsx (Composer mount point :999, `activeSessionId` :434 — no `sessionId` prop crosses today)

## Goal

`Composer`'s input text, prompt-recall history, paste-as-chip attachments, and image attachments are plain `useState` — the moment the tab closes or crashes mid-sentence, all of it is gone. t3code lost user drafts at least six times chasing this before landing on a schema-versioned, migratable localStorage store, debounced with a `beforeunload` flush (plans/research-t3code/BRIEF.md:120, :141 — "user input is sacred; agent state is merely recoverable"). Persist the same four pieces of state per thread, versioned from v1 with a migration seam already wired (even though there is nothing to migrate yet), so reopening the tab restores exactly what was there.

## Approach

- New `webapp/src/lib/chat/draftStore.ts`, structured like `webapp/src/lib/chat/sessionStore.ts`'s split: pure functions (unit-tested, no jsdom) for the shape/merge logic, plus the three browser-only functions (`loadDraft`/`persistDraft`/`subscribeDraftStore`) that are the only code touching `window.localStorage`. `sessionStore.ts` itself carries no schema-version field — this is the first versioned store in this webapp, so don't copy its lack of one.
- Schema: `{ version: 1, sessionId, input, promptHistory, chips, images, updatedAt }`, one entry per thread — key the localStorage blob by `sessionId` (a map or a versioned array, mirroring `sessionStore.ts`'s `Session[]` shape) so each thread's draft is independent. A top-level `migrateDraft(raw: unknown): DraftV1 | null` seam takes any persisted shape and returns the current version or `null` on unrecoverable garbage (private-mode storage, corrupt JSON) — even at v1 this function must exist and be called, not stubbed, so v2 has a real hook to extend instead of a comment.
- **Reality delta to resolve, not invent around**: `Composer` today receives no `sessionId`/`activeSessionId` prop at all (grepped its full prop list, webapp/src/components/chat/Composer.tsx:309-355) and is mounted unkeyed at `AssistantChat.tsx:999` — unlike `ChatMessagesViewport`, which IS keyed by `activeSessionId` (`AssistantChat.tsx:964`). Concretely, switching threads today does NOT clear the draft (it's plain component state, not remounted) — an existing, likely-unintentional behavior. Wiring per-thread persistence requires threading `activeSessionId` down as a new `Composer` prop; decide alongside this whether to also key the in-memory `useState` by session (so switching threads shows thread B's draft, not thread A's leftover text) — the ephemeral-state fix and the persistence fix are the same change, do both, don't persist a bug.
- Debounced write (t3code uses 300ms, BRIEF.md:120 — match it unless testing shows thrash) on every `input`/`promptHistory`/`chips`/`images` change, plus an unconditional flush on `beforeunload` AND `visibilitychange` (document going hidden) — no existing `beforeunload` listener exists anywhere in this webapp to copy; `visibilitychange` has one precedent for wiring shape (`webapp/src/components/chat/VoiceCallPill.tsx:245-248`, unrelated to drafts but shows the add/remove-listener pattern this webapp uses).
- Load on mount: `loadDraft(sessionId)` seeds `input`/`promptHistory`/`chips`/`images` `useState` initializers (or an effect keyed on `sessionId`, matching whichever fix is chosen above for the remount question).
- Clear-on-send: `handleSend`'s existing clear path (Composer clears its own input after calling `onSend`) must also clear the persisted draft for that session — a stale draft reappearing after a successful send would be its own kind of data-loss bug in reverse.
- Cap growth: same discipline as `PROMPT_HISTORY_LIMIT = 50` (Composer.tsx:60) — the persisted store must not grow unbounded across many threads; expire or cap old per-session draft entries (e.g. drop entries whose `updatedAt` is older than N days, or cap total entries) so localStorage doesn't silently fill.

## Cross-Repo Side Effects

None — webapp-only change, no daemon API surface touched.

## Verify

- Unit tests (bun:test, no jsdom) for `draftStore.ts`'s pure functions: `migrateDraft` on v1 shape, on garbage, on `null`; the merge/cap logic; debounce scheduling logic if implemented as pure state.
- Live acceptance (the literal ask): open a thread, type a partial sentence, add a paste-chip and an image attachment, kill the tab (not just navigate away — an actual close/crash), reopen glance, land on the same thread — the sentence, the chip, and the image attachment are all still there, unsent.
- Live: switch threads mid-draft, confirm each thread's draft is independent (the reality-delta fix above), not shared.
- Live: confirm `beforeunload`/`visibilitychange` flush actually beats a naive interval by killing the tab within the debounce window and checking the draft persisted anyway.
