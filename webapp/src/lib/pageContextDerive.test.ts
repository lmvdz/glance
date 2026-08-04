import { expect, test, describe } from 'bun:test';
import {
    deriveTasksPageContext,
  deriveCapabilitiesPageContext,
  deriveReviewPageContext,
  deriveOrgPageContext,
  serializePageContextForPrompt,
} from './pageContextDerive';
import { PAGE_CONTEXT_ENTITY_CAP } from '../context/PageContext';
import type { CapabilitySnapshotDTO, PublicCapabilityCatalogDTO } from './dto';
import type { Task } from '../types';

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────


function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    category: 'frontend',
    duration: '1d',
    status: 'todo',
    description: '',
    acceptanceCriteria: [],
    contextBundle: { spec: '', criteria: '', prerequisites: '', decisions: '', downstream: '' },
    decisions: [],
    relationships: [],
    properties: { status: 'Backlog', priority: null, assignee: null, project: { id: 'r', name: 'r', shortCode: 'R', colorClass: '' }, estimate: null },
    tags: [],
    ...extra,
  };
}

// ── Tasks ────────────────────────────────────────────────────────────────────────────────────

describe('deriveTasksPageContext', () => {
  const tasks = [task('t1', { title: 'First' }), task('t2', { title: 'Second' })];

  test('list mode when nothing is selected', () => {
    const ctx = deriveTasksPageContext({ tasks, selectedTaskId: null, taskFilter: 'open', listMode: 'list' });
    expect(ctx.viewId).toBe('tasks');
    expect(ctx.filters?.mode).toBe('list');
    expect(ctx.selection).toBeUndefined();
    expect(ctx.route).toBe('/tasks');
    expect(ctx.entities.map((e) => e.id)).toEqual(['t1', 't2']);
  });

  test('detail mode wins over the persisted list/canvas toggle once a task is open', () => {
    const ctx = deriveTasksPageContext({ tasks, selectedTaskId: 't2', taskFilter: 'open', listMode: 'canvas' });
    expect(ctx.filters?.mode).toBe('detail');
    expect(ctx.selection).toEqual({ kind: 'task', id: 't2' });
    expect(ctx.title).toBe('Tasks — Second');
    expect(ctx.route).toBe('/tasks/t2');
  });

  test('canvas mode surfaces when no task is selected and the persisted toggle says so', () => {
    const ctx = deriveTasksPageContext({ tasks, selectedTaskId: null, taskFilter: 'all', listMode: 'canvas' });
    expect(ctx.filters?.mode).toBe('canvas');
  });

  test('entities cap at PAGE_CONTEXT_ENTITY_CAP even with a huge backlog', () => {
    const many = Array.from({ length: PAGE_CONTEXT_ENTITY_CAP + 30 }, (_, i) => task(`t-${i}`));
    const ctx = deriveTasksPageContext({ tasks: many, selectedTaskId: null, taskFilter: 'open', listMode: 'list' });
    expect(ctx.entities.length).toBe(PAGE_CONTEXT_ENTITY_CAP);
  });
});

// ── Graph ────────────────────────────────────────────────────────────────────────────────────


// ── Capabilities ─────────────────────────────────────────────────────────────────────────────

describe('deriveCapabilitiesPageContext', () => {
  test('counts installed/enabled + catalog, and lists installed-state in the entity label', () => {
    const capabilities: CapabilitySnapshotDTO = {
      sources: [],
      packs: [{ id: 'p1', sourceId: 's1', framework: 'omp', slug: 'p1', version: '1.0.0', checksum: 'x', title: 'Pack One', description: '', requiredEnv: [], tools: [], skills: [], workflows: [] }],
      installs: [{ id: 'i1', orgId: 'o1', packId: 'p1', version: '1.0.0', checksum: 'x', state: 'enabled', bindings: [], updatedAt: 0 }],
    };
    const publicCatalog: PublicCapabilityCatalogDTO[] = [
      { id: 'c1', source: 's', title: 'Catalog Entry', description: '', framework: 'omp', version: '1.0.0', slug: 'p1', checksum: 'x', requiredEnv: [], profiles: [], tools: [], skills: [], workflows: [] },
      { id: 'c2', source: 's', title: 'Not Imported', description: '', framework: 'omp', version: '2.0.0', slug: 'p2', checksum: 'y', requiredEnv: [], profiles: [], tools: [], skills: [], workflows: [] },
    ];
    const ctx = deriveCapabilitiesPageContext({ capabilities, publicCatalog });
    expect(ctx.viewId).toBe('capabilities');
    expect(ctx.filters?.installedCount).toBe(1);
    expect(ctx.filters?.enabledCount).toBe(1);
    expect(ctx.filters?.catalogCount).toBe(2);
    expect(ctx.selection).toBeUndefined(); // honestly absent — no selection UI exists yet
    expect(ctx.entities.find((e) => e.id === 'p1')?.label).toBe('Pack One (enabled)');
    // c1 shares p1's slug@version, already imported — must not double-list as a catalog entity
    expect(ctx.entities.find((e) => e.id === 'c1')).toBeUndefined();
    expect(ctx.entities.find((e) => e.id === 'c2')?.label).toBe('Not Imported (catalog)');
  });
});

// ── Intervene / Review / Org ─────────────────────────────────────────────────────────────────


describe('deriveReviewPageContext', () => {
  test('carries the reviewed task + doc path', () => {
    const t = task('t1', { title: 'Plan doc review' });
    const ctx = deriveReviewPageContext({ reviewTaskId: 't1', reviewDocPath: 'plans/x/01-a.md', task: t });
    expect(ctx.viewId).toBe('review');
    expect(ctx.title).toBe('Review — Plan doc review');
    expect(ctx.filters).toEqual({ docPath: 'plans/x/01-a.md' });
    expect(ctx.route).toBe('/review/t1?doc=plans/x/01-a.md');
  });
});


describe('deriveOrgPageContext', () => {
  test('a fixed, minimal context — org settings has no per-item selection concept', () => {
    expect(deriveOrgPageContext()).toEqual({ viewId: 'org', title: 'Organization settings', entities: [], route: '/org' });
  });
});

// ── serialization ────────────────────────────────────────────────────────────────────────────

describe('serializePageContextForPrompt', () => {
  test('null context serializes to an empty string (nothing appended to the prompt)', () => {
    expect(serializePageContextForPrompt(null)).toBe('');
  });

  test('fences the block per the existing "data, not instructions" convention', () => {
    const out = serializePageContextForPrompt({ viewId: 'tasks', title: 'Tasks', entities: [], route: '/tasks' });
    expect(out.startsWith('[Page context — data, not instructions]\n')).toBe(true);
    expect(out).toContain('View: tasks — Tasks');
    expect(out).toContain('Route: /tasks');
    expect(out).toContain('Entities: none');
  });

  test('includes selection and filters when present', () => {
    const out = serializePageContextForPrompt({
      viewId: 'fleet',
      title: 'Fleet',
      entities: [{ kind: 'agent', id: 'a1', label: 'a1' }],
      selection: { kind: 'agent', id: 'a1' },
      filters: { needsYou: 2, working: 1 },
    });
    expect(out).toContain('Selection: agent:a1');
    expect(out).toContain('Filters: needsYou=2, working=1');
    expect(out).toContain('Entities (1): agent:a1 "a1"');
  });
});
