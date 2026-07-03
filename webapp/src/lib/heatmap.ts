/**
 * heatmap.ts — pure helpers for the "Activity & hotspots" heat visualization.
 *
 * Turns the flat, integer file/day matrix from GET /api/heat into the three
 * things the panel actually renders:
 *
 *   1. magma()        — a "cold → hot" colormap (deep indigo → amber), the same
 *                       perceptual ramp scientific heatmaps use.
 *   2. buildHeatTree  — a collapsible FOLDER tree from the flat file list, so the
 *                       panel shows WHERE in the codebase heat concentrates
 *                       (which module is hot), not just a list of files.
 *   3. rankHotAreas   — the ranked "top hot areas" with an honest 0–100 score
 *                       and a trend tag.
 *
 * HONEST BY CONSTRUCTION: every number traces to real receipt data (per-file,
 * per-day touch counts). We do NOT fabricate "complexity" or "coupling" metrics
 * we don't measure. Scores are a normalization of total touches; tags come from
 * the actual per-day trend and the live agent diversity.
 *
 * No React, no fetch, no side effects — trivially unit-testable, mirroring the
 * insights.ts convention.
 */

import type { HeatNode } from './insights';

// ───────────────────────────── magma colormap ─────────────────────────────

/** Seven-stop "magma" ramp: low = deep indigo, high = bright amber. */
const MAGMA: readonly [number, number, number][] = [
  [12, 8, 38], // deep indigo (cold)
  [54, 18, 88], // purple
  [114, 31, 109], // magenta
  [183, 55, 95], // pink-red
  [229, 92, 72], // orange-red
  [248, 148, 65], // orange
  [252, 200, 90], // amber (hot)
];

/** A horizontal CSS gradient across the full magma ramp (cold → hot), for legends. */
export const MAGMA_GRADIENT = `linear-gradient(90deg, ${MAGMA.map(
  (c, i) => `rgb(${c[0]}, ${c[1]}, ${c[2]}) ${Math.round((100 * i) / (MAGMA.length - 1))}%`,
).join(', ')})`;

/** Map an intensity t in [0,1] to an `rgb(...)` string along the magma ramp. */
export function magma(t: number): string {
  const v = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  const scaled = v * (MAGMA.length - 1);
  const i = Math.floor(scaled);
  const f = scaled - i;
  const a = MAGMA[i];
  const b = MAGMA[Math.min(i + 1, MAGMA.length - 1)];
  const r = Math.round(a[0] + (b[0] - a[0]) * f);
  const g = Math.round(a[1] + (b[1] - a[1]) * f);
  const bl = Math.round(a[2] + (b[2] - a[2]) * f);
  return `rgb(${r}, ${g}, ${bl})`;
}

// ───────────────────────────── folder tree ─────────────────────────────

export interface HeatTreeNode {
  /** full path for files; folder path for folders. */
  id: string;
  /** last path segment (display label). */
  name: string;
  type: 'file' | 'folder';
  /** number of ancestor segments (0 = top level). */
  depth: number;
  /** per-day counts aligned to `days`; folders = element-wise sum of descendants. */
  daily: number[];
  /** sum of `daily`. */
  total: number;
  /** distinct agents that touched this file (0 for folders / unknown). */
  agentCount: number;
  children: HeatTreeNode[];
}

export interface HeatTree {
  roots: HeatTreeNode[];
  /** largest single file/day count — files normalize against this. */
  maxFileCell: number;
  /** largest single folder/day sum — folders normalize against this. */
  maxFolderCell: number;
  /** number of files placed in the tree. */
  fileCount: number;
}

/**
 * Build a nested folder tree from the flat per-file heat list. Folder rows carry
 * the element-wise sum of their descendants' daily counts so a collapsed folder
 * still shows aggregate heat. Each level is sorted hottest-first.
 */
export function buildHeatTree(
  nodes: HeatNode[] | null | undefined,
  dayCount: number,
  agentsByFile?: Map<string, number>,
): HeatTree {
  const zeros = (): number[] => new Array(dayCount).fill(0);
  const byPath = new Map<string, HeatTreeNode>(); // every folder, keyed by its path
  const rootMap = new Map<string, HeatTreeNode>(); // top-level nodes (folders + files)
  const fileList: HeatTreeNode[] = [];

  const ensureFolder = (segs: string[]): HeatTreeNode => {
    const fullPath = segs.join('/');
    const existing = byPath.get(fullPath);
    if (existing) return existing;
    const node: HeatTreeNode = {
      id: fullPath,
      name: segs[segs.length - 1],
      type: 'folder',
      depth: segs.length - 1,
      daily: zeros(),
      total: 0,
      agentCount: 0,
      children: [],
    };
    byPath.set(fullPath, node);
    if (segs.length === 1) {
      rootMap.set(fullPath, node);
    } else {
      ensureFolder(segs.slice(0, -1)).children.push(node);
    }
    return node;
  };

  let maxFileCell = 0;
  for (const n of nodes ?? []) {
    const segs = n.id.split(/[\\/]/).filter(Boolean);
    if (segs.length === 0) continue;
    const daily = (n.heat ?? []).slice(0, dayCount);
    while (daily.length < dayCount) daily.push(0);
    const total = daily.reduce((a, b) => a + (b || 0), 0);
    const fileNode: HeatTreeNode = {
      id: n.id,
      name: segs[segs.length - 1],
      type: 'file',
      depth: segs.length - 1,
      daily,
      total,
      agentCount: agentsByFile?.get(n.id) ?? 0,
      children: [],
    };
    for (const v of daily) if (v > maxFileCell) maxFileCell = v;
    fileList.push(fileNode);
    if (segs.length === 1) {
      rootMap.set(n.id, fileNode);
    } else {
      ensureFolder(segs.slice(0, -1)).children.push(fileNode);
    }
  }

  // Roll file dailies up into every ancestor folder.
  for (const f of fileList) {
    const segs = f.id.split(/[\\/]/).filter(Boolean);
    for (let i = 1; i < segs.length; i++) {
      const folder = byPath.get(segs.slice(0, i).join('/'));
      if (!folder) continue;
      for (let d = 0; d < dayCount; d++) folder.daily[d] += f.daily[d] || 0;
    }
  }

  let maxFolderCell = 0;
  for (const folder of byPath.values()) {
    folder.total = folder.daily.reduce((a, b) => a + (b || 0), 0);
    for (const v of folder.daily) if (v > maxFolderCell) maxFolderCell = v;
  }

  const sortRec = (arr: HeatTreeNode[]): void => {
    arr.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    for (const c of arr) if (c.children.length) sortRec(c.children);
  };
  const roots = [...rootMap.values()];
  sortRec(roots);

  return { roots, maxFileCell, maxFolderCell, fileCount: fileList.length };
}

/** Flatten the nested tree into display order, descending only into expanded folders. */
export function flattenTree(roots: HeatTreeNode[], expanded: Set<string>): HeatTreeNode[] {
  const out: HeatTreeNode[] = [];
  const walk = (nodes: HeatTreeNode[]): void => {
    for (const n of nodes) {
      out.push(n);
      if (n.type === 'folder' && n.children.length && expanded.has(n.id)) walk(n.children);
    }
  };
  walk(roots);
  return out;
}

/**
 * A sensible initial expand set: every top-level folder, plus every ancestor of
 * the `topN` hottest files — so the loudest paths are open and cold deep
 * subtrees stay collapsed.
 */
export function initialExpanded(tree: HeatTree, topN = 6): Set<string> {
  const files: HeatTreeNode[] = [];
  const collect = (nodes: HeatTreeNode[]): void => {
    for (const n of nodes) {
      if (n.type === 'file') files.push(n);
      else collect(n.children);
    }
  };
  collect(tree.roots);
  files.sort((a, b) => b.total - a.total);

  const expanded = new Set<string>();
  for (const r of tree.roots) if (r.type === 'folder') expanded.add(r.id);
  for (const f of files.slice(0, topN)) {
    const segs = f.id.split(/[\\/]/).filter(Boolean);
    for (let i = 1; i < segs.length; i++) expanded.add(segs.slice(0, i).join('/'));
  }
  return expanded;
}

// ───────────────────────────── hot-area ranking ─────────────────────────────

export type HotAreaTag = 'CORE HOTSPOT' | 'CONTESTED' | 'GROWING' | 'STEADY';

export interface HotArea {
  rank: number;
  path: string;
  /** 0–100, normalized against the hottest file in the window. */
  score: number;
  /** total touches across the window. */
  total: number;
  /** distinct agents that touched it. */
  agentCount: number;
  daily: number[];
  tag: HotAreaTag;
  /** an honest, data-grounded one-liner. */
  description: string;
}

/** True when the most-recent half of the window carries clearly more heat. */
export function trendRising(daily: number[]): boolean {
  if (daily.length < 2) return false;
  const mid = Math.floor(daily.length / 2);
  const early = daily.slice(0, mid).reduce((a, b) => a + (b || 0), 0);
  const recent = daily.slice(mid).reduce((a, b) => a + (b || 0), 0);
  return recent > 0 && recent > early * 1.25;
}

/**
 * Rank the hottest files and attach an honest score + tag + description. The
 * score is total-touches normalized to the loudest file (0–100). Tags:
 *   CONTESTED   — ≥3 distinct agents (likely wants splitting),
 *   CORE HOTSPOT — top-ranked and clearly dominant,
 *   GROWING     — heat rising across the window,
 *   STEADY      — everything else.
 */
export function rankHotAreas(
  fileNodes: HeatNode[] | null | undefined,
  agentsByFile: Map<string, number> | undefined,
  limit = 5,
): HotArea[] {
  const rows = (fileNodes ?? [])
    .map((n) => {
      const daily = n.heat ?? [];
      return {
        path: n.id,
        daily,
        total: daily.reduce((a, b) => a + (b || 0), 0),
        agentCount: agentsByFile?.get(n.id) ?? 0,
      };
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total || b.agentCount - a.agentCount || a.path.localeCompare(b.path));

  const maxTotal = rows.length ? rows[0].total : 0;

  return rows.slice(0, limit).map((r, i) => {
    const rising = trendRising(r.daily);

    let tag: HotAreaTag;
    if (r.agentCount >= 3) tag = 'CONTESTED';
    else if (i < 2 && maxTotal > 0 && r.total >= maxTotal * 0.6) tag = 'CORE HOTSPOT';
    else if (rising) tag = 'GROWING';
    else tag = 'STEADY';

    let description: string;
    if (r.agentCount >= 3) {
      description = `${r.agentCount} agents touched it — repeated thrash here often means it wants splitting.`;
    } else if (r.agentCount === 2) {
      description = `2 agents touched it${rising ? ' and it’s trending hotter' : ''} — watch for a merge conflict at land.`;
    } else if (rising) {
      description = 'Activity is rising across the window — trending hotter.';
    } else {
      description = `${r.total} touch${r.total === 1 ? '' : 'es'} across the window${i === 0 ? ' — the loudest file right now' : ''}.`;
    }

    return {
      rank: i + 1,
      path: r.path,
      score: maxTotal > 0 ? Math.round((100 * r.total) / maxTotal) : 0,
      total: r.total,
      agentCount: r.agentCount,
      daily: r.daily,
      tag,
      description,
    };
  });
}

/** Build the file → distinct-agent-count map from usage runs' filesTouched. */
export function agentsByFileMap(runs: { agentId: string; filesTouched?: string[] }[] | null | undefined): Map<string, number> {
  const sets = new Map<string, Set<string>>();
  for (const run of runs ?? []) {
    for (const file of run.filesTouched ?? []) {
      if (!file) continue;
      let set = sets.get(file);
      if (!set) sets.set(file, (set = new Set()));
      set.add(run.agentId);
    }
  }
  return new Map([...sets].map(([file, set]) => [file, set.size]));
}
