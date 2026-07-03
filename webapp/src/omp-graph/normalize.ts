/**
 * Boundary coercion for the /api/graph* documents.
 *
 * `apiJson` only throws on a non-2xx response — a 200 with a *partial* body
 * (an empty org whose project-scoped payload is degenerate, a version-skewed
 * daemon, `{}` , `null`) parses fine and flows into state verbatim. The graph
 * DTOs all have REQUIRED fields (`range`, `tracks`, `sources`, `models`, …),
 * so a partial body yields `undefined` for exactly those fields and crashes at
 * the first nested access inside a `useMemo`/render (e.g. `doc.range.start`) —
 * outside any try/catch, taking down the whole view.
 *
 * These validators return a well-formed doc or `null`. Every consumer already
 * guards on `doc`/`attribution` being falsy (`doc ? … : null`, `attribution &&`),
 * so `null` degrades to an empty/loading state instead of a white screen. This
 * is the same boundary-normalize pattern as `normalizeCapabilities` /
 * `normalizeCatalog` in hooks/useSquad.ts.
 */
import type { AttributionDoc, CommitDetail, GraphDocWire, ProvenanceDoc } from './types';

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const arr = (v: unknown): v is unknown[] => Array.isArray(v);
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isRange = (v: unknown): v is { start: number; end: number } => obj(v) && num(v.start) && num(v.end);

/** A GraphDoc the pulse model can consume, or null when the body is missing its required shape. */
export function normalizeGraphDoc(v: unknown): GraphDocWire | null {
  if (!obj(v) || !isRange(v.range) || !arr(v.tracks) || !arr(v.sources)) return null;
  return {
    ...(v as unknown as GraphDocWire),
    range: v.range,
    groups: arr(v.groups) ? (v.groups as GraphDocWire['groups']) : [],
    tracks: v.tracks as GraphDocWire['tracks'],
    sources: v.sources as string[],
    generatedAt: num(v.generatedAt) ? v.generatedAt : v.range.end,
  };
}

/** A well-formed attribution doc, or null — the canvas bands and inspector already skip on null. */
export function normalizeAttribution(v: unknown): AttributionDoc | null {
  if (!obj(v) || !isRange(v.range) || !num(v.binMs)) return null;
  if (!arr(v.models) || !arr(v.harnesses) || !obj(v.byModel) || !obj(v.byHarness) || !obj(v.matrix)) return null;
  return {
    ...(v as unknown as AttributionDoc),
    range: v.range,
    binMs: v.binMs,
    models: v.models as string[],
    harnesses: v.harnesses as string[],
    byModel: v.byModel as Record<string, number[]>,
    byHarness: v.byHarness as Record<string, number[]>,
    matrix: v.matrix as Record<string, Record<string, number>>,
    totalCost: num(v.totalCost) ? v.totalCost : 0,
    generatedAt: num(v.generatedAt) ? v.generatedAt : v.range.end,
  };
}

/** A provenance doc with a real `runs` array, or null. */
export function normalizeProvenance(v: unknown): ProvenanceDoc | null {
  if (!obj(v) || typeof v.ticket !== 'string' || !arr(v.runs)) return null;
  return { ...(v as unknown as ProvenanceDoc), runs: v.runs as ProvenanceDoc['runs'] };
}

/** A commit-detail doc with a sha and `files` array, or null. */
export function normalizeCommitDetail(v: unknown): CommitDetail | null {
  if (!obj(v) || typeof v.sha !== 'string' || !arr(v.files)) return null;
  return { ...(v as unknown as CommitDetail), files: v.files as CommitDetail['files'] };
}
