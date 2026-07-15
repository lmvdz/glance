/**
 * Project selection + scoping rules (`resolveCurrentProject`, `tasksForProject`, `projectsByTeam`).
 *
 * `currentProject` used to be `selectedTask?.properties.project ?? projects[0]` — derived, never
 * settable. Nothing in the web UI could switch projects: the sidebar's project rows only toggled a
 * disclosure, and the sole add-a-project screen (FirstRunSetup) was gated on having ZERO projects, so
 * it appeared exactly once and was unreachable ever after.
 *
 * Pure rules, tested the way this webapp tests everything else.
 */

import { expect, test } from 'bun:test';
import type { ProjectDTO } from './dto';
import type { Project, Task } from '../types';
import { normalizeRepoKey, projectsByTeam, resolveCurrentProject, tasksForProject, tasksFromSquad } from './task-model';

const project = (id: string, name = id): Project => ({ id, name, shortCode: name.slice(0, 4).toUpperCase(), colorClass: 'bg-blue-500' });

const task = (id: string, projectId: string): Task =>
  ({ id, title: id, properties: { project: project(projectId) } }) as unknown as Task;

const dto = (repo: string, over: Partial<ProjectDTO> = {}): ProjectDTO => ({
  id: repo,
  name: repo.split('/').pop() ?? repo,
  repo,
  agentCount: 0,
  statusCounts: {},
  pendingCount: 0,
  lastActivity: 0,
  featureCount: 0,
  registered: false,
  ...over,
});

// ── resolveCurrentProject ───────────────────────────────────────────────────────────────────────

test('the operator\'s explicit choice wins over the default', () => {
  const projects = [project('/srv/alpha'), project('/srv/beta')];
  expect(resolveCurrentProject(projects, '/srv/beta')?.id).toBe('/srv/beta');
});

test('no choice ⇒ the first (busiest) project, never null while a project exists', () => {
  const projects = [project('/srv/alpha'), project('/srv/beta')];
  expect(resolveCurrentProject(projects, null)?.id).toBe('/srv/alpha');
});

/** A stale id is the normal case after un-registering, or after a repo drains. Stranding the workspace
 *  on nothing would make every list look empty and every "add task" fail. */
test('a stale id falls back to the first project rather than stranding the workspace', () => {
  const projects = [project('/srv/alpha')];
  expect(resolveCurrentProject(projects, '/srv/deleted')?.id).toBe('/srv/alpha');
});

test('no projects at all ⇒ null (a fresh daemon, nothing registered)', () => {
  expect(resolveCurrentProject([], '/srv/alpha')).toBeNull();
  expect(resolveCurrentProject([], null)).toBeNull();
});

// ── tasksForProject ─────────────────────────────────────────────────────────────────────────────

test('scopes tasks to the current project — this is what switching means', () => {
  const tasks = [task('t1', '/srv/alpha'), task('t2', '/srv/beta'), task('t3', '/srv/alpha')];
  expect(tasksForProject(tasks, project('/srv/alpha')).map((t) => t.id)).toEqual(['t1', 't3']);
  expect(tasksForProject(tasks, project('/srv/beta')).map((t) => t.id)).toEqual(['t2']);
});

/** With no project, show the work rather than hide it — an empty workspace that also looks empty of
 *  tasks is indistinguishable from a broken one. */
test('no project ⇒ every task passes through unfiltered', () => {
  const tasks = [task('t1', '/srv/alpha'), task('t2', '/srv/beta')];
  expect(tasksForProject(tasks, null)).toHaveLength(2);
});

test('a project with no tasks scopes to empty, not to everything', () => {
  const tasks = [task('t1', '/srv/alpha')];
  expect(tasksForProject(tasks, project('/srv/empty'))).toEqual([]);
});

// ── projectsByTeam: the list the switcher renders ───────────────────────────────────────────────

/** The server now unions registry ∪ live-agent repos ∪ feature repos, so a repo with zero agents still
 *  arrives in `projects`. The client must render it — the old fallback only consulted features when the
 *  project list was ENTIRELY empty, so a quiet repo vanished the moment any other repo had an agent. */
test('renders every project the server sends, including one with no agents and no features', () => {
  const projects = projectsByTeam([dto('/srv/busy', { agentCount: 3, lastActivity: 9 }), dto('/srv/quiet', { registered: true })], []);
  const ids = Object.values(projects).flat().map((p) => p.id);
  expect(ids).toEqual(['/srv/busy', '/srv/quiet']);
});

test('falls back to feature repos only when the server sends no projects at all', () => {
  const features = [{ id: 'f0', title: 'x', repo: '/srv/from-feature', agentIds: [], stage: 'implementing' }] as never;
  const ids = Object.values(projectsByTeam([], features)).flat().map((p) => p.id);
  expect(ids).toEqual(['/srv/from-feature']);
});

// ── the feature → project join must not split on spelling ───────────────────────────────────────

test('normalizeRepoKey strips trailing slashes so the three repo sources collapse', () => {
  expect(normalizeRepoKey('/srv/app/')).toBe('/srv/app');
  expect(normalizeRepoKey('/srv/app//')).toBe('/srv/app');
  expect(normalizeRepoKey('  /srv/app  ')).toBe('/srv/app');
  expect(normalizeRepoKey('/')).toBe('/'); // never normalize a bare root away to ""
});

/** The server keys ProjectDTO.id on a normalized path. A feature carrying "/srv/app/" used to miss the
 *  lookup, get a project whose id was the raw string, and then never match currentProject.id — so its
 *  task vanished from the scoped list. Found by cross-lineage review (grok-4.5). */
test('a feature whose repo is spelled with a trailing slash still joins its project', () => {
  const projects = [dto('/srv/app', { agentCount: 1 })];
  const features = [{ id: 'f1', title: 'work', repo: '/srv/app/', agentIds: [], stage: 'implementing' }] as never;
  const tasks = tasksFromSquad(features, [], projects);

  expect(tasks).toHaveLength(1);
  expect(tasks[0].properties.project.id).toBe('/srv/app'); // the normalized id, not "/srv/app/"

  // …and therefore it survives the project scope, instead of silently disappearing.
  const current = resolveCurrentProject(Object.values(projectsByTeam(projects, [])).flat(), null);
  expect(tasksForProject(tasks, current)).toHaveLength(1);
});

// Live finding 2026-07-15: a persisted selection pointing at a deleted repo path kept default-
// loading a dead project; everything downstream (console agents, voice dispatches) died on it.
const HEALTHY = { id: '/a', name: 'a', shortCode: 'A', colorClass: 'c' };
const BROKEN = { id: '/gone', name: 'gone', shortCode: 'G', colorClass: 'c', pathMissing: true as const };

test('resolveCurrentProject: a persisted selection whose path is gone falls back to the first healthy project', () => {
  expect(resolveCurrentProject([BROKEN, HEALTHY], '/gone')).toBe(HEALTHY);
});

test('resolveCurrentProject: no selection defaults to the first healthy project, skipping broken ones', () => {
  expect(resolveCurrentProject([BROKEN, HEALTHY], null)).toBe(HEALTHY);
});

test('resolveCurrentProject: all-broken workspace still returns something (the broken selection) rather than null', () => {
  expect(resolveCurrentProject([BROKEN], '/gone')).toBe(BROKEN);
});

test('resolveCurrentProject: healthy selection honored exactly as before', () => {
  expect(resolveCurrentProject([BROKEN, HEALTHY], '/a')).toBe(HEALTHY);
});

test('projectsByTeam: daemon exists=false surfaces as pathMissing; absent exists (older daemon) reads healthy', () => {
  const dtos = [
    { repo: '/gone', exists: false },
    { repo: '/here', exists: true },
    { repo: '/old-daemon' },
  ] as Parameters<typeof projectsByTeam>[0];
  const list = projectsByTeam(dtos)['OMP SQUAD'];
  expect(list.find((p) => p.id === '/gone')?.pathMissing).toBe(true);
  expect(list.find((p) => p.id === '/here')?.pathMissing).toBeUndefined();
  expect(list.find((p) => p.id === '/old-daemon')?.pathMissing).toBeUndefined();
});
