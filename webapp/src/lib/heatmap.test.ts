/**
 * heatmap.test.ts — the pure heat-graph logic: magma colormap, folder-tree
 * construction/flattening, and honest hot-area ranking. DOM-free (bun:test).
 */

import { expect, test, describe } from 'bun:test';
import {
  magma,
  MAGMA_GRADIENT,
  buildHeatTree,
  flattenTree,
  initialExpanded,
  rankHotAreas,
  trendRising,
  agentsByFileMap,
} from './heatmap';
import type { HeatNode } from './insights';

// ────────────────────────────────── magma ──────────────────────────────────

describe('magma', () => {
  test('cold end is deep indigo, hot end is amber', () => {
    expect(magma(0)).toBe('rgb(12, 8, 38)');
    expect(magma(1)).toBe('rgb(252, 200, 90)');
  });

  test('clamps out-of-range and non-finite input', () => {
    expect(magma(-5)).toBe('rgb(12, 8, 38)');
    expect(magma(99)).toBe('rgb(252, 200, 90)');
    expect(magma(Number.NaN)).toBe('rgb(12, 8, 38)');
  });

  test('interpolates between stops', () => {
    // midpoint should be a blended value, not equal to either endpoint
    const mid = magma(0.5);
    expect(mid).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    expect(mid).not.toBe(magma(0));
    expect(mid).not.toBe(magma(1));
  });

  test('gradient string spans the full ramp', () => {
    expect(MAGMA_GRADIENT).toContain('rgb(12, 8, 38) 0%');
    expect(MAGMA_GRADIENT).toContain('rgb(252, 200, 90) 100%');
  });
});

// ────────────────────────────── buildHeatTree ──────────────────────────────

const NODES: HeatNode[] = [
  { id: 'src/engine/context.ts', heat: [0, 1, 4, 5] },
  { id: 'src/engine/executor.ts', heat: [1, 2, 3, 2] },
  { id: 'src/db/schema.ts', heat: [0, 0, 1, 0] },
  { id: 'README.md', heat: [1, 0, 0, 0] },
];

describe('buildHeatTree', () => {
  test('creates folders for nested files and a top-level file', () => {
    const tree = buildHeatTree(NODES, 4);
    expect(tree.fileCount).toBe(4);
    const ids = tree.roots.map((r) => r.id);
    expect(ids).toContain('src');
    expect(ids).toContain('README.md'); // top-level file is a root
  });

  test('folder daily counts are the element-wise sum of descendants', () => {
    const tree = buildHeatTree(NODES, 4);
    const src = tree.roots.find((r) => r.id === 'src')!;
    // src = context + executor + schema, summed per day
    expect(src.daily).toEqual([1, 3, 8, 7]);
    expect(src.total).toBe(19);
    const engine = src.children.find((c) => c.id === 'src/engine')!;
    expect(engine.daily).toEqual([1, 3, 7, 7]);
  });

  test('sorts each level hottest-first', () => {
    const tree = buildHeatTree(NODES, 4);
    const src = tree.roots.find((r) => r.id === 'src')!;
    // engine (total 17+...) is hotter than db
    expect(src.children[0].id).toBe('src/engine');
    const engine = src.children[0];
    // context.ts (total 10) hotter than executor.ts (total 8)
    expect(engine.children[0].id).toBe('src/engine/context.ts');
  });

  test('reports per-type cell maxima', () => {
    const tree = buildHeatTree(NODES, 4);
    expect(tree.maxFileCell).toBe(5); // context.ts day 4
    expect(tree.maxFolderCell).toBe(8); // src day 3
  });

  test('attaches agentCount from the supplied map', () => {
    const tree = buildHeatTree(NODES, 4, new Map([['src/engine/context.ts', 3]]));
    const ctx = tree.roots
      .find((r) => r.id === 'src')!
      .children.find((c) => c.id === 'src/engine')!
      .children.find((c) => c.id === 'src/engine/context.ts')!;
    expect(ctx.agentCount).toBe(3);
  });

  test('pads short heat arrays to dayCount', () => {
    const tree = buildHeatTree([{ id: 'a.ts', heat: [2] }], 4);
    expect(tree.roots[0].daily).toEqual([2, 0, 0, 0]);
  });

  test('handles empty / null input', () => {
    expect(buildHeatTree(null, 4).roots).toEqual([]);
    expect(buildHeatTree([], 4).fileCount).toBe(0);
  });
});

// ────────────────────────────── flattenTree ──────────────────────────────

describe('flattenTree', () => {
  test('descends only into expanded folders', () => {
    const tree = buildHeatTree(NODES, 4);
    const collapsed = flattenTree(tree.roots, new Set());
    // only top-level rows: src, db? no — db is under src. roots are src + README.md
    expect(collapsed.map((n) => n.id).sort()).toEqual(['README.md', 'src']);

    const expanded = flattenTree(tree.roots, new Set(['src', 'src/engine', 'src/db']));
    const ids = expanded.map((n) => n.id);
    expect(ids).toContain('src/engine/context.ts');
    expect(ids).toContain('src/db/schema.ts');
  });
});

// ────────────────────────────── initialExpanded ──────────────────────────────

describe('initialExpanded', () => {
  test('expands top-level folders and ancestors of the hottest files', () => {
    const tree = buildHeatTree(NODES, 4);
    const exp = initialExpanded(tree, 1); // only the single hottest file's ancestors
    expect(exp.has('src')).toBe(true); // top-level folder always
    expect(exp.has('src/engine')).toBe(true); // ancestor of context.ts (hottest)
    expect(exp.has('src/db')).toBe(false); // schema.ts is not in the top-1
  });
});

// ────────────────────────────── trendRising ──────────────────────────────

describe('trendRising', () => {
  test('true when the recent half clearly exceeds the early half', () => {
    expect(trendRising([0, 0, 3, 4])).toBe(true);
  });
  test('false for flat or declining series', () => {
    expect(trendRising([4, 4, 4, 4])).toBe(false);
    expect(trendRising([5, 4, 1, 0])).toBe(false);
  });
  test('false for too-short series', () => {
    expect(trendRising([9])).toBe(false);
  });
});

// ────────────────────────────── rankHotAreas ──────────────────────────────

describe('rankHotAreas', () => {
  test('ranks by total touches and scores 0–100 against the loudest', () => {
    const areas = rankHotAreas(NODES, undefined, 5);
    expect(areas[0].path).toBe('src/engine/context.ts'); // total 10
    expect(areas[0].score).toBe(100);
    expect(areas[1].path).toBe('src/engine/executor.ts'); // total 8
    expect(areas[1].score).toBe(80);
  });

  test('flags ≥3 distinct agents as CONTESTED', () => {
    const areas = rankHotAreas(NODES, new Map([['src/engine/context.ts', 3]]), 5);
    const ctx = areas.find((a) => a.path === 'src/engine/context.ts')!;
    expect(ctx.tag).toBe('CONTESTED');
    expect(ctx.description).toContain('3 agents');
  });

  test('tags the dominant top file CORE HOTSPOT', () => {
    const areas = rankHotAreas(NODES, undefined, 5);
    expect(areas[0].tag).toBe('CORE HOTSPOT');
  });

  test('drops zero-heat files and respects the limit', () => {
    const withCold: HeatNode[] = [...NODES, { id: 'cold.ts', heat: [0, 0, 0, 0] }];
    const areas = rankHotAreas(withCold, undefined, 2);
    expect(areas).toHaveLength(2);
    expect(areas.some((a) => a.path === 'cold.ts')).toBe(false);
  });

  test('empty for null input', () => {
    expect(rankHotAreas(null, undefined)).toEqual([]);
  });
});

// ────────────────────────────── agentsByFileMap ──────────────────────────────

describe('agentsByFileMap', () => {
  test('counts DISTINCT agents per file across runs', () => {
    const map = agentsByFileMap([
      { agentId: 'a1', filesTouched: ['x.ts', 'y.ts'] },
      { agentId: 'a2', filesTouched: ['x.ts'] },
      { agentId: 'a1', filesTouched: ['x.ts'] }, // same agent again → still 2 on x.ts
    ]);
    expect(map.get('x.ts')).toBe(2);
    expect(map.get('y.ts')).toBe(1);
  });

  test('handles null / missing filesTouched', () => {
    expect(agentsByFileMap(null).size).toBe(0);
    expect(agentsByFileMap([{ agentId: 'a1' }]).size).toBe(0);
  });
});
