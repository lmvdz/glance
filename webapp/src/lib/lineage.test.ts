/**
 * lineage.test.ts — the parent/child agent forest builder. DOM-free (bun:test).
 */
import { describe, expect, test } from 'bun:test';
import { buildLineageTree } from './lineage';
import type { AgentDTO } from './dto';

function agent(id: string, extra: Partial<AgentDTO> = {}): AgentDTO {
  return {
    id,
    name: id,
    status: 'working',
    repo: '/repo',
    worktree: '/repo/.worktrees/' + id,
    pending: [],
    lastActivity: 0,
    autonomyMode: 'assist',
    effectiveMode: 'assist',
    verificationState: 'unknown',
    availableActions: [],
    ...extra,
  };
}

describe('buildLineageTree', () => {
  test('flat roster (no lineage) → all roots, no children', () => {
    const agents = [agent('a'), agent('b'), agent('c')];
    const tree = buildLineageTree(agents);
    expect(tree).toHaveLength(3);
    expect(tree.every((n) => n.children.length === 0 && !n.orphaned)).toBe(true);
  });

  test('simple parent + 2-branch fan-out → 1 root with 2 sorted-by-branchIndex children', () => {
    const agents = [
      agent('parent'),
      agent('branch-1', { parentId: 'parent', branchIndex: 1, startedAt: 10 }),
      agent('branch-0', { parentId: 'parent', branchIndex: 0, startedAt: 20 }),
    ];
    const tree = buildLineageTree(agents);
    expect(tree).toHaveLength(1);
    expect(tree[0].agent.id).toBe('parent');
    expect(tree[0].children.map((c) => c.agent.id)).toEqual(['branch-0', 'branch-1']);
    expect(tree[0].children.every((c) => !c.orphaned)).toBe(true);
  });

  test('dangling parentId (parent id not in the agents array) → node appears as a root with orphaned: true', () => {
    const agents = [agent('child', { parentId: 'ghost' })];
    const tree = buildLineageTree(agents);
    expect(tree).toHaveLength(1);
    expect(tree[0].agent.id).toBe('child');
    expect(tree[0].orphaned).toBe(true);
    expect(tree[0].children).toHaveLength(0);
  });

  test('multi-level nesting (a branch that is itself a workflow with its own branches) → 3-level tree', () => {
    const agents = [
      agent('root'),
      agent('mid', { parentId: 'root', kind: 'workflow' }),
      agent('leaf-a', { parentId: 'mid', branchIndex: 0 }),
      agent('leaf-b', { parentId: 'mid', branchIndex: 1 }),
    ];
    const tree = buildLineageTree(agents);
    expect(tree).toHaveLength(1);
    expect(tree[0].agent.id).toBe('root');
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].agent.id).toBe('mid');
    expect(tree[0].children[0].children.map((c) => c.agent.id)).toEqual(['leaf-a', 'leaf-b']);
  });
});
