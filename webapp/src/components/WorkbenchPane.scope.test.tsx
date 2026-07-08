import { expect, test } from 'bun:test';
import { isTaskScopedView } from './WorkbenchPane';
import type { AppView } from '../context/TaskContext';

// The task-scoped control block (search, Open/Active/Done/All filters, progress,
// workspace tree, capability registry) used to render on EVERY view because none of
// that JSX was gated on `view` at all. isTaskScopedView is the single predicate that
// now gates it — only the Tasks view (list or detail; both report view === 'tasks')
// gets the block, every other view gets the nav-only rail.
test('isTaskScopedView is true only for the tasks view', () => {
  expect(isTaskScopedView('tasks')).toBe(true);
});

test('isTaskScopedView is false for every non-tasks view, including review', () => {
  // review (design-review) is task-adjacent but has its own dedicated context, so it
  // deliberately does NOT get the task-scoped block — a judgment call, see PR body.
  const nonTaskViews: AppView[] = [
    'attention', 'active', 'cockpit', 'capabilities', 'automation', 'fleet-health',
    'heat', 'activity-heatmap', 'omp-graph', 'scoreboard', 'topology', 'federation',
    'knowledge', 'org', 'intervene', 'review',
  ];
  for (const view of nonTaskViews) {
    expect(isTaskScopedView(view)).toBe(false);
  }
});
