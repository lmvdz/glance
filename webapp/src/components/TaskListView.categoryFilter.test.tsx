import { expect, test } from 'bun:test';
import { filterTasksByCategory } from './TaskListView';
import type { Task } from '../types';

// Taste-review nit 3 (CANVAS-AND-PAGE-CHAT.md D6): the Category Canvas's "+N more" overflow chip
// promised a FILTERED list (that category's plans) but landed on the full unfiltered one. This
// covers the pure filtering half of the fix; the stateful wiring (setTaskCategoryFilter +
// setTasksListMode('list') on `onShowMore`, the filter chip + its clear button) is covered live
// via the scratch-daemon screenshot pass, same convention TaskListView.viewMode.test.tsx documents
// for the rest of this file's stateful surface.

function task(overrides: Partial<Task> & { id: string; category: Task['category'] }): Task {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    category: overrides.category,
    duration: '1a',
    status: overrides.status ?? 'active',
    description: '',
    acceptanceCriteria: [],
    contextBundle: { spec: 'plans/x', criteria: '', prerequisites: '', decisions: '', downstream: '' },
    decisions: [],
    relationships: [],
    properties: { status: 'In Progress', priority: null, assignee: null, project: { id: 'p', name: 'p', shortCode: 'P', colorClass: '' }, estimate: null },
    tags: [],
    proofProvenance: { source: { type: 'manual', label: 'manual' }, worktrees: [], candidates: [] },
    ...overrides,
  };
}

test('null categoryId (unfiltered) returns every task, unchanged', () => {
  const tasks = [task({ id: 'a', category: 'frontend' }), task({ id: 'b', category: 'backend' })];
  expect(filterTasksByCategory(tasks, null)).toEqual(tasks);
});

test('a categoryId keeps only that category — the honest reading of "that category\'s plans"', () => {
  const tasks = [
    task({ id: 'a', category: 'frontend' }),
    task({ id: 'b', category: 'backend' }),
    task({ id: 'c', category: 'frontend' }),
  ];
  const filtered = filterTasksByCategory(tasks, 'frontend');
  expect(filtered.map((t) => t.id)).toEqual(['a', 'c']);
});

test('a categoryId with no matching tasks returns an empty list, not a crash or a silent fallback to everyone', () => {
  const tasks = [task({ id: 'a', category: 'frontend' })];
  expect(filterTasksByCategory(tasks, 'devops')).toEqual([]);
});

test('empty input list stays empty regardless of filter', () => {
  expect(filterTasksByCategory([], 'frontend')).toEqual([]);
  expect(filterTasksByCategory([], null)).toEqual([]);
});
