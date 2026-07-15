import { expect, test } from 'bun:test';
import { reportAttention, shouldEmit } from './attention';

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
