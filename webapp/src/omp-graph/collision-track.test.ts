import { describe, expect, test } from 'bun:test';
import { collisionKey, trackCollisions, DEFAULT_MIN_DWELL_MS } from './collision-track';
import type { Collision } from '../lib/insights';

const c = (file: string, ids: string[]): Collision => ({ file, agents: ids.map((id) => ({ id, name: id })) });

describe('collisionKey', () => {
  test('is stable regardless of agent order', () => {
    expect(collisionKey(c('a.ts', ['x', 'y']))).toBe(collisionKey(c('a.ts', ['y', 'x'])));
  });

  test('differs across files or agent sets', () => {
    expect(collisionKey(c('a.ts', ['x', 'y']))).not.toBe(collisionKey(c('b.ts', ['x', 'y'])));
    expect(collisionKey(c('a.ts', ['x', 'y']))).not.toBe(collisionKey(c('a.ts', ['x', 'z'])));
  });
});

describe('trackCollisions', () => {
  test('a brand-new collision is NOT confirmed on its first tick (guards the sub-second flash)', () => {
    const raw = [c('a.ts', ['x', 'y'])];
    const { confirmed, next } = trackCollisions(raw, new Map(), 1_000);
    expect(confirmed).toEqual([]);
    expect(next.size).toBe(1);
  });

  test('confirms once it has dwelt past the threshold', () => {
    const raw = [c('a.ts', ['x', 'y'])];
    const t0 = 1_000;
    const seeded = trackCollisions(raw, new Map(), t0);
    // still under the threshold
    const stillWaiting = trackCollisions(raw, seeded.next, t0 + 1_000);
    expect(stillWaiting.confirmed).toEqual([]);
    // past the default 3s dwell (firstSeenAt is preserved from the seed tick, not reset)
    const later = trackCollisions(raw, stillWaiting.next, t0 + DEFAULT_MIN_DWELL_MS + 1);
    expect(later.confirmed).toEqual(raw);
  });

  test('a resolved collision (missing from the next raw list) is dropped, not remembered', () => {
    const raw = [c('a.ts', ['x', 'y'])];
    const t0 = 1_000;
    const { next: seeded } = trackCollisions(raw, new Map(), t0);
    const confirmedThenGone = trackCollisions([], seeded, t0 + 10_000);
    expect(confirmedThenGone.confirmed).toEqual([]);
    expect(confirmedThenGone.next.size).toBe(0);
  });

  test('re-appearing after being gone restarts the dwell clock (does not resurrect the old firstSeenAt)', () => {
    const raw = [c('a.ts', ['x', 'y'])];
    const t0 = 1_000;
    const { next: seeded } = trackCollisions(raw, new Map(), t0);
    const confirmedAt5s = trackCollisions(raw, seeded, t0 + DEFAULT_MIN_DWELL_MS + 1);
    expect(confirmedAt5s.confirmed).toEqual(raw);
    // it disappears for a tick...
    const gone = trackCollisions([], confirmedAt5s.next, t0 + DEFAULT_MIN_DWELL_MS + 2);
    // ...then reappears — must NOT be confirmed immediately.
    const reappeared = trackCollisions(raw, gone.next, t0 + DEFAULT_MIN_DWELL_MS + 3);
    expect(reappeared.confirmed).toEqual([]);
  });

  test('multiple simultaneous collisions are tracked independently', () => {
    const raw = [c('a.ts', ['x', 'y']), c('b.ts', ['p', 'q'])];
    const t0 = 1_000;
    const { next } = trackCollisions(raw, new Map(), t0);
    expect(next.size).toBe(2);
    const later = trackCollisions(raw, next, t0 + DEFAULT_MIN_DWELL_MS + 1);
    expect(later.confirmed.length).toBe(2);
  });
});
