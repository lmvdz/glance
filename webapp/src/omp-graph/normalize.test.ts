/**
 * Graph boundary normalizers: `apiJson` only throws on non-2xx, so a 200 with a
 * partial body (an empty org's degenerate payload, a version-skewed daemon)
 * reaches the panels verbatim and crashes at the first required-field access
 * (doc.range.start, attribution.models.slice, doc.runs.reduce, detail.sha.slice).
 * These validators must turn any such body into null so the callers' existing
 * falsy-guards degrade to an empty state instead of white-screening.
 */
import { describe, expect, test } from 'bun:test';
import { normalizeAttribution, normalizeCommitDetail, normalizeGraphDoc, normalizeProvenance } from './normalize';

const RANGE = { start: 1000, end: 2000 };

describe('normalizeGraphDoc', () => {
  test('returns null for empty / partial / null bodies', () => {
    expect(normalizeGraphDoc({})).toBeNull();
    expect(normalizeGraphDoc(null)).toBeNull();
    expect(normalizeGraphDoc(undefined)).toBeNull();
    expect(normalizeGraphDoc({ range: RANGE })).toBeNull(); // missing tracks/sources
    expect(normalizeGraphDoc({ range: { start: 1 }, tracks: [], sources: [] })).toBeNull(); // range.end missing
  });

  test('accepts a well-formed doc and fills optional fields', () => {
    const out = normalizeGraphDoc({ range: RANGE, tracks: [], sources: ['git'] });
    expect(out).not.toBeNull();
    expect(out!.range).toEqual(RANGE);
    expect(out!.groups).toEqual([]);
    expect(out!.generatedAt).toBe(RANGE.end); // defaulted from range.end
    expect(out!.sources).toEqual(['git']);
  });

  test('preserves a real generatedAt and groups', () => {
    const out = normalizeGraphDoc({ range: RANGE, tracks: [], sources: [], groups: [{ id: 'g' }], generatedAt: 1500 });
    expect(out!.generatedAt).toBe(1500);
    expect(out!.groups.length).toBe(1);
  });
});

describe('normalizeAttribution', () => {
  test('returns null for partial bodies missing required maps', () => {
    expect(normalizeAttribution({})).toBeNull();
    expect(normalizeAttribution(null)).toBeNull();
    expect(normalizeAttribution({ range: RANGE, binMs: 10 })).toBeNull(); // no models/harnesses/maps
    expect(normalizeAttribution({ range: RANGE, binMs: 10, models: [], harnesses: [], byModel: {}, byHarness: {} })).toBeNull(); // no matrix
  });

  test('accepts a well-formed doc and defaults totalCost', () => {
    const out = normalizeAttribution({ range: RANGE, binMs: 10, models: ['opus'], harnesses: ['cc'], byModel: {}, byHarness: {}, matrix: {} });
    expect(out).not.toBeNull();
    expect(out!.totalCost).toBe(0);
    expect(out!.models).toEqual(['opus']);
  });
});

describe('normalizeProvenance', () => {
  test('returns null without a ticket or runs array', () => {
    expect(normalizeProvenance({})).toBeNull();
    expect(normalizeProvenance({ ticket: 'OMPSQ-1' })).toBeNull(); // no runs
    expect(normalizeProvenance({ runs: [] })).toBeNull(); // no ticket
  });

  test('accepts a doc with a runs array', () => {
    const out = normalizeProvenance({ ticket: 'OMPSQ-1', runs: [] });
    expect(out).not.toBeNull();
    expect(out!.runs).toEqual([]);
  });
});

describe('normalizeCommitDetail', () => {
  test('returns null without sha or files', () => {
    expect(normalizeCommitDetail({})).toBeNull();
    expect(normalizeCommitDetail({ sha: 'abc' })).toBeNull(); // no files
    expect(normalizeCommitDetail({ files: [] })).toBeNull(); // no sha
  });

  test('accepts a doc with sha and files', () => {
    const out = normalizeCommitDetail({ sha: 'abc123', files: [] });
    expect(out).not.toBeNull();
    expect(out!.sha).toBe('abc123');
  });
});
