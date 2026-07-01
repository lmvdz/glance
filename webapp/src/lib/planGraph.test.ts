/**
 * planGraph.test.ts — the plan dependency-DAG builder. DOM-free (bun:test).
 */

import { expect, test, describe } from 'bun:test';
import { concernNum, parseDependencyTable, buildPlanGraph, type GraphConcernInput } from './planGraph';

const OVERVIEW = `# Plan
## Dependency graph
| Concern | BLOCKED_BY | VERIFY_BLOCKER |
|---|---|---|
| 01 | none | x |
| 02 | 01 | y |
| 03 | 01, 02 | z |
| 04 | 03 | w |

## Batch order
1. Batch 1: Concern 01.
`;

function c(file: string, title: string, extra: Partial<GraphConcernInput> = {}): GraphConcernInput {
  return { file, title, status: 'open', open: true, prerequisites: [], touches: [], ...extra };
}

const CONCERNS: GraphConcernInput[] = [
  c('00-overview.md', 'Overview', { status: 'closed', open: false }),
  c('01-manifest.md', 'Manifest', { complexity: 'architectural', status: 'done', open: false }),
  c('02-persistence.md', 'Persistence'),
  c('03-install.md', 'Install controller'),
  c('04-runtime.md', 'Runtime adapters'),
];

describe('concernNum', () => {
  test('extracts the leading number', () => {
    expect(concernNum('03-install.md')).toBe(3);
    expect(concernNum('plans/x/12-foo.md')).toBe(12);
    expect(concernNum('DESIGN.md')).toBeNull();
  });
});

describe('parseDependencyTable', () => {
  test('maps concern → blockers, treating none as empty', () => {
    const t = parseDependencyTable(OVERVIEW);
    expect(t.get(1)).toEqual([]);
    expect(t.get(2)).toEqual([1]);
    expect(t.get(3)).toEqual([1, 2]);
    expect(t.get(4)).toEqual([3]);
  });
  test('empty when no table present', () => {
    expect(parseDependencyTable('# Plan\nno table here').size).toBe(0);
  });
});

describe('buildPlanGraph', () => {
  test('excludes the overview doc from nodes', () => {
    const g = buildPlanGraph(CONCERNS, OVERVIEW);
    expect(g.nodes.map((n) => n.id)).not.toContain('00-overview.md');
    expect(g.nodes).toHaveLength(4);
  });

  test('builds edges from the overview dependency table (prereq → dependent)', () => {
    const g = buildPlanGraph(CONCERNS, OVERVIEW);
    const has = (from: string, to: string) => g.edges.some((e) => e.from === from && e.to === to);
    expect(has('01-manifest.md', '02-persistence.md')).toBe(true);
    expect(has('01-manifest.md', '03-install.md')).toBe(true);
    expect(has('02-persistence.md', '03-install.md')).toBe(true);
    expect(has('03-install.md', '04-runtime.md')).toBe(true);
  });

  test('layers by longest path: 01→0, 02→1, 03→2, 04→3', () => {
    const g = buildPlanGraph(CONCERNS, OVERVIEW);
    const col = (id: string) => g.nodes.find((n) => n.id === id)!.col;
    expect(col('01-manifest.md')).toBe(0);
    expect(col('02-persistence.md')).toBe(1);
    expect(col('03-install.md')).toBe(2);
    expect(col('04-runtime.md')).toBe(3);
    expect(g.cols).toBe(4);
  });

  test('carries status/complexity onto nodes', () => {
    const g = buildPlanGraph(CONCERNS, OVERVIEW);
    const manifest = g.nodes.find((n) => n.id === '01-manifest.md')!;
    expect(manifest.open).toBe(false);
    expect(manifest.complexity).toBe('architectural');
  });

  test('falls back to per-concern prerequisites when no overview table', () => {
    const concerns = [
      c('01-a.md', 'A'),
      c('02-b.md', 'B', { prerequisites: ['Blocked by concern 01'] }),
    ];
    const g = buildPlanGraph(concerns, '');
    expect(g.edges).toEqual([{ from: '01-a.md', to: '02-b.md' }]);
    expect(g.nodes.find((n) => n.id === '02-b.md')!.col).toBe(1);
  });

  test('does not fallback when overview row explicitly says no blockers', () => {
    const ov = `## Dependency graph\n| Concern | BLOCKED_BY |\n|---|---|\n| 02 | none |\n`;
    const concerns = [
      c('01-a.md', 'A'),
      c('02-b.md', 'B', { prerequisites: ['Blocked by concern 01'] }),
    ];
    expect(buildPlanGraph(concerns, ov).edges).toEqual([]);
  });

  test('no edges → every node at column 0', () => {
    const g = buildPlanGraph([c('01-a.md', 'A'), c('02-b.md', 'B')], '');
    expect(g.nodes.every((n) => n.col === 0)).toBe(true);
    expect(g.cols).toBe(1);
  });

  test('reports dependency cycles without infinite-looping', () => {
    const ov = `## Dependency graph\n| Concern | BLOCKED_BY |\n|---|---|\n| 01 | 02 |\n| 02 | 01 |\n`;
    const g = buildPlanGraph([c('01-a.md', 'A'), c('02-b.md', 'B')], ov);
    expect(g.nodes).toHaveLength(2);
    expect(g.issues).toContainEqual({
      kind: 'cycle',
      message: 'Dependency cycle: 1 → 2 → 1.',
      refs: [1, 2],
      files: ['01-a.md', '02-b.md'],
    });
  });

  test('reports unresolved blocker references', () => {
    const ov = `## Dependency graph\n| Concern | BLOCKED_BY |\n|---|---|\n| 01 | 99 |\n`;
    const g = buildPlanGraph([c('01-a.md', 'A')], ov);
    expect(g.edges).toEqual([]);
    expect(g.issues).toEqual([{
      kind: 'unresolved',
      message: 'Concern 1 depends on missing concern 99.',
      refs: [99],
      files: ['01-a.md'],
    }]);
  });
});
