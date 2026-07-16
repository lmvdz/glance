# Draft persistence — versioned localStorage store for the composer

STATUS: done
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

## Resolution

Executed 2026-07-16 (feat/daily-driver-w1). Implementation landed as one commit; every Verify item
below was then driven live against a scratch daemon (file mode, own state dir, port 7921, loops off)
with a real Chromium via agent-browser — not inferred from green tests.

**What shipped.**
- `webapp/src/lib/chat/draftStore.ts` — the webapp's first schema-versioned localStorage store
  (`composer-drafts` key, `DraftV1[]`). Every entry carries `version: 1`; every read passes through
  `migrateDraft(raw): DraftV1 | null`, the live migration seam (unknown/FUTURE versions → `null`,
  arrays salvaged element-by-element so one malformed chip never costs the typed text). Pure core
  (`migrateDraft`/`draftHasContent`/`pruneDrafts`/`upsertDraft`) is unit-tested without jsdom;
  `loadDraft`/`persistDraft`/`deleteDraft`/`subscribeDraftStore` are the only code touching
  `window.localStorage`. Growth capped (14-day TTL + 30 entries, newest-first); quota pressure sheds
  OTHER threads' images first, then the current one's — text always outlives images; a store that
  cannot be read restores nothing and never throws into render.
- `Composer` gained a `sessionId` prop, fixing the unkeyed-mount reality delta in the same change:
  switching threads flushes the outgoing thread's draft and seeds the incoming one's (input,
  prompt-recall history, paste-chips, image attachments) instead of leaking component state across
  threads. Writes are debounced 300ms (t3code's number) and unconditionally flushed on
  `beforeunload`, `visibilitychange`→hidden, unmount, and thread switch, with a reference-equality
  dirty check so tab-hide spam never re-serializes multi-MB image data URLs. Clear-on-send clears
  the persisted draft synchronously (recall history rides along — it grows on send).
- `AssistantChat` passes `activeSessionId` down and deletes a thread's draft when the thread is
  deleted (deferred to a parent effect for the active thread — the child's flush-on-switch runs
  first and would otherwise resurrect it). `WorkspaceCockpit`'s per-agent composer gets the same fix
  under a namespaced `cockpit:<agentId>` scope so cockpit drafts can never collide with chat ids.

**Live verification record (2026-07-16, scratch daemon + agent-browser, persistent Chromium
profile so storage survives a process kill).**
- *Kill/restore*: typed a partial sentence, pasted 480 chars (chip "Pasted text · 0.5 KB"), attached
  a 64×64 PNG via the file input; store showed `1|default|…|1 chip|1 image`; killed the entire
  browser process (harder than beforeunload — a crash equivalent); reopened → sentence, chip, and
  image all restored unsent, pixel-verified by screenshot.
- *Thread independence*: new chat opened with an EMPTY composer (the old unkeyed mount would have
  leaked thread A's text); typed a distinct draft in B; switched A↔B repeatedly — each thread
  restored exactly its own draft; store held two independent entries keyed by session id.
- *Flush beats debounce*: injected a keystroke and reloaded 30ms later (inside the 300ms window) —
  the tail persisted via the beforeunload flush and was restored after reload.
- *Clear-on-send*: sending thread B's draft cleared its persisted input to `""` with
  `promptHistory: 1` (send text kept for ArrowUp recall) while thread A's draft stayed untouched.
- Suite: 81 targeted tests pass (draftStore.test.ts + AssistantChat.test.tsx), `tsc --noEmit` clean.

**Deliberately not built** (concern scope): no restore-toast or other new visible affordance — the
draft simply IS where the operator left it, which is the affordance; no cross-tab live sync
(`subscribeDraftStore` is the seam a second writer would use); no queue machinery (02's territory).
