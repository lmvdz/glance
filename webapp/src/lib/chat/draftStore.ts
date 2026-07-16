/**
 * Per-thread composer draft persistence (daily-composer concern 01).
 *
 * `Composer`'s input text, prompt-recall history, paste-as-chip attachments, and image
 * attachments were plain `useState` — a tab crash mid-sentence lost all of it, and because the
 * component was mounted unkeyed by session, switching threads silently LEAKED the draft across
 * threads. This store fixes both at once: one draft entry per session id, persisted to
 * localStorage, debounce-written on change and flushed on `beforeunload`/`visibilitychange`/
 * unmount (t3code's lesson — plans/research-t3code/BRIEF.md:120 "user input is sacred").
 *
 * Structured like `sessionStore.ts`'s split: everything above the "Browser-only" divider is pure
 * and directly unit-tested (bun:test, no jsdom); the functions below it are the only code that
 * touches `window.localStorage`.
 *
 * SCHEMA VERSIONING — the part `sessionStore.ts` lacks and this store must not: every persisted
 * entry carries `version`, and every entry read back passes through `migrateDraft`, the single
 * seam where a future v2 adds its `case 2` (and a `case 1` upgrade path) instead of scattering
 * shape checks. t3code reached v8 in production and lost user drafts six times before landing on
 * exactly this discipline — the seam exists and is CALLED from v1 day one, not stubbed.
 */

import type { ImageAttachment, PasteChip } from '../../components/chat/Composer';

/** Current persisted schema version. Bump alongside a new `DraftVn` type + `migrateDraft` case. */
export const DRAFT_SCHEMA_VERSION = 1;

/** One thread's draft — the four pieces of composer state worth surviving a crash. */
export interface DraftV1 {
  version: 1;
  sessionId: string;
  input: string;
  promptHistory: string[];
  chips: PasteChip[];
  images: ImageAttachment[];
  updatedAt: number;
}

export const COMPOSER_DRAFTS_KEY = 'composer-drafts';

/** Debounce for the persist-on-change write (t3code uses 300ms — BRIEF.md:120). The
 *  `beforeunload`/`visibilitychange`/unmount flush is what covers a kill inside this window. */
export const DRAFT_PERSIST_DEBOUNCE_MS = 300;

/** Growth caps (same discipline as Composer's `PROMPT_HISTORY_LIMIT`): entries idle past the TTL
 *  are dropped, and the store never holds more than `MAX_DRAFT_ENTRIES` threads' drafts —
 *  newest-first, so it's always the stalest drafts that fall off. */
export const DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_DRAFT_ENTRIES = 30;

const isPasteChip = (value: unknown): value is PasteChip => {
  const rec = value && typeof value === 'object' ? (value as Partial<PasteChip>) : {};
  return typeof rec.id === 'string' && typeof rec.label === 'string' && typeof rec.content === 'string';
};

const isImageAttachment = (value: unknown): value is ImageAttachment => {
  const rec = value && typeof value === 'object' ? (value as Partial<ImageAttachment>) : {};
  return (
    typeof rec.id === 'string' &&
    typeof rec.dataUrl === 'string' &&
    typeof rec.width === 'number' &&
    typeof rec.height === 'number' &&
    Array.isArray(rec.annotations) &&
    typeof rec.annotated === 'boolean'
  );
};

/**
 * THE migration seam: any persisted per-entry shape in, the CURRENT version (or `null` for
 * unrecoverable garbage) out. Called on every entry of every read — never bypassed. Adding v2
 * means: define `DraftV2`, add `case 2` returning it verbatim, and turn `case 1` into an upgrade
 * that returns the v2 shape. An entry from a NEWER version than this code knows (someone ran a
 * newer build in another tab, then downgraded) is `null` — refusing to guess beats corrupting it.
 */
export function migrateDraft(raw: unknown): DraftV1 | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  switch (rec.version) {
    case 1: {
      if (typeof rec.sessionId !== 'string' || rec.sessionId === '') return null;
      if (typeof rec.input !== 'string') return null;
      if (typeof rec.updatedAt !== 'number' || !Number.isFinite(rec.updatedAt)) return null;
      // Arrays are salvaged element-by-element: one malformed chip must not cost the typed text.
      const promptHistory = Array.isArray(rec.promptHistory)
        ? rec.promptHistory.filter((entry): entry is string => typeof entry === 'string')
        : [];
      const chips = Array.isArray(rec.chips) ? rec.chips.filter(isPasteChip) : [];
      const images = Array.isArray(rec.images) ? rec.images.filter(isImageAttachment) : [];
      return { version: 1, sessionId: rec.sessionId, input: rec.input, promptHistory, chips, images, updatedAt: rec.updatedAt };
    }
    default:
      return null;
  }
}

/** A draft worth keeping on disk: any text, attachment, or recall history. An entry that is empty
 *  on all four axes is deleted on upsert rather than persisted as noise. */
export function draftHasContent(draft: DraftV1): boolean {
  return draft.input.trim() !== '' || draft.chips.length > 0 || draft.images.length > 0 || draft.promptHistory.length > 0;
}

/** Drop expired entries, order newest-first, and cap the total — every write path runs through
 *  this so the store cannot grow unbounded across many threads. */
export function pruneDrafts(drafts: DraftV1[], now: number, ttlMs = DRAFT_TTL_MS, maxEntries = MAX_DRAFT_ENTRIES): DraftV1[] {
  return drafts
    .filter((draft) => now - draft.updatedAt <= ttlMs)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, maxEntries);
}

/** Replace (or insert) `draft`'s entry in `drafts`, keyed by sessionId. A content-empty draft is
 *  a DELETE of that session's entry (clear-on-send rides this: a stale draft reappearing after a
 *  successful send would be data loss in reverse). Always returns a pruned copy. */
export function upsertDraft(drafts: DraftV1[], draft: DraftV1): DraftV1[] {
  const rest = drafts.filter((entry) => entry.sessionId !== draft.sessionId);
  return pruneDrafts(draftHasContent(draft) ? [draft, ...rest] : rest, draft.updatedAt);
}

// =============================================================================
// Browser-only read/write/notify — the only code touching window.localStorage.
// =============================================================================

const listeners = new Set<() => void>();

/** Notified after every `persistDraft`/`deleteDraft`, regardless of outcome — same contract as
 *  `subscribeSessionStore`, so a future second writer (another tab, a voice-dictated draft) has a
 *  hook to pick changes up live instead of only on remount. */
export function subscribeDraftStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyDraftStoreListeners(): void {
  for (const listener of listeners) listener();
}

/** Read + migrate + prune the whole store. Storage blocked (private mode), corrupt JSON, or a
 *  non-array blob all normalize to `[]` — a draft store that cannot be read restores nothing, it
 *  never throws into render. */
export function loadAllDrafts(now = Date.now()): DraftV1[] {
  if (typeof window === 'undefined') return [];
  let parsed: unknown = null;
  try {
    const raw = window.localStorage.getItem(COMPOSER_DRAFTS_KEY);
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return pruneDrafts(parsed.map(migrateDraft).filter((draft): draft is DraftV1 => draft !== null), now);
}

export function loadDraft(sessionId: string): DraftV1 | null {
  return loadAllDrafts().find((draft) => draft.sessionId === sessionId) ?? null;
}

export type DraftPersistOutcome = 'persisted' | 'persisted-shed-images' | 'failed';

let warnedPersistFailure = false;

/** Serialize with graceful degradation under localStorage quota pressure: images (data-URL PNGs,
 *  the only heavyweight field) are shed from OTHER sessions' entries first, then from the current
 *  one — the typed text and chips of every thread outlive the images of any of them. */
function writeDrafts(drafts: DraftV1[], keepImagesForSessionId: string): DraftPersistOutcome {
  const attempts: Array<[DraftV1[], DraftPersistOutcome]> = [
    [drafts, 'persisted'],
    [drafts.map((d) => (d.sessionId === keepImagesForSessionId || d.images.length === 0 ? d : { ...d, images: [] })), 'persisted-shed-images'],
    [drafts.map((d) => (d.images.length === 0 ? d : { ...d, images: [] })), 'persisted-shed-images'],
  ];
  for (const [entries, outcome] of attempts) {
    try {
      window.localStorage.setItem(COMPOSER_DRAFTS_KEY, JSON.stringify(entries));
      return outcome;
    } catch {
      // quota exceeded or storage blocked — fall through to the next, lighter attempt
    }
  }
  if (!warnedPersistFailure) {
    warnedPersistFailure = true;
    // eslint-disable-next-line no-console
    console.warn('[draftStore] could not persist composer draft (storage blocked or full) — drafts will not survive a tab close');
  }
  return 'failed';
}

/** Read-modify-write one session's draft against the CURRENT persisted snapshot. The outcome is
 *  returned for tests/observability; callers keep their in-memory state either way. */
export function persistDraft(draft: DraftV1): DraftPersistOutcome {
  if (typeof window === 'undefined') return 'failed';
  const next = upsertDraft(loadAllDrafts(draft.updatedAt), draft);
  const outcome = writeDrafts(next, draft.sessionId);
  notifyDraftStoreListeners();
  return outcome;
}

/** Drop one session's draft outright — wired to thread deletion, so a deleted thread's draft can
 *  never resurrect into a future thread that reuses its id (e.g. the recreated 'default'). */
export function deleteDraft(sessionId: string): void {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  const remaining = loadAllDrafts(now).filter((draft) => draft.sessionId !== sessionId);
  writeDrafts(remaining, sessionId);
  notifyDraftStoreListeners();
}
