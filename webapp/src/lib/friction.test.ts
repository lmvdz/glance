/**
 * friction.test.ts — the pure ledger logic the FrictionInbox renders. Focus on the DEFENSIVE seams:
 * response normalization across shapes, source classification with an ABSENT discriminator (this
 * branch is stacked below concern 02), and both conventions concern 02 might ship.
 */
import { describe, expect, test } from 'bun:test';
import {
  autoSubtype,
  contextLabel,
  filterFriction,
  frictionSource,
  isFrictionEntry,
  normalizeFrictionResponse,
  repoLabel,
  sourceCounts,
  type FrictionEntry,
} from './friction';

function entry(p: Partial<FrictionEntry> = {}): FrictionEntry {
  return { id: 'f1', ts: 1_000, repo: '/home/u/proj', gripe: 'this is annoying', ...p };
}

describe('normalizeFrictionResponse — accept any shape, always newest-first', () => {
  test('the real {entries:[...]} envelope', () => {
    const out = normalizeFrictionResponse({ entries: [entry({ id: 'a', ts: 1 }), entry({ id: 'b', ts: 5 })] });
    expect(out.map((e) => e.id)).toEqual(['b', 'a']); // sorted newest-first
  });

  test('a bare array (older/future shape) still works and is sorted', () => {
    const out = normalizeFrictionResponse([entry({ id: 'a', ts: 9 }), entry({ id: 'b', ts: 2 })]);
    expect(out.map((e) => e.id)).toEqual(['a', 'b']);
  });

  test('garbage / null / wrong-typed body → empty array, never throws', () => {
    expect(normalizeFrictionResponse(null)).toEqual([]);
    expect(normalizeFrictionResponse('nope')).toEqual([]);
    expect(normalizeFrictionResponse({ nope: true })).toEqual([]);
    expect(normalizeFrictionResponse({ entries: 'not-an-array' })).toEqual([]);
  });

  test('torn/foreign lines are dropped, valid siblings kept', () => {
    const out = normalizeFrictionResponse({
      entries: [entry({ id: 'good', ts: 3 }), { id: 5, gripe: 'x' }, { gripe: 'no id', ts: 1, repo: '' }, null],
    });
    expect(out.map((e) => e.id)).toEqual(['good']);
  });
});

describe('isFrictionEntry', () => {
  test('needs string id + string gripe + finite ts + string repo', () => {
    expect(isFrictionEntry(entry())).toBe(true);
    expect(isFrictionEntry({ ...entry(), ts: Number.NaN })).toBe(false);
    expect(isFrictionEntry({ ...entry(), repo: undefined })).toBe(false);
    expect(isFrictionEntry(null)).toBe(false);
  });
});

describe('frictionSource — absent discriminator defaults to human', () => {
  test('no source field and no auto: context ⇒ human (pre-concern-02 default)', () => {
    expect(frictionSource(entry({ context: 'cli' }))).toBe('human');
    expect(frictionSource(entry())).toBe('human');
  });

  test('explicit source field wins (concern-02 convention A)', () => {
    expect(frictionSource(entry({ source: 'auto' }))).toBe('auto');
    expect(frictionSource(entry({ source: 'human', context: 'auto:acp-timeout' }))).toBe('human');
  });

  test('auto: context prefix marks auto when no source field (concern-02 convention B)', () => {
    expect(frictionSource(entry({ context: 'auto:held-sync' }))).toBe('auto');
    expect(frictionSource(entry({ context: 'AUTO:Session-Loss' }))).toBe('auto'); // case-insensitive
  });
});

describe('autoSubtype + contextLabel', () => {
  test('autoSubtype strips the prefix for auto rows, empty for human', () => {
    expect(autoSubtype(entry({ context: 'auto:acp-timeout' }))).toBe('acp-timeout');
    expect(autoSubtype(entry({ context: 'cli' }))).toBe('');
    expect(autoSubtype(entry({ source: 'auto', context: 'auto:held-sync' }))).toBe('held-sync');
  });

  test('contextLabel shows the subtype for auto, the raw context for human, nothing for a bare auto:', () => {
    expect(contextLabel(entry({ context: 'auto:acp-timeout' }))).toBe('acp-timeout');
    expect(contextLabel(entry({ context: 'webapp-composer' }))).toBe('webapp-composer');
    expect(contextLabel(entry({ context: 'auto:' }))).toBe('');
    expect(contextLabel(entry({ context: '' }))).toBe('');
  });
});

describe('repoLabel', () => {
  test('basename of a path, trailing slash tolerant', () => {
    expect(repoLabel('/home/u/omp-squad')).toBe('omp-squad');
    expect(repoLabel('/home/u/omp-squad/')).toBe('omp-squad');
    expect(repoLabel('omp-squad')).toBe('omp-squad');
  });
  test('empty repo reads "unknown repo"', () => {
    expect(repoLabel('')).toBe('unknown repo');
  });
});

describe('filterFriction + sourceCounts', () => {
  const entries = [
    entry({ id: 'h1', context: 'cli' }),
    entry({ id: 'a1', context: 'auto:acp-timeout' }),
    entry({ id: 'a2', source: 'auto' }),
    entry({ id: 'h2' }),
  ];

  test('all passes everything, order preserved', () => {
    expect(filterFriction(entries, 'all').map((e) => e.id)).toEqual(['h1', 'a1', 'a2', 'h2']);
  });
  test('human/auto split by classified source', () => {
    expect(filterFriction(entries, 'human').map((e) => e.id)).toEqual(['h1', 'h2']);
    expect(filterFriction(entries, 'auto').map((e) => e.id)).toEqual(['a1', 'a2']);
  });
  test('sourceCounts tallies each bucket', () => {
    expect(sourceCounts(entries)).toEqual({ all: 4, human: 2, auto: 2 });
  });
});
