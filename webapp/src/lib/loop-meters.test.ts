/**
 * loop-meters.test.ts — the pure layer behind the Daily "learning loop" card, the TaskDetail
 * after-action section, and the Fog symptoms list. Coercers are the trust boundary (unknown-vintage
 * payloads become safe empties, never crashes); view builders carry the honesty rules (sample
 * counts always ride along, unknown flags/metrics render rather than vanish).
 */
import { describe, expect, test } from 'bun:test';
import {
  coerceAfterActions,
  coerceLearningLoop,
  coerceSymptoms,
  flagChips,
  meterRows,
  reportsForAgents,
  type AfterActionWire,
} from './loop-meters';

describe('coerceLearningLoop', () => {
  test('valid payload passes through, byTag dropped', () => {
    const wire = coerceLearningLoop({
      flags: { failureMemory: 'on', reflexion: 'off' },
      rollup: [{ name: 'first-try-green', count: 5, sum: 3, avg: 0.6, byTag: { variant: {} } }],
    });
    expect(wire.flags).toEqual({ failureMemory: 'on', reflexion: 'off' });
    expect(wire.rollup).toEqual([{ name: 'first-try-green', count: 5, sum: 3, avg: 0.6 }]);
  });

  test('garbage of any vintage coerces to a safe empty, never throws', () => {
    for (const garbage of [null, undefined, 42, 'nope', [], { flags: 7, rollup: 'x' }, { rollup: [{ name: 9 }] }]) {
      const wire = coerceLearningLoop(garbage);
      expect(wire.flags).toEqual({});
      expect(wire.rollup).toEqual([]);
    }
  });
});

describe('flagChips', () => {
  test('known flags keep curated order + labels; unknown server-added flags still render, prettified', () => {
    const chips = flagChips({ reflexion: 'off', failureMemory: 'on', brandNewThing: 'on' });
    expect(chips.map((c) => c.key)).toEqual(['failureMemory', 'reflexion', 'brandNewThing']);
    expect(chips[0]).toEqual({ key: 'failureMemory', label: 'Failure memory', on: true });
    expect(chips[2]).toEqual({ key: 'brandNewThing', label: 'Brand new thing', on: true });
  });

  test('a non-"on" value reads as off — never optimistically on', () => {
    const chips = flagChips({ failureMemory: 'ab' });
    expect(chips[0]!.on).toBe(false);
  });
});

describe('meterRows', () => {
  test('rate metrics render avg as a percent, count metrics as a decimal, n always carried', () => {
    const rows = meterRows([
      { name: 'first-try-green', count: 8, sum: 6, avg: 0.75 },
      { name: 'fixups-to-green', count: 4, sum: 6, avg: 1.5 },
    ]);
    expect(rows[0]).toEqual({ name: 'first-try-green', label: 'First-try green', value: '75%', n: 8 });
    expect(rows[1]).toEqual({ name: 'fixups-to-green', label: 'Fixups to green', value: '1.5', n: 4 });
  });

  test('zero-count rows are dropped (no fake 0% over n=0) and unknown metric names still render', () => {
    const rows = meterRows([
      { name: 'escalation', count: 0, sum: 0, avg: 0 },
      { name: 'some-new-metric', count: 2, sum: 3, avg: 1.5 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe('Some new metric');
  });
});

const report = (id: string, terminalAt: number): AfterActionWire => ({
  id,
  name: id,
  repo: '/srv/app',
  terminalReason: 'gate failed twice',
  terminalAt,
  classification: 'implementation',
  commitsAhead: 2,
  dirtyFiles: 0,
  markdown: '# post-mortem',
  createdAt: terminalAt,
});

describe('coerceAfterActions', () => {
  test('valid reports pass; rows missing required fields drop; unknown classification maps to unknown', () => {
    const out = coerceAfterActions([
      { ...report('a', 1), classification: 'weird' },
      { id: 'broken' }, // no terminalReason/markdown
      'garbage',
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.classification).toBe('unknown');
  });

  test('non-array payloads coerce to empty', () => {
    expect(coerceAfterActions({ reports: [] })).toEqual([]);
    expect(coerceAfterActions(null)).toEqual([]);
  });

  test('missing counts fail closed to -1 (unknown), matching src/after-action.ts semantics', () => {
    const out = coerceAfterActions([{ id: 'a', terminalReason: 'r', markdown: 'm' }]);
    expect(out[0]!.commitsAhead).toBe(-1);
    expect(out[0]!.dirtyFiles).toBe(-1);
  });
});

describe('reportsForAgents', () => {
  test('filters to the given ids and sorts newest-terminal-first', () => {
    const all = [report('a', 100), report('b', 300), report('c', 200)];
    expect(reportsForAgents(all, ['a', 'c', 'nope']).map((r) => r.id)).toEqual(['c', 'a']);
  });

  test('empty id set matches nothing', () => {
    expect(reportsForAgents([report('a', 1)], [])).toEqual([]);
  });
});

describe('coerceSymptoms', () => {
  test('unwraps { symptoms }, keeps string whereToLook entries only, tolerates missing fixedBy', () => {
    const out = coerceSymptoms({
      symptoms: [
        { id: 's1', symptom: 'dispatch stalls', whereToLook: ['src/dispatch.ts', 7], repo: '/srv/app', landedAt: 5, fixedBy: { prNumber: 42 } },
        { id: 's2', symptom: 'land never fires', repo: '/srv/app', landedAt: 6 },
        { nope: true },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]!.whereToLook).toEqual(['src/dispatch.ts']);
    expect(out[0]!.fixedBy?.prNumber).toBe(42);
    expect(out[1]!.whereToLook).toEqual([]);
  });

  test('garbage coerces to empty', () => {
    expect(coerceSymptoms(null)).toEqual([]);
    expect(coerceSymptoms({ symptoms: 'x' })).toEqual([]);
  });
});
