/**
 * adoption.test.ts — the pure counter math the AdoptionStrip renders. No DOM: we test densification,
 * the trailing-window summaries, the boundary guard, and the empty-state predicate directly.
 */
import { describe, expect, test } from 'bun:test';
import {
  ADOPTION_METRICS,
  isAdoptionCounters,
  isAdoptionEmpty,
  metricSummary,
  utcDayKey,
  type AdoptionCounters,
} from './adoption';

// A fixed UTC anchor so every by-day key is deterministic: 2026-07-17T12:00:00Z.
const NOW = Date.UTC(2026, 6, 17, 12, 0, 0);
const DAY = 86_400_000;
const day = (backDays: number) => utcDayKey(NOW - backDays * DAY);

describe('utcDayKey', () => {
  test('formats an epoch-ms as the UTC YYYY-MM-DD the daemon buckets under', () => {
    expect(utcDayKey(NOW)).toBe('2026-07-17');
    expect(utcDayKey(NOW - DAY)).toBe('2026-07-16');
  });
});

describe('metricSummary — densify + summarize a trailing window', () => {
  test('fills zeros for absent days and orders oldest→newest', () => {
    const byDay = { [day(0)]: 3, [day(2)]: 1 }; // today=3, 2 days ago=1, gap yesterday
    const s = metricSummary(byDay, 5, NOW);
    expect(s.series).toEqual([0, 0, 1, 0, 3]); // 4d,3d,2d,1d,today
    expect(s.today).toBe(3);
    expect(s.total).toBe(4);
    expect(s.peak).toBe(3);
    expect(s.activeDays).toBe(2);
  });

  test('an all-empty map summarizes to zeros, never NaN', () => {
    const s = metricSummary(undefined, 7, NOW);
    expect(s.series).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(s.today).toBe(0);
    expect(s.total).toBe(0);
    expect(s.peak).toBe(0);
    expect(s.activeDays).toBe(0);
  });

  test('a torn/negative value is floored to zero, not bucketed as-is', () => {
    const byDay = { [day(0)]: Number.NaN as unknown as number, [day(1)]: -4 };
    const s = metricSummary(byDay, 3, NOW);
    expect(s.series).toEqual([0, 0, 0]);
    expect(s.total).toBe(0);
  });

  test('days outside the window are excluded from the total', () => {
    const byDay = { [day(0)]: 2, [day(10)]: 99 };
    const s = metricSummary(byDay, 7, NOW);
    expect(s.total).toBe(2);
    expect(s.today).toBe(2);
  });
});

describe('isAdoptionCounters — trust-boundary guard', () => {
  test('accepts a real three-record numeric payload', () => {
    const ok: AdoptionCounters = { casualSessionsByDay: { '2026-07-17': 1 }, promptsByDay: {}, pushTapsByDay: {} };
    expect(isAdoptionCounters(ok)).toBe(true);
  });

  test('rejects null, arrays, a missing field, and non-numeric values', () => {
    expect(isAdoptionCounters(null)).toBe(false);
    expect(isAdoptionCounters([])).toBe(false);
    expect(isAdoptionCounters({ casualSessionsByDay: {}, promptsByDay: {} })).toBe(false);
    expect(isAdoptionCounters({ casualSessionsByDay: { d: 'x' }, promptsByDay: {}, pushTapsByDay: {} })).toBe(false);
  });
});

describe('isAdoptionEmpty', () => {
  test('null counters is empty', () => {
    expect(isAdoptionEmpty(null, 7, NOW)).toBe(true);
  });

  test('all-zero-in-window counters is empty even if older days had activity', () => {
    const c: AdoptionCounters = { casualSessionsByDay: { [day(30)]: 5 }, promptsByDay: {}, pushTapsByDay: {} };
    expect(isAdoptionEmpty(c, 7, NOW)).toBe(true);
  });

  test('any in-window activity in any metric is non-empty', () => {
    const c: AdoptionCounters = { casualSessionsByDay: {}, promptsByDay: {}, pushTapsByDay: { [day(1)]: 1 } };
    expect(isAdoptionEmpty(c, 7, NOW)).toBe(false);
  });
});

describe('ADOPTION_METRICS', () => {
  test('renders sessions, prompts, push taps in that order, each with a hint', () => {
    expect(ADOPTION_METRICS.map((m) => m.key)).toEqual(['casualSessionsByDay', 'promptsByDay', 'pushTapsByDay']);
    for (const m of ADOPTION_METRICS) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.hint.length).toBeGreaterThan(0);
    }
  });
});
