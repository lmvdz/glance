/**
 * adoption-view.test.ts — the pure transforms behind the Daily driver panel (plans/daily-driver-w15/04).
 * Every decision the panel renders is decided here: the trailing-7-UTC-day window, the week sum, the
 * honest "has anything happened?" gate, the legacy-sourceless -> "human" default, and the auto/human
 * context prettifier. `now` is pinned so the window is deterministic.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildAdoptionView,
  coerceAdoptionCounters,
  coerceFrictionEntries,
  frictionContextLabel,
  frictionCounts,
  frictionSource,
  isAdoptionCountersWire,
  utcDayOf,
  type AdoptionCountersWire,
} from './adoption-view';

const NOW = Date.UTC(2026, 6, 17, 12, 0, 0); // 2026-07-17T12:00:00Z — window is 07-11..07-17

describe('buildAdoptionView', () => {
  test('four series in a fixed order, today + trailing-week sum + a 7-point oldest->newest spark', () => {
    const counters: AdoptionCountersWire = {
      casualSessionsByDay: { '2026-07-17': 3, '2026-07-15': 1 },
      promptsByDay: { '2026-07-17': 5 },
      pushTapsByDay: { '2026-07-16': 2 }, // 0 today, 2 this week — real data, NOT a fake zero
      roomInteractionsByDay: { '2026-07-17': 4 },
    };
    const v = buildAdoptionView(counters, NOW);
    expect(v.day).toBe('2026-07-17');
    expect(v.series.map((s) => s.key)).toEqual(['sessions', 'prompts', 'pushTaps', 'roomInteractions']);
    expect(v.series.map((s) => s.label)).toEqual(['Casual sessions', 'Prompts', 'Push taps', 'Room interactions']);
    const [sessions, prompts, taps, room] = v.series;
    expect(sessions.today).toBe(3);
    expect(sessions.week).toBe(4); // 3 + 1
    expect(sessions.spark).toEqual([0, 0, 0, 0, 1, 0, 3]); // 07-11..07-17
    expect(prompts.today).toBe(5);
    expect(prompts.week).toBe(5);
    expect(taps.today).toBe(0);
    expect(taps.week).toBe(2);
    expect(taps.spark.length).toBe(7);
    expect(room.today).toBe(4);
    expect(room.week).toBe(4);
    expect(v.hasActivity).toBe(true);
  });

  test('all-empty counters => no activity (the honest-empty gate)', () => {
    const v = buildAdoptionView({ casualSessionsByDay: {}, promptsByDay: {}, pushTapsByDay: {} }, NOW);
    expect(v.hasActivity).toBe(false);
    expect(v.series.every((s) => s.today === 0 && s.week === 0 && s.spark.every((n) => n === 0))).toBe(true);
  });

  test('activity strictly OUTSIDE the 7-day window does not count as active', () => {
    const v = buildAdoptionView({ casualSessionsByDay: { '2026-07-01': 9 }, promptsByDay: {}, pushTapsByDay: {} }, NOW);
    expect(v.hasActivity).toBe(false);
    expect(v.series[0].week).toBe(0);
  });
});

describe('utcDayOf', () => {
  test('buckets to the UTC calendar day', () => {
    expect(utcDayOf(Date.UTC(2026, 6, 17, 23, 59, 0))).toBe('2026-07-17');
    expect(utcDayOf(Date.UTC(2026, 6, 18, 0, 1, 0))).toBe('2026-07-18');
  });
});

describe('isAdoptionCountersWire / coerceAdoptionCounters', () => {
  test('accepts a well-formed payload', () => {
    expect(isAdoptionCountersWire({ casualSessionsByDay: { '2026-07-17': 1 }, promptsByDay: {}, pushTapsByDay: {} })).toBe(true);
  });
  test('rejects missing fields, non-numeric values, non-objects', () => {
    expect(isAdoptionCountersWire(null)).toBe(false);
    expect(isAdoptionCountersWire({})).toBe(false);
    expect(isAdoptionCountersWire({ casualSessionsByDay: {}, promptsByDay: {} })).toBe(false);
    expect(isAdoptionCountersWire({ casualSessionsByDay: { d: 'x' }, promptsByDay: {}, pushTapsByDay: {} })).toBe(false);
  });
  test('coerce turns a malformed/old payload into all-empty (never throws downstream)', () => {
    expect(coerceAdoptionCounters('nope')).toEqual({ casualSessionsByDay: {}, promptsByDay: {}, pushTapsByDay: {}, roomInteractionsByDay: {} });
    const legacy = { casualSessionsByDay: { '2026-07-17': 2 }, promptsByDay: {}, pushTapsByDay: {} };
    expect(coerceAdoptionCounters(legacy)).toEqual({ ...legacy, roomInteractionsByDay: {} });
    const good = { ...legacy, roomInteractionsByDay: { '2026-07-17': 1 } };
    expect(coerceAdoptionCounters(good)).toEqual(good);
  });
});

describe('frictionSource — the legacy migration default', () => {
  test('explicit auto is auto; explicit human is human', () => {
    expect(frictionSource({ source: 'auto' })).toBe('auto');
    expect(frictionSource({ source: 'human' })).toBe('human');
  });
  test('a sourceless legacy row reads as human, never crashes', () => {
    expect(frictionSource({})).toBe('human');
    expect(frictionSource({ source: undefined })).toBe('human');
    // A garbage value (foreign row) also degrades to human rather than mis-rendering as auto.
    expect(frictionSource({ source: 'weird' as unknown as 'auto' })).toBe('human');
  });
});

describe('frictionContextLabel', () => {
  test('maps the three fixed auto causes to calm labels', () => {
    expect(frictionContextLabel({ context: 'auto:boundary-sync-held' })).toBe('boundary sync held');
    expect(frictionContextLabel({ context: 'auto:acp-timeout' })).toBe('ACP timeout');
    expect(frictionContextLabel({ context: 'auto:session-loss' })).toBe('session lost');
  });
  test('an unknown auto:* degrades to the de-hyphenated tail (never shows raw auto: prefix)', () => {
    expect(frictionContextLabel({ context: 'auto:some-new-cause' })).toBe('some new cause');
  });
  test('a human capture surface passes through as-is; empty/absent => null', () => {
    expect(frictionContextLabel({ context: 'webapp-composer' })).toBe('webapp-composer');
    expect(frictionContextLabel({ context: '  ' })).toBeNull();
    expect(frictionContextLabel({})).toBeNull();
  });
});

describe('coerceFrictionEntries', () => {
  test('keeps valid rows (incl. legacy sourceless), drops torn/foreign rows, preserves order', () => {
    const rows = coerceFrictionEntries({
      entries: [
        { id: 'a', ts: 1000, repo: '/r', gripe: 'newest', source: 'auto', context: 'auto:acp-timeout', agentId: 'chat-1' },
        { id: 'b', ts: 900, repo: '/r', gripe: 'legacy no source' }, // sourceless — kept, renders human
        { id: 'c', ts: 800, gripe: '', repo: '/r' }, // empty gripe — dropped
        { ts: 700, repo: '/r', gripe: 'no id' }, // dropped
        'garbage',
        null,
      ],
    });
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(rows[0].source).toBe('auto');
    expect(rows[1].source).toBeUndefined(); // preserved absent — frictionSource defaults it to human at render
    expect(rows[1].repo).toBe('/r');
  });
  test('a non-array / missing entries body is an empty list, not a throw', () => {
    expect(coerceFrictionEntries(null)).toEqual([]);
    expect(coerceFrictionEntries({})).toEqual([]);
    expect(coerceFrictionEntries({ entries: 'x' })).toEqual([]);
  });
});

describe('frictionCounts', () => {
  test('splits by filer, treating sourceless as human', () => {
    const c = frictionCounts([{ id: '1', ts: 1, repo: '', gripe: 'x', source: 'auto' }, { id: '2', ts: 1, repo: '', gripe: 'y' }, { id: '3', ts: 1, repo: '', gripe: 'z', source: 'human' }]);
    expect(c).toEqual({ auto: 1, human: 2 });
  });
});
