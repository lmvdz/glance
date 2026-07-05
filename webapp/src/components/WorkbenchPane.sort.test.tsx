import { expect, test } from 'bun:test';
import { compareTaskRail } from './WorkbenchPane';
import type { Task } from '../types';

// The comparator only reads properties.createdAt (creation) and rankFor (attention).
const t = (id: string, createdAt?: number): Task => ({ id, properties: { createdAt } } as unknown as Task);

test('compareTaskRail creation: most recently created first, undated sorts last', () => {
  const older = t('old', 100);
  const newer = t('new', 200);
  const undated = t('undated', undefined);
  const sorted = [older, undated, newer].sort((a, b) => compareTaskRail(a, b, 'creation', () => 0));
  // Was DEAD before the fix — the comparator returned 0 for 'creation' and never touched createdAt.
  expect(sorted.map((x) => x.id)).toEqual(['new', 'old', 'undated']);
});

test('compareTaskRail attention: orders by rankFor ascending so what-needs-you floats up', () => {
  const rank = new Map<string, number>([['a', 2], ['b', 0], ['c', 1]]);
  const sorted = [t('a'), t('b'), t('c')].sort((x, y) => compareTaskRail(x, y, 'attention', (task) => rank.get(task.id)!));
  expect(sorted.map((x) => x.id)).toEqual(['b', 'c', 'a']);
});
