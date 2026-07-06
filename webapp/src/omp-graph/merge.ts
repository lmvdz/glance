/**
 * merge.ts — stitch two GraphDoc windows into one continuous doc.
 *
 * The daemon hard-caps every /api/graph request to ~31 days (a safety bound so a
 * bad param can't walk all of git — src/server.ts `graphPayload`/`explicitRange`).
 * So loading history OLDER than the current window means fetching additional
 * bounded windows and stitching them client-side — the same approach DEPTH mode
 * already uses for its weekly massif, generalized here for the flat timeline so
 * dragging the pulse leftward can lazily pull in older history.
 *
 * `mergeGraphDocs(older, newer)` unions the two: the range spans both, every track
 * is merged by id, and per-track data is unioned by time. On any overlap the NEWER
 * window wins (it was generated more recently, so its bins/marks are fresher) — the
 * 20s poll relies on this to refresh the recent window over accumulated history.
 * Pure and deterministic: no clock, no fetch — trivially unit-testable.
 */

import type { GraphDocWire, GraphTrack } from './types';

/** Keep the last value seen per key (so an appended-newer item overwrites an older
 *  duplicate), then sort ascending by the extracted time. */
function dedupeSorted<T>(items: T[], keyOf: (x: T) => string, timeOf: (x: T) => number): T[] {
  const byKey = new Map<string, T>();
  for (const item of items) byKey.set(keyOf(item), item);
  return [...byKey.values()].sort((a, b) => timeOf(a) - timeOf(b));
}

/** Merge two tracks with the same id. `b` is the newer window and wins ties. If the
 *  types somehow differ (schema drift), trust the newer track wholesale. */
function mergeTrack(a: GraphTrack, b: GraphTrack): GraphTrack {
  if (a.type !== b.type) return b;
  switch (b.type) {
    case 'events': {
      const av = a as Extract<GraphTrack, { type: 'events' }>;
      return { ...b, marks: dedupeSorted([...av.marks, ...b.marks], (m) => `${m.t}|${m.kind ?? ''}|${m.label}`, (m) => m.t) };
    }
    case 'series': {
      const av = a as Extract<GraphTrack, { type: 'series' }>;
      return { ...b, points: dedupeSorted([...av.points, ...b.points], (p) => `${p.t}`, (p) => p.t) };
    }
    case 'bars': {
      const av = a as Extract<GraphTrack, { type: 'bars' }>;
      return { ...b, bins: dedupeSorted([...av.bins, ...b.bins], (bin) => `${bin.t}`, (bin) => bin.t) };
    }
    case 'spans': {
      const av = a as Extract<GraphTrack, { type: 'spans' }>;
      return { ...b, spans: dedupeSorted([...av.spans, ...b.spans], (s) => `${s.t0}|${s.t1}|${s.label}`, (s) => s.t0) };
    }
    case 'bands': {
      const av = a as Extract<GraphTrack, { type: 'bands' }>;
      return { ...b, segments: dedupeSorted([...av.segments, ...b.segments], (s) => `${s.t0}|${s.t1}|${s.category}`, (s) => s.t0) };
    }
  }
}

/**
 * Union two windows into one continuous doc. `older` supplies the earlier range
 * start; `newer` supplies the later range end and wins any overlapping data. Tracks
 * present in only one window are carried through unchanged. Descriptive metadata
 * (groups, insights, plan) is taken from `newer` — it reflects the freshest compute.
 */
export function mergeGraphDocs(older: GraphDocWire, newer: GraphDocWire): GraphDocWire {
  const olderById = new Map(older.tracks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const tracks: GraphTrack[] = [];
  for (const nt of newer.tracks) {
    const ot = olderById.get(nt.id);
    tracks.push(ot ? mergeTrack(ot, nt) : nt);
    seen.add(nt.id);
  }
  for (const ot of older.tracks) if (!seen.has(ot.id)) tracks.push(ot);

  return {
    ...newer,
    range: { start: Math.min(older.range.start, newer.range.start), end: Math.max(older.range.end, newer.range.end) },
    tracks,
    sources: [...new Set([...(older.sources ?? []), ...(newer.sources ?? [])])],
    generatedAt: Math.max(older.generatedAt, newer.generatedAt),
  };
}
