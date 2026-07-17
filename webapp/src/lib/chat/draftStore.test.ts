import { afterEach, describe, expect, test } from 'bun:test';
import {
  COMPOSER_DRAFTS_KEY,
  DRAFT_TTL_MS,
  MAX_DRAFT_ENTRIES,
  deleteDraft,
  draftHasContent,
  loadAllDrafts,
  loadDraft,
  migrateDraft,
  persistDraft,
  pruneDrafts,
  subscribeDraftStore,
  upsertDraft,
  type DraftV1,
} from './draftStore';

function draft(overrides: Partial<DraftV1> & Pick<DraftV1, 'sessionId'>): DraftV1 {
  return { version: 1, input: '', promptHistory: [], chips: [], images: [], updatedAt: 0, ...overrides };
}

const chip = (id: string, content = 'pasted content') => ({ id, label: `Pasted text · 0.1 KB`, content });
const image = (id: string, dataUrl = 'data:image/png;base64,AAAA') => ({ id, dataUrl, width: 10, height: 10, annotations: [], annotated: false });

// =============================================================================
// migrateDraft — THE versioning seam. v1 in → v1 out; garbage in → null out.
// =============================================================================

describe('migrateDraft', () => {
  test('round-trips a well-formed v1 draft', () => {
    const d = draft({ sessionId: 's1', input: 'half a sentence', promptHistory: ['earlier'], chips: [chip('c1')], images: [image('i1')], updatedAt: 42 });
    expect(migrateDraft(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });

  test('returns null for unrecoverable garbage — null, primitives, empty object, arrays', () => {
    expect(migrateDraft(null)).toBeNull();
    expect(migrateDraft(undefined)).toBeNull();
    expect(migrateDraft('a string')).toBeNull();
    expect(migrateDraft(7)).toBeNull();
    expect(migrateDraft({})).toBeNull();
    expect(migrateDraft([])).toBeNull();
  });

  test('returns null for an unknown or missing version — including a FUTURE one (never guess at a newer schema)', () => {
    const base = draft({ sessionId: 's1', input: 'text', updatedAt: 1 });
    expect(migrateDraft({ ...base, version: 2 })).toBeNull();
    expect(migrateDraft({ ...base, version: '1' })).toBeNull();
    expect(migrateDraft({ ...base, version: undefined })).toBeNull();
  });

  test('returns null when a core scalar is malformed (sessionId/input/updatedAt)', () => {
    const base = draft({ sessionId: 's1', input: 'text', updatedAt: 1 });
    expect(migrateDraft({ ...base, sessionId: '' })).toBeNull();
    expect(migrateDraft({ ...base, sessionId: 9 })).toBeNull();
    expect(migrateDraft({ ...base, input: null })).toBeNull();
    expect(migrateDraft({ ...base, updatedAt: 'yesterday' })).toBeNull();
    expect(migrateDraft({ ...base, updatedAt: Number.NaN })).toBeNull();
  });

  test('salvages arrays element-by-element — one malformed chip/image/history entry never costs the typed text', () => {
    const raw = {
      version: 1,
      sessionId: 's1',
      input: 'the sacred text',
      promptHistory: ['keep', 42, null],
      chips: [chip('good'), { id: 'no-content' }, 'junk'],
      images: [image('good'), { id: 'no-dataUrl', width: 1, height: 1, annotations: [], annotated: false }],
      updatedAt: 5,
    };
    const migrated = migrateDraft(raw)!;
    expect(migrated.input).toBe('the sacred text');
    expect(migrated.promptHistory).toEqual(['keep']);
    expect(migrated.chips.map((c) => c.id)).toEqual(['good']);
    expect(migrated.images.map((i) => i.id)).toEqual(['good']);
  });

  test('missing array fields normalize to empty arrays', () => {
    const migrated = migrateDraft({ version: 1, sessionId: 's1', input: 'text', updatedAt: 1 })!;
    expect(migrated.promptHistory).toEqual([]);
    expect(migrated.chips).toEqual([]);
    expect(migrated.images).toEqual([]);
  });
});

// =============================================================================
// draftHasContent / pruneDrafts / upsertDraft — the merge & cap logic.
// =============================================================================

describe('draftHasContent', () => {
  test('empty on all four axes (including whitespace-only input) is not content', () => {
    expect(draftHasContent(draft({ sessionId: 's' }))).toBe(false);
    expect(draftHasContent(draft({ sessionId: 's', input: '   \n' }))).toBe(false);
  });

  test('any one axis counts: input, chips, images, or recall history', () => {
    expect(draftHasContent(draft({ sessionId: 's', input: 'x' }))).toBe(true);
    expect(draftHasContent(draft({ sessionId: 's', chips: [chip('c')] }))).toBe(true);
    expect(draftHasContent(draft({ sessionId: 's', images: [image('i')] }))).toBe(true);
    expect(draftHasContent(draft({ sessionId: 's', promptHistory: ['sent earlier'] }))).toBe(true);
  });
});

describe('pruneDrafts', () => {
  test('drops entries idle past the TTL, keeps fresh ones', () => {
    const now = DRAFT_TTL_MS * 2;
    const fresh = draft({ sessionId: 'fresh', updatedAt: now - 1000 });
    const stale = draft({ sessionId: 'stale', updatedAt: now - DRAFT_TTL_MS - 1 });
    expect(pruneDrafts([stale, fresh], now).map((d) => d.sessionId)).toEqual(['fresh']);
  });

  test('orders newest-first and caps at MAX_DRAFT_ENTRIES, dropping the stalest', () => {
    const now = 1_000_000;
    const drafts = Array.from({ length: MAX_DRAFT_ENTRIES + 5 }, (_, i) => draft({ sessionId: `s${i}`, updatedAt: now - i }));
    const pruned = pruneDrafts([...drafts].reverse(), now);
    expect(pruned.length).toBe(MAX_DRAFT_ENTRIES);
    expect(pruned[0].sessionId).toBe('s0'); // newest survives at the front
    expect(pruned.some((d) => d.sessionId === `s${MAX_DRAFT_ENTRIES + 4}`)).toBe(false); // stalest dropped
  });
});

describe('upsertDraft', () => {
  test('replaces the same session id in place and inserts a new one at the front', () => {
    const existing = [draft({ sessionId: 'a', input: 'old', updatedAt: 10 })];
    const replaced = upsertDraft(existing, draft({ sessionId: 'a', input: 'new', updatedAt: 20 }));
    expect(replaced.length).toBe(1);
    expect(replaced[0].input).toBe('new');

    const inserted = upsertDraft(replaced, draft({ sessionId: 'b', input: 'other thread', updatedAt: 30 }));
    expect(inserted.map((d) => d.sessionId)).toEqual(['b', 'a']);
  });

  test('a content-empty draft DELETES its session entry (clear-on-send) instead of persisting noise', () => {
    const existing = [draft({ sessionId: 'a', input: 'about to send', updatedAt: 10 })];
    expect(upsertDraft(existing, draft({ sessionId: 'a', updatedAt: 20 }))).toEqual([]);
  });

  test('an empty-input draft that still carries recall history is KEPT (history survives send)', () => {
    const next = upsertDraft([], draft({ sessionId: 'a', promptHistory: ['just sent this'], updatedAt: 20 }));
    expect(next.length).toBe(1);
    expect(next[0].promptHistory).toEqual(['just sent this']);
  });
});

// =============================================================================
// Browser-only functions against a stubbed window.localStorage — load/persist
// round trip, corrupt-store fallbacks, quota shedding, subscribe/delete.
// =============================================================================

interface FakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  readonly map: Map<string, string>;
}

function fakeStorage(maxValueLength = Number.POSITIVE_INFINITY): FakeStorage {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      if (value.length > maxValueLength) throw new Error('QuotaExceededError');
      map.set(key, value);
    },
  };
}

const originalWindow = (globalThis as { window?: unknown }).window;

function stubWindow(storage: FakeStorage | undefined): void {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: storage ? { localStorage: storage } : undefined });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
});

describe('persistDraft / loadDraft / loadAllDrafts', () => {
  test('persist → load round-trips a draft, keyed by session id', () => {
    stubWindow(fakeStorage());
    const d = draft({ sessionId: 's1', input: 'typed mid-thought', chips: [chip('c1')], images: [image('i1')], updatedAt: Date.now() });
    expect(persistDraft(d)).toBe('persisted');
    expect(loadDraft('s1')).toEqual(d);
    expect(loadDraft('other')).toBeNull();
  });

  test('drafts are independent per thread — writing one never disturbs another', () => {
    stubWindow(fakeStorage());
    const now = Date.now();
    persistDraft(draft({ sessionId: 'a', input: 'thread A', updatedAt: now }));
    persistDraft(draft({ sessionId: 'b', input: 'thread B', updatedAt: now + 1 }));
    expect(loadDraft('a')?.input).toBe('thread A');
    expect(loadDraft('b')?.input).toBe('thread B');
  });

  test('corrupt JSON, non-array blobs, and garbage entries all fail closed to nothing-restored', () => {
    const storage = fakeStorage();
    stubWindow(storage);
    storage.map.set(COMPOSER_DRAFTS_KEY, '{not json');
    expect(loadAllDrafts()).toEqual([]);
    storage.map.set(COMPOSER_DRAFTS_KEY, '{"version":1}');
    expect(loadAllDrafts()).toEqual([]);
    const good = draft({ sessionId: 'good', input: 'survivor', updatedAt: Date.now() });
    storage.map.set(COMPOSER_DRAFTS_KEY, JSON.stringify([good, { version: 99 }, null, 'junk']));
    expect(loadAllDrafts().map((d) => d.sessionId)).toEqual(['good']);
  });

  test('no window at all (SSR/test render): loads restore nothing, persists report failure, nothing throws', () => {
    stubWindow(undefined);
    expect(loadAllDrafts()).toEqual([]);
    expect(loadDraft('s1')).toBeNull();
    expect(persistDraft(draft({ sessionId: 's1', input: 'x', updatedAt: 1 }))).toBe('failed');
  });

  test('a blocked storage (getItem/setItem throwing, e.g. private mode) fails closed without throwing', () => {
    stubWindow({
      map: new Map(),
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(loadAllDrafts()).toEqual([]);
    expect(persistDraft(draft({ sessionId: 's1', input: 'x', updatedAt: 1 }))).toBe('failed');
  });
});

describe('quota shedding', () => {
  const bigImage = (id: string) => image(id, `data:image/png;base64,${'A'.repeat(10_000)}`);

  test('sheds OTHER sessions’ images first — the current draft keeps its attachment', () => {
    const storage = fakeStorage(15_000);
    stubWindow(storage);
    const now = Date.now();
    storage.map.set(COMPOSER_DRAFTS_KEY, JSON.stringify([draft({ sessionId: 'other', input: 'kept text', images: [bigImage('other-img')], updatedAt: now - 1 })]));
    const outcome = persistDraft(draft({ sessionId: 'current', input: 'mine', images: [bigImage('my-img')], updatedAt: now }));
    expect(outcome).toBe('persisted-shed-images');
    expect(loadDraft('current')?.images.length).toBe(1);
    const other = loadDraft('other')!;
    expect(other.images).toEqual([]);
    expect(other.input).toBe('kept text'); // text always outlives images
  });

  test('sheds the current draft’s images too when that is what it takes — text still persists', () => {
    stubWindow(fakeStorage(5_000));
    const outcome = persistDraft(draft({ sessionId: 'current', input: 'the words survive', images: [bigImage('img')], updatedAt: Date.now() }));
    expect(outcome).toBe('persisted-shed-images');
    const restored = loadDraft('current')!;
    expect(restored.input).toBe('the words survive');
    expect(restored.images).toEqual([]);
  });

  test('reports failed when even the imageless payload cannot be written', () => {
    stubWindow(fakeStorage(10));
    expect(persistDraft(draft({ sessionId: 'current', input: 'x'.repeat(100), updatedAt: Date.now() }))).toBe('failed');
  });
});

describe('subscribeDraftStore / deleteDraft', () => {
  test('listeners fire on persist and on delete; unsubscribe stops them', () => {
    stubWindow(fakeStorage());
    let fired = 0;
    const unsubscribe = subscribeDraftStore(() => {
      fired += 1;
    });
    persistDraft(draft({ sessionId: 's1', input: 'x', updatedAt: Date.now() }));
    expect(fired).toBe(1);
    deleteDraft('s1');
    expect(fired).toBe(2);
    unsubscribe();
    persistDraft(draft({ sessionId: 's1', input: 'y', updatedAt: Date.now() }));
    expect(fired).toBe(2);
  });

  test('deleteDraft removes exactly one thread’s entry', () => {
    stubWindow(fakeStorage());
    const now = Date.now();
    persistDraft(draft({ sessionId: 'a', input: 'A', updatedAt: now }));
    persistDraft(draft({ sessionId: 'b', input: 'B', updatedAt: now + 1 }));
    deleteDraft('a');
    expect(loadDraft('a')).toBeNull();
    expect(loadDraft('b')?.input).toBe('B');
  });
});
