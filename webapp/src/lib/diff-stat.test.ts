import { expect, test } from 'bun:test';
import { aggregateDiffCounts, countDiffLines, diffSignal, idsNeedingDiffFetch, rosterDiffSignature } from './diff-stat';

test('countDiffLines counts + and - content lines, ignoring the +++/--- file headers', () => {
  const diff = [
    '--- a/foo.ts',
    '+++ b/foo.ts',
    '@@ -1,3 +1,4 @@',
    ' unchanged',
    '-removed one',
    '-removed two',
    '+added one',
    '+added two',
    '+added three',
  ].join('\n');
  expect(countDiffLines(diff)).toEqual({ added: 3, removed: 2 });
});

test('countDiffLines handles undefined/empty diff text', () => {
  expect(countDiffLines(undefined)).toEqual({ added: 0, removed: 0 });
  expect(countDiffLines('')).toEqual({ added: 0, removed: 0 });
});

test('aggregateDiffCounts sums across files and reports the file count', () => {
  const diffs = [
    { diff: '+a\n+b\n-c' },
    { diff: '+d' },
    { diff: undefined },
  ];
  expect(aggregateDiffCounts(diffs)).toEqual({ added: 3, removed: 1, files: 3 });
});

test('diffSignal is stable for the same messageCount/status and changes when either changes', () => {
  const a = { id: 'x', messageCount: 3, status: 'working' };
  expect(diffSignal(a)).toBe(diffSignal({ ...a }));
  expect(diffSignal(a)).not.toBe(diffSignal({ ...a, messageCount: 4 }));
  expect(diffSignal(a)).not.toBe(diffSignal({ ...a, status: 'idle' }));
});

test('diffSignal defaults a missing messageCount to 0', () => {
  expect(diffSignal({ id: 'x', status: 'idle' })).toBe(diffSignal({ id: 'x', status: 'idle', messageCount: 0 }));
});

test('diffSignal changes when landReady or prState changes (post-land diff refetch)', () => {
  const base = { id: 'x', messageCount: 3, status: 'idle' };
  expect(diffSignal(base)).not.toBe(diffSignal({ ...base, landReady: true }));
  expect(diffSignal(base)).not.toBe(diffSignal({ ...base, prState: 'merged' }));
  expect(diffSignal({ ...base, prState: 'open' })).not.toBe(diffSignal({ ...base, prState: 'merged' }));
});

test('diffSignal changes when validationVerdict changes — a validator resolving (or a fresh land getting held) is diff-relevant too', () => {
  const base = { id: 'x', messageCount: 3, status: 'idle', landReady: true };
  expect(diffSignal(base)).not.toBe(diffSignal({ ...base, validationVerdict: 'veto' }));
  expect(diffSignal({ ...base, validationVerdict: 'veto' })).not.toBe(diffSignal({ ...base, validationVerdict: 'inconclusive' }));
  expect(diffSignal({ ...base, validationVerdict: 'pass' })).not.toBe(diffSignal({ ...base, validationVerdict: undefined }));
});

test('idsNeedingDiffFetch: fetches an id with no prior signal', () => {
  const agents = [{ id: 'a', messageCount: 1, status: 'working' }];
  expect(idsNeedingDiffFetch(agents, new Map())).toEqual(['a']);
});

test('idsNeedingDiffFetch: skips an id whose signal is unchanged', () => {
  const agents = [{ id: 'a', messageCount: 1, status: 'working' }];
  const seen = new Map([['a', diffSignal(agents[0])]]);
  expect(idsNeedingDiffFetch(agents, seen)).toEqual([]);
});

test('idsNeedingDiffFetch: refetches only the id whose signal changed, in a mixed roster', () => {
  const agents = [
    { id: 'a', messageCount: 1, status: 'working' },
    { id: 'b', messageCount: 2, status: 'idle' },
  ];
  const seen = new Map([
    ['a', diffSignal(agents[0])],
    ['b', diffSignal({ id: 'b', messageCount: 1, status: 'idle' })], // stale
  ]);
  expect(idsNeedingDiffFetch(agents, seen)).toEqual(['b']);
});

test('rosterDiffSignature is stable across array identity changes with the same content', () => {
  const a = [{ id: 'a', messageCount: 1, status: 'working' }, { id: 'b', status: 'idle' }];
  const b = [{ ...a[0] }, { ...a[1] }]; // new identities, same content
  expect(rosterDiffSignature(a)).toBe(rosterDiffSignature(b));
});

test('rosterDiffSignature changes when any agent signal or the roster membership changes', () => {
  const base = [{ id: 'a', messageCount: 1, status: 'working' }];
  expect(rosterDiffSignature(base)).not.toBe(rosterDiffSignature([{ ...base[0], status: 'idle' }]));
  expect(rosterDiffSignature(base)).not.toBe(rosterDiffSignature([...base, { id: 'b', status: 'idle' }]));
});
