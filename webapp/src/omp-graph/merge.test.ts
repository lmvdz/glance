/**
 * merge.test.ts — stitching two bounded GraphDoc windows into one continuous doc
 * (the mechanism behind drag-to-load-older-history on the flat pulse).
 */

import { expect, test, describe } from 'bun:test';
import { mergeGraphDocs } from './merge';
import type { GraphDocWire, GraphTrack } from './types';

const HOUR = 3_600_000;

const bars = (id: string, bins: { t: number; v: number }[]): GraphTrack => ({
  id,
  label: id,
  group: 'g',
  source: 'git',
  type: 'bars',
  binMs: HOUR,
  bins,
});
const events = (id: string, marks: { t: number; label: string; kind?: string }[]): GraphTrack => ({
  id,
  label: id,
  group: 'g',
  source: 'git',
  type: 'events',
  marks,
});

const doc = (start: number, end: number, tracks: GraphTrack[], over: Partial<GraphDocWire> = {}): GraphDocWire => ({
  range: { start, end },
  groups: [],
  tracks,
  sources: ['git'],
  generatedAt: end,
  ...over,
});

describe('mergeGraphDocs', () => {
  test('unions the range: earlier start from older, later end from newer', () => {
    const older = doc(0, 10 * HOUR, [bars('git.commits', [{ t: 2 * HOUR, v: 1 }])], { generatedAt: 10 * HOUR, sources: ['git'] });
    const newer = doc(10 * HOUR, 20 * HOUR, [bars('git.commits', [{ t: 12 * HOUR, v: 3 }])], { generatedAt: 20 * HOUR, sources: ['receipts'] });
    const m = mergeGraphDocs(older, newer);
    expect(m.range).toEqual({ start: 0, end: 20 * HOUR });
    expect(m.generatedAt).toBe(20 * HOUR);
    expect(m.sources.sort()).toEqual(['git', 'receipts']);
  });

  test('concatenates a bars track across windows, sorted by time', () => {
    const older = doc(0, 10 * HOUR, [bars('git.commits', [{ t: 2 * HOUR, v: 1 }, { t: 4 * HOUR, v: 2 }])]);
    const newer = doc(10 * HOUR, 20 * HOUR, [bars('git.commits', [{ t: 12 * HOUR, v: 3 }])]);
    const t = mergeGraphDocs(older, newer).tracks.find((x) => x.id === 'git.commits');
    expect(t?.type).toBe('bars');
    expect(t?.type === 'bars' && t.bins.map((b) => b.t)).toEqual([2 * HOUR, 4 * HOUR, 12 * HOUR]);
  });

  test('on an overlapping bin the NEWER window wins', () => {
    const older = doc(0, 12 * HOUR, [bars('git.commits', [{ t: 6 * HOUR, v: 1 }])]);
    const newer = doc(6 * HOUR, 18 * HOUR, [bars('git.commits', [{ t: 6 * HOUR, v: 9 }])]);
    const t = mergeGraphDocs(older, newer).tracks.find((x) => x.id === 'git.commits');
    expect(t?.type === 'bars' && t.bins).toEqual([{ t: 6 * HOUR, v: 9 }]);
  });

  test('events dedupe by t|kind|label but keep distinct marks at the same time', () => {
    const older = doc(0, 10 * HOUR, [events('git.milestones', [{ t: 3 * HOUR, label: 'a', kind: 'land' }])]);
    const newer = doc(3 * HOUR, 20 * HOUR, [events('git.milestones', [
      { t: 3 * HOUR, label: 'a', kind: 'land' }, // dup of older → collapses to one
      { t: 3 * HOUR, label: 'b', kind: 'feat' }, // same time, different mark → kept
    ])]);
    const t = mergeGraphDocs(older, newer).tracks.find((x) => x.id === 'git.milestones');
    expect(t?.type === 'events' && t.marks.length).toBe(2);
  });

  test('a track present in only one window is carried through', () => {
    const older = doc(0, 10 * HOUR, [bars('git.commits', [{ t: 1 * HOUR, v: 1 }]), bars('git.churn', [{ t: 1 * HOUR, v: 50 }])]);
    const newer = doc(10 * HOUR, 20 * HOUR, [bars('git.commits', [{ t: 12 * HOUR, v: 2 }])]);
    const ids = mergeGraphDocs(older, newer).tracks.map((t) => t.id).sort();
    expect(ids).toEqual(['git.churn', 'git.commits']);
  });
});
