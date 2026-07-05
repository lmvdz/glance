import { expect, test } from 'bun:test';
import { TASK_STATUSES, taskStatusForGroup } from './TaskListView';

test('every offered status maps to a DISTINCT persisted status — no silent collapse to Backlog', () => {
  const mapped = TASK_STATUSES.map((s) => taskStatusForGroup(s.group));
  // Before the fix the dropdown offered 5 options but Backlog/Todo/Cancelled all mapped to 'todo' → the
  // same 'planned' stage → reverted to Backlog on reload. Offering options that can't persist distinctly
  // is the lie this guards: no two options may share a persisted status.
  expect(new Set(mapped).size).toBe(TASK_STATUSES.length);
  expect([...mapped].sort()).toEqual(['active', 'done', 'todo']);
});
