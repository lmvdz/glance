import { expect, test } from 'bun:test';
import { matchesTaskSearch } from './WorkbenchPane';
import type { Task } from '../types';

const t = (over: Partial<Task>): Task => ({ title: '', id: '', ...over } as unknown as Task);

test('matchesTaskSearch matches the Plane displayId shown on the row (was missed before)', () => {
  const task = t({ title: 'Harden login flow', id: 'plan:/repo:plans/auth-fix', displayId: 'OMPSQ-306' });
  expect(matchesTaskSearch(task, 'OMPSQ-306')).toBe(true); // the exact ID handle the row renders
  expect(matchesTaskSearch(task, '306')).toBe(true);
  expect(matchesTaskSearch(task, 'ompsq-306')).toBe(true); // case-insensitive
  expect(matchesTaskSearch(task, 'login')).toBe(true); // title
  expect(matchesTaskSearch(task, 'auth-fix')).toBe(true); // planDir slug via the internal id
  expect(matchesTaskSearch(task, 'nomatch')).toBe(false);
});

test('matchesTaskSearch: a blank query matches all; no displayId is fine', () => {
  const task = t({ title: 'A', id: 'plan:/r:plans/x' });
  expect(matchesTaskSearch(task, '')).toBe(true);
  expect(matchesTaskSearch(task, '   ')).toBe(true);
  expect(matchesTaskSearch(task, 'A')).toBe(true);
  expect(matchesTaskSearch(task, 'zzz')).toBe(false);
});
