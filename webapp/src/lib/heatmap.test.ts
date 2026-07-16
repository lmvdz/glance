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
  attachFog,
  coldStartRepos,
  topFogDebt,
  fogLastSeenLabel,
  fogEntryKey,
  nodeFogKey,
  ancestorFolderIds,
  allFilesColdStart,
  type HeatTreeNode,
} from './heatmap';
import type { HeatNode } from './insights';
import type { FogEntryDTO } from './api';

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

// ────────────────────────── buildHeatTree: multi-repo disambiguation ──────────────────────────

describe('buildHeatTree — multi-repo disambiguation (comprehension concern 04)', () => {
  // Helper: recursively collect every folder id in a tree (so tests don't hand-roll expand sets).
  function allFolderIds(nodes: HeatTreeNode[]): string[] {
    const out: string[] = [];
    for (const n of nodes) {
      if (n.type === 'folder') {
        out.push(n.id);
        out.push(...allFolderIds(n.children));
      }
    }
    return out;
  }

  test('same-named files across two repos do NOT collapse into one node', () => {
    const nodes: HeatNode[] = [
      { id: 'src/index.ts', heat: [1, 0], repo: '/home/lars/sui/repo-a' },
      { id: 'src/index.ts', heat: [0, 5], repo: '/home/lars/sui/repo-b' },
    ];
    const tree = buildHeatTree(nodes, 2);
    expect(tree.fileCount).toBe(2);
    // Two distinct file nodes, each retaining its OWN heat — never summed together.
    const flat = flattenTree(tree.roots, new Set(allFolderIds(tree.roots)));
    const files = flat.filter((n) => n.type === 'file');
    expect(files).toHaveLength(2);
    const totals = files.map((f) => f.total).sort();
    expect(totals).toEqual([1, 5]); // NOT [6, 6] or a single collapsed [6]
  });

  test('each repo gets its own SIBLING root — no shared synthetic ancestor folder', () => {
    const nodes: HeatNode[] = [
      { id: 'src/index.ts', heat: [1], repo: '/home/lars/sui/repo-a' },
      { id: 'src/index.ts', heat: [5], repo: '/home/lars/sui/repo-b' },
    ];
    const tree = buildHeatTree(nodes, 1);
    const ids = tree.roots.map((r) => r.id);
    // Both repos share the "/home/lars/sui/" ancestor on disk, but the tree must NOT reflect that —
    // each repo label is one atomic root-level segment (joined with `·`, not `/`).
    expect(ids).toEqual(expect.arrayContaining(['sui·repo-a', 'sui·repo-b']));
    const repoAFolder = tree.roots.find((r) => r.id === 'sui·repo-a')!;
    expect(repoAFolder.children.map((c) => c.id)).toContain('sui·repo-a/src');
    const repoBFolder = tree.roots.find((r) => r.id === 'sui·repo-b')!;
    expect(repoBFolder.children.map((c) => c.id)).toContain('sui·repo-b/src');
  });

  test('single-repo trees are completely unaffected by the repo field (backward compatible)', () => {
    const nodes: HeatNode[] = [
      { id: 'src/a.ts', heat: [1], repo: '/only/one/repo' },
      { id: 'src/b.ts', heat: [2], repo: '/only/one/repo' },
    ];
    const tree = buildHeatTree(nodes, 1);
    const ids = tree.roots.map((r) => r.id);
    expect(ids).toEqual(['src']); // no repo-label prefix — only one distinct repo present
  });

  test('rawPath survives repo-qualification for the fog join', () => {
    const nodes: HeatNode[] = [
      { id: 'src/index.ts', heat: [1], repo: '/home/lars/sui/repo-a' },
      { id: 'src/index.ts', heat: [5], repo: '/home/lars/sui/repo-b' },
    ];
    const tree = buildHeatTree(nodes, 1);
    const flat = flattenTree(tree.roots, new Set(allFolderIds(tree.roots)));
    const files = flat.filter((n) => n.type === 'file');
    expect(files).toHaveLength(2);
    for (const f of files) expect(f.rawPath).toBe('src/index.ts'); // original bare path, never qualified
  });

  test('nodes with no repo field keep the pre-concern-04 unqualified shape', () => {
    const tree = buildHeatTree(NODES, 4); // NODES fixture has no `.repo` at all
    expect(tree.roots.map((r) => r.id)).toContain('src');
  });
});

// ────────────────────────────────── attachFog ──────────────────────────────────

const REPO_A = '/home/lars/sui/repo-a';
const REPO_B = '/home/lars/sui/repo-b';

function fogEntry(overrides: Partial<FogEntryDTO>): FogEntryDTO {
  return {
    repo: REPO_A,
    file: 'src/index.ts',
    changesSinceSeen: 1,
    lastChangedAt: 1000,
    debt: 0.3,
    state: 'stale',
    ...overrides,
  };
}

describe('attachFog', () => {
  test('attaches fog to a matching file node', () => {
    const tree = buildHeatTree([{ id: 'src/index.ts', heat: [1], repo: REPO_A }], 1);
    const decorated = attachFog(tree, [fogEntry({ debt: 0.5, state: 'never-seen' })]);
    const node = decorated.roots.find((r) => r.id === 'src')!.children[0];
    expect(node.fog).toEqual({ debt: 0.5, state: 'never-seen', lastSeenAt: undefined });
  });

  test('leaves fog undefined for a file with no matching entry (honest "no data")', () => {
    const tree = buildHeatTree([{ id: 'src/index.ts', heat: [1], repo: REPO_A }], 1);
    const decorated = attachFog(tree, []);
    const node = decorated.roots.find((r) => r.id === 'src')!.children[0];
    expect(node.fog).toBeUndefined();
  });

  test('joins each repo to its OWN fog entry in a multi-repo tree, never the other repo\'s', () => {
    const tree = buildHeatTree(
      [
        { id: 'src/index.ts', heat: [1], repo: REPO_A },
        { id: 'src/index.ts', heat: [1], repo: REPO_B },
      ],
      1,
    );
    const decorated = attachFog(tree, [
      fogEntry({ repo: REPO_A, debt: 0.9, state: 'stale' }),
      fogEntry({ repo: REPO_B, debt: 0.1, state: 'seen-current' }),
    ]);
    const repoARoot = decorated.roots.find((r) => r.id === 'sui·repo-a')!;
    const repoBRoot = decorated.roots.find((r) => r.id === 'sui·repo-b')!;
    const fileA = repoARoot.children[0].children[0]; // repo/src/index.ts
    const fileB = repoBRoot.children[0].children[0];
    expect(fileA.fog?.debt).toBe(0.9);
    expect(fileA.fog?.state).toBe('stale');
    expect(fileB.fog?.debt).toBe(0.1);
    expect(fileB.fog?.state).toBe('seen-current');
  });

  test('folder fog is the MAX of children debt, not the sum', () => {
    const tree = buildHeatTree(
      [
        { id: 'src/a.ts', heat: [1], repo: REPO_A },
        { id: 'src/b.ts', heat: [1], repo: REPO_A },
      ],
      1,
    );
    const decorated = attachFog(tree, [
      fogEntry({ file: 'src/a.ts', debt: 0.2, state: 'stale' }),
      fogEntry({ file: 'src/b.ts', debt: 0.8, state: 'never-seen' }),
    ]);
    const folder = decorated.roots[0]; // "src"
    expect(folder.fog?.debt).toBe(0.8); // max(0.2, 0.8), not 1.0 (sum)
    expect(folder.fog?.state).toBe('never-seen'); // the whole descriptor of the max-debt child
  });

  test('a folder with no fog-bearing children stays undecorated', () => {
    const tree = buildHeatTree([{ id: 'src/a.ts', heat: [1], repo: REPO_A }], 1);
    const decorated = attachFog(tree, []); // no entries at all
    expect(decorated.roots[0].fog).toBeUndefined();
  });
});

// ────────────────────────────────── coldStartRepos ──────────────────────────────────

describe('coldStartRepos', () => {
  test('collects only repos explicitly flagged false', () => {
    const set = coldStartRepos({ [REPO_A]: true, [REPO_B]: false });
    expect(set.has(REPO_B)).toBe(true);
    expect(set.has(REPO_A)).toBe(false);
  });

  test('empty record yields an empty set', () => {
    expect(coldStartRepos({}).size).toBe(0);
  });

  /** Batch-3 review regression (concern 04 minor): `repoHasHistory`'s key and a tree node's/fog
   *  entry's `repo` field name the same repo but can differ in trivial formatting (a trailing
   *  slash) — `attachFog`'s join already normalizes both sides, so the cold-start membership check
   *  must too, or a node whose `repo` came through un-normalized would silently draw the real fog
   *  ramp where "no view history yet" belonged. */
  test('a trailing-slash repoHasHistory key still normalizes to match the bare repo string', () => {
    const set = coldStartRepos({ [`${REPO_A}/`]: false });
    expect(set.has(REPO_A)).toBe(true); // membership check normalizes the candidate
  });
});

// ────────────────────────────────── topFogDebt ──────────────────────────────────

describe('topFogDebt', () => {
  test('ranks by debt descending', () => {
    const entries = [
      fogEntry({ file: 'a.ts', debt: 0.2 }),
      fogEntry({ file: 'b.ts', debt: 0.9 }),
      fogEntry({ file: 'c.ts', debt: 0.5 }),
    ];
    const top = topFogDebt(entries, {});
    expect(top.map((e) => e.file)).toEqual(['b.ts', 'c.ts', 'a.ts']);
  });

  test('ties on debt break by changesSinceSeen descending', () => {
    const entries = [
      fogEntry({ file: 'a.ts', debt: 0.5, changesSinceSeen: 2 }),
      fogEntry({ file: 'b.ts', debt: 0.5, changesSinceSeen: 9 }),
    ];
    const top = topFogDebt(entries, {});
    expect(top[0].file).toBe('b.ts');
  });

  test('excludes cold-start repos even when their debt is high', () => {
    const entries = [fogEntry({ repo: REPO_A, file: 'a.ts', debt: 0.99 }), fogEntry({ repo: REPO_B, file: 'b.ts', debt: 0.1 })];
    const top = topFogDebt(entries, { [REPO_A]: false, [REPO_B]: true });
    expect(top.map((e) => e.file)).toEqual(['b.ts']);
  });

  test('slices to n', () => {
    const entries = Array.from({ length: 15 }, (_, i) => fogEntry({ file: `f${i}.ts`, debt: i / 15 }));
    expect(topFogDebt(entries, {}, 10)).toHaveLength(10);
    expect(topFogDebt(entries, {})).toHaveLength(10); // default n=10
  });

  /** Batch-3 review regression (concern 04 minor): a cold-start repo whose `repoHasHistory` key
   *  carries a trailing slash the entry's own `repo` field lacks (or vice versa) must still be
   *  excluded — `attachFog` would join these as the same repo, so the shortlist must agree. */
  test('excludes a cold-start repo even when its repoHasHistory key has a trailing slash the entry lacks', () => {
    const entries = [fogEntry({ repo: REPO_A, file: 'a.ts', debt: 0.99 }), fogEntry({ repo: REPO_B, file: 'b.ts', debt: 0.1 })];
    const top = topFogDebt(entries, { [`${REPO_A}/`]: false, [REPO_B]: true });
    expect(top.map((e) => e.file)).toEqual(['b.ts']);
  });
});

// ────────────────────────────────── fogLastSeenLabel ──────────────────────────────────

describe('fogLastSeenLabel', () => {
  const now = 1_000_000_000;
  test('undefined lastSeenAt reads as "never"', () => {
    expect(fogLastSeenLabel(undefined, now)).toBe('never');
  });
  test('under a minute reads as "just now"', () => {
    expect(fogLastSeenLabel(now - 10_000, now)).toBe('just now');
  });
  test('minutes/hours/days format correctly', () => {
    expect(fogLastSeenLabel(now - 5 * 60_000, now)).toBe('5m ago');
    expect(fogLastSeenLabel(now - 3 * 60 * 60_000, now)).toBe('3h ago');
    expect(fogLastSeenLabel(now - 2 * 24 * 60 * 60_000, now)).toBe('2d ago');
  });
});

// ─────────────────────────── fogEntryKey / nodeFogKey round-trip ───────────────────────────

describe('fogEntryKey / nodeFogKey', () => {
  test('a tree node\'s key agrees with its source fog entry\'s key', () => {
    const tree = buildHeatTree([{ id: 'src/index.ts', heat: [1], repo: REPO_A }], 1);
    const node = tree.roots[0].children[0];
    expect(nodeFogKey(node)).toBe(fogEntryKey(REPO_A, 'src/index.ts'));
  });

  test('undefined for a node with no repo', () => {
    const tree = buildHeatTree(NODES, 4);
    const node = tree.roots.find((r) => r.type === 'file')!;
    expect(nodeFogKey(node)).toBeUndefined();
  });
});

// ────────────────────────────────── ancestorFolderIds ──────────────────────────────────

describe('ancestorFolderIds', () => {
  test('returns every ancestor, root-most first, excluding the node itself', () => {
    expect(ancestorFolderIds('src/engine/context.ts')).toEqual(['src', 'src/engine']);
  });
  test('empty for a top-level file', () => {
    expect(ancestorFolderIds('README.md')).toEqual([]);
  });
  test('works for a repo-qualified multi-repo id', () => {
    expect(ancestorFolderIds('sui·repo-a/src/index.ts')).toEqual(['sui·repo-a', 'sui·repo-a/src']);
  });
});

// ────────────────────────────────── allFilesColdStart ──────────────────────────────────

describe('allFilesColdStart', () => {
  test('true when every file belongs to a cold-start repo', () => {
    const tree = buildHeatTree([{ id: 'src/a.ts', heat: [1], repo: REPO_A }], 1);
    expect(allFilesColdStart(tree, new Set([REPO_A]))).toBe(true);
  });

  test('false when at least one file is NOT cold-start', () => {
    const tree = buildHeatTree(
      [
        { id: 'src/a.ts', heat: [1], repo: REPO_A },
        { id: 'src/b.ts', heat: [1], repo: REPO_B },
      ],
      1,
    );
    expect(allFilesColdStart(tree, new Set([REPO_A]))).toBe(false); // repo B has real history
  });

  test('false for an empty tree (nothing to gate)', () => {
    expect(allFilesColdStart(buildHeatTree([], 1), new Set([REPO_A]))).toBe(false);
  });

  test('false for a file with no repo field at all', () => {
    const tree = buildHeatTree(NODES, 4);
    expect(allFilesColdStart(tree, new Set())).toBe(false);
  });

  /** Batch-3 review regression (concern 04 minor): the `coldStart` set is normalized-key
   *  (`coldStartRepos`'s doc), but a tree node's raw `repo` field (copied straight from the source
   *  `/api/heat` node) can carry a trailing slash the set's key lacks or vice versa — the
   *  membership check must normalize the node's `repo` before testing, or a genuinely cold-start
   *  repo would read as "has real history" purely from formatting noise. */
  test('a node whose raw repo has a trailing slash still matches a bare cold-start set entry', () => {
    const tree = buildHeatTree([{ id: 'src/a.ts', heat: [1], repo: `${REPO_A}/` }], 1);
    expect(allFilesColdStart(tree, coldStartRepos({ [REPO_A]: false }))).toBe(true);
  });
});
