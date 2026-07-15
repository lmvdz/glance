import { expect, test } from 'bun:test';
import {
  reportAttention,
  shouldEmit,
  shouldEmitDiffViewed,
  diffViewedKey,
  DIFF_VIEWPORT_THRESHOLD,
  prReviewedEvents,
  reportAnswerRead,
} from './attention';

// =================================================================================================
// shouldEmit: the pure 5-minute floor (concern 02's viewport observers key it by (agentId,file))
// =================================================================================================

test('shouldEmit: true the first time a key is seen (no prior entry)', () => {
  expect(shouldEmit({}, 'a1:file.ts', 1_000)).toBe(true);
});

test('shouldEmit: false within the 5-minute floor', () => {
  const state = { 'a1:file.ts': 1_000 };
  expect(shouldEmit(state, 'a1:file.ts', 1_000 + 60_000)).toBe(false); // 1 minute later
  expect(shouldEmit(state, 'a1:file.ts', 1_000 + 5 * 60_000 - 1)).toBe(false); // 1ms short of the floor
});

test('shouldEmit: true once the floor has fully elapsed', () => {
  const state = { 'a1:file.ts': 1_000 };
  expect(shouldEmit(state, 'a1:file.ts', 1_000 + 5 * 60_000)).toBe(true); // exactly at the floor
  expect(shouldEmit(state, 'a1:file.ts', 1_000 + 6 * 60_000)).toBe(true);
});

test('shouldEmit: never mutates the state it was given', () => {
  const state = { 'a1:file.ts': 1_000 };
  const before = { ...state };
  shouldEmit(state, 'a1:file.ts', 1_000 + 6 * 60_000);
  expect(state).toEqual(before);
});

test('shouldEmit: keys are independent — a different (agentId,file) key has its own floor', () => {
  const state = { 'a1:file.ts': 1_000 };
  expect(shouldEmit(state, 'a1:other.ts', 1_000 + 1)).toBe(true);
  expect(shouldEmit(state, 'a2:file.ts', 1_000 + 1)).toBe(true);
});

// =================================================================================================
// reportAttention: fire-and-forget, swallowed errors (attention must never break a view)
// =================================================================================================

test('reportAttention: POSTs to /api/attention with the given event as JSON', async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
  }) as typeof fetch;
  try {
    reportAttention({ kind: 'diff-viewed', repo: '/srv/app', file: 'a.ts', agentId: 'u1' });
    await Promise.resolve(); // let the fire-and-forget microtask run
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('/api/attention');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ kind: 'diff-viewed', repo: '/srv/app', file: 'a.ts', agentId: 'u1' });
  } finally {
    globalThis.fetch = original;
  }
});

test('reportAttention: a rejected/failed request never throws or rejects — swallowed', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 400, text: async () => 'unknown repo' }) as unknown as Response) as typeof fetch;
  try {
    expect(() => reportAttention({ kind: 'diff-viewed', repo: '/other' })).not.toThrow();
    await Promise.resolve();
    await Promise.resolve(); // drain the apiJson rejection → .catch() chain
  } finally {
    globalThis.fetch = original;
  }
});

test('reportAttention: a network-level throw is also swallowed', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('network down');
  }) as typeof fetch;
  try {
    expect(() => reportAttention({ kind: 'surprise', repo: '/srv/app', file: 'a.ts' })).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  } finally {
    globalThis.fetch = original;
  }
});

// =================================================================================================
// diffViewedKey: the (agentId,file) composite key — NOT a content hash
// =================================================================================================

test('diffViewedKey: same (agentId,file) always produces the same key', () => {
  expect(diffViewedKey('a1', 'src/x.ts')).toBe(diffViewedKey('a1', 'src/x.ts'));
});

test('diffViewedKey: different agentId or file produce different keys', () => {
  expect(diffViewedKey('a1', 'src/x.ts')).not.toBe(diffViewedKey('a2', 'src/x.ts'));
  expect(diffViewedKey('a1', 'src/x.ts')).not.toBe(diffViewedKey('a1', 'src/y.ts'));
});

// =================================================================================================
// shouldEmitDiffViewed: the IntersectionObserver decision — 50% threshold + visible tab + floor
// =================================================================================================

test('shouldEmitDiffViewed: true on first view — ≥50% intersection, visible tab, no prior emission', () => {
  expect(shouldEmitDiffViewed({
    state: {},
    agentId: 'a1',
    file: 'src/x.ts',
    intersectionRatio: DIFF_VIEWPORT_THRESHOLD,
    visibilityState: 'visible',
    now: 1_000,
  })).toBe(true);
});

test('shouldEmitDiffViewed: false below the 50% intersection threshold', () => {
  expect(shouldEmitDiffViewed({
    state: {},
    agentId: 'a1',
    file: 'src/x.ts',
    intersectionRatio: 0.49,
    visibilityState: 'visible',
    now: 1_000,
  })).toBe(false);
});

test('shouldEmitDiffViewed: false when the tab is not visible, even at 100% intersection', () => {
  expect(shouldEmitDiffViewed({
    state: {},
    agentId: 'a1',
    file: 'src/x.ts',
    intersectionRatio: 1,
    visibilityState: 'hidden',
    now: 1_000,
  })).toBe(false);
});

test('shouldEmitDiffViewed: false within the 5-minute floor for the same (agentId,file)', () => {
  const state = { [diffViewedKey('a1', 'src/x.ts')]: 1_000 };
  expect(shouldEmitDiffViewed({
    state,
    agentId: 'a1',
    file: 'src/x.ts',
    intersectionRatio: 1,
    visibilityState: 'visible',
    now: 1_000 + 60_000,
  })).toBe(false);
});

test('shouldEmitDiffViewed: true again once the floor elapses for the same (agentId,file)', () => {
  const state = { [diffViewedKey('a1', 'src/x.ts')]: 1_000 };
  expect(shouldEmitDiffViewed({
    state,
    agentId: 'a1',
    file: 'src/x.ts',
    intersectionRatio: 1,
    visibilityState: 'visible',
    now: 1_000 + 5 * 60_000,
  })).toBe(true);
});

test('shouldEmitDiffViewed: the 4s working-poll re-render must not re-emit — same (agentId,file) key, new content, still floored', () => {
  const state = { [diffViewedKey('a1', 'src/x.ts')]: 1_000 };
  // Simulates the poll re-fetching diff content for the same file 4s later: same key, ratio/visible
  // unchanged, well inside the floor.
  expect(shouldEmitDiffViewed({
    state,
    agentId: 'a1',
    file: 'src/x.ts',
    intersectionRatio: 1,
    visibilityState: 'visible',
    now: 1_000 + 4_000,
  })).toBe(false);
});

test('shouldEmitDiffViewed: never mutates the state it was given', () => {
  const state = { [diffViewedKey('a1', 'src/x.ts')]: 1_000 };
  const before = { ...state };
  shouldEmitDiffViewed({ state, agentId: 'a1', file: 'src/x.ts', intersectionRatio: 1, visibilityState: 'visible', now: 1_000 + 6 * 60_000 });
  expect(state).toEqual(before);
});

// =================================================================================================
// prReviewedEvents: PR click-through — one pr-reviewed + floor-gated diff-viewed per loaded file
// =================================================================================================

test('prReviewedEvents: emits pr-reviewed plus a diff-viewed for every file when nothing is floored yet', () => {
  const { events, markKeys } = prReviewedEvents({
    state: {},
    repo: '/srv/app',
    agentId: 'a1',
    prNumber: 42,
    files: ['a.ts', 'b.ts'],
    now: 1_000,
  });
  expect(events).toEqual([
    { kind: 'pr-reviewed', repo: '/srv/app', agentId: 'a1', prNumber: 42 },
    { kind: 'diff-viewed', repo: '/srv/app', agentId: 'a1', file: 'a.ts' },
    { kind: 'diff-viewed', repo: '/srv/app', agentId: 'a1', file: 'b.ts' },
  ]);
  expect(markKeys).toEqual([diffViewedKey('a1', 'a.ts'), diffViewedKey('a1', 'b.ts')]);
});

test('prReviewedEvents: always emits pr-reviewed even with zero files', () => {
  const { events, markKeys } = prReviewedEvents({ state: {}, repo: '/srv/app', agentId: 'a1', files: [], now: 1_000 });
  expect(events).toEqual([{ kind: 'pr-reviewed', repo: '/srv/app', agentId: 'a1', prNumber: undefined }]);
  expect(markKeys).toEqual([]);
});

test('prReviewedEvents: a file already floored by the viewport observer is not double-counted', () => {
  const state = { [diffViewedKey('a1', 'a.ts')]: 1_000 };
  const { events, markKeys } = prReviewedEvents({
    state,
    repo: '/srv/app',
    agentId: 'a1',
    files: ['a.ts', 'b.ts'],
    now: 1_000 + 60_000, // well inside a.ts's floor
  });
  // Only pr-reviewed + the still-unfloored b.ts — a.ts is skipped.
  expect(events).toEqual([
    { kind: 'pr-reviewed', repo: '/srv/app', agentId: 'a1', prNumber: undefined },
    { kind: 'diff-viewed', repo: '/srv/app', agentId: 'a1', file: 'b.ts' },
  ]);
  expect(markKeys).toEqual([diffViewedKey('a1', 'b.ts')]);
});

test('prReviewedEvents: never mutates the state it was given', () => {
  const state = { [diffViewedKey('a1', 'a.ts')]: 1_000 };
  const before = { ...state };
  prReviewedEvents({ state, repo: '/srv/app', agentId: 'a1', files: ['a.ts', 'b.ts'], now: 1_000 + 60_000 });
  expect(state).toEqual(before);
});

// =================================================================================================
// reportAnswerRead: concern 10's future wiring point — thin wrapper over reportAttention
// =================================================================================================

test('reportAnswerRead: POSTs an answer-read event with repo and answerId', async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
  }) as typeof fetch;
  try {
    reportAnswerRead('/srv/app', 'answer-123');
    await Promise.resolve();
    expect(calls.length).toBe(1);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ kind: 'answer-read', repo: '/srv/app', answerId: 'answer-123' });
  } finally {
    globalThis.fetch = original;
  }
});
