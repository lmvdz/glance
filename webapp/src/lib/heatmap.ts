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
import type { FogEntryDTO, FogState } from './api';

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

/** Comprehension-fog overlay data for one tree node (concern 04). Attached by `attachFog`, never
 *  computed inline by the renderer — `debt`/`state` are `FileFogEntry`'s own fields (see
 *  `src/comprehension-fog.ts`), copied verbatim; folders get the MAX-debt child's own descriptor
 *  (see `attachFog`'s doc for why max, not sum). */
export interface NodeFog {
  debt: number;
  state: FogState;
  lastSeenAt?: number;
}

export interface HeatTreeNode {
  /** full path for files; folder path for folders. Repo-qualified (see `buildHeatTree`'s
   *  `repoLabel` doc) ONLY when the input spans more than one repo — the common single-repo
   *  response leaves this exactly as before. */
  id: string;
  /** last path segment (display label) — never repo-qualified, even when `id` is. */
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
  /** raw (unnormalized) owning repo — present whenever the source `HeatNode` carried one; every
   *  descendant of a given branch shares its repo (see `buildHeatTree`). Absent means "unknown"
   *  (an older/mocked payload with no `repo` field), never "no repo." */
  repo?: string;
  /** the ORIGINAL, never-repo-qualified file path from the source `HeatNode.id` — files only.
   *  `id` gets a `repoLabel(repo)/` prefix under a multi-repo tree (see `buildHeatTree`), which
   *  would make reconstructing the bare path from `id` alone fragile (a real path segment could
   *  coincidentally match the prefix). `attachFog`'s join always uses THIS field, never `id`. */
  rawPath?: string;
  /** comprehension-fog overlay (concern 04) — absent until `attachFog` runs, and absent per-node
   *  even after that when no fog entry matched (honest "no data," not "zero debt"). */
  fog?: NodeFog;
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

/** Short, human-legible, ATOMIC disambiguator for a repo path — its last two path segments joined
 *  by `·` (middle dot), deliberately NOT `/`. Two repos can share a common ancestor directory
 *  (`/home/lars/sui/repo-a` and `/home/lars/sui/repo-b` both live under `.../sui/`) — joining with a
 *  real slash would make THAT shared ancestor a synthetic parent folder in the tree, which doesn't
 *  merge any file/folder's COUNTS (still a distinct join key) but does add a meaningless nesting
 *  level and, worse, would make two repos that share nothing but a folder NAME 3+ levels up
 *  collapse into visually-adjacent tree branches. `·` is never matched by the `/[\\/]/` segment
 *  splitter `buildHeatTree` uses everywhere, so this always lands as ONE atomic top-level segment —
 *  every distinct repo gets its own sibling root, never a shared ancestor.
 *  `"/home/lars/sui/omp-squad"` → `"sui·omp-squad"`. Falls back to the normalized whole string for
 *  a bare name with no separators. */
function repoLabel(repo: string): string {
  const norm = repo.replace(/\\/g, '/').replace(/\/+$/, '');
  const segs = norm.split('/').filter(Boolean);
  return segs.length ? segs.slice(-2).join('·') : norm || 'repo';
}

/**
 * Build a nested folder tree from the flat per-file heat list. Folder rows carry
 * the element-wise sum of their descendants' daily counts so a collapsed folder
 * still shows aggregate heat. Each level is sorted hottest-first.
 *
 * Multi-repo disambiguation (comprehension concern 04, heatPayload fix): when the input spans MORE
 * THAN ONE repo (an unfiltered fleet-wide `/api/heat` read, or a bootstrap-admin's cross-org
 * break-glass view — see `observability-bootstrap-admin.test.ts`), two repos can share an identical
 * relative path — both might have "src/index.ts", or just a top-level "src/" folder — and treating
 * `n.id` alone as this function's join key would silently MERGE those folders' touch counts, the
 * exact cross-repo collapse bug class `heatPayload`'s server-side fix addresses. When (and ONLY
 * when) more than one distinct `repo` is present, every node's effective path is prefixed with
 * `repoLabel(n.repo)` so each repo gets its own top-level branch — `id`/`depth` for BOTH files and
 * folders reflect the qualified path in that case, so ancestor-chain logic elsewhere (`flattenTree`,
 * `initialExpanded`, HeatTree's click-to-focus) stays internally consistent. Single-repo responses
 * (the overwhelmingly common case, and every existing caller/test) are completely unaffected: `id`
 * matches today's shape exactly, because `repoLabel` is never consulted.
 */
export function buildHeatTree(
  nodes: HeatNode[] | null | undefined,
  dayCount: number,
  agentsByFile?: Map<string, number>,
): HeatTree {
  const zeros = (): number[] => new Array(dayCount).fill(0);
  const byPath = new Map<string, HeatTreeNode>(); // every folder, keyed by its (possibly repo-qualified) path
  const rootMap = new Map<string, HeatTreeNode>(); // top-level nodes (folders + files)
  const fileList: HeatTreeNode[] = [];

  const distinctRepos = new Set<string>();
  for (const n of nodes ?? []) if (n.repo) distinctRepos.add(n.repo);
  const multiRepo = distinctRepos.size > 1;
  const effectivePath = (n: HeatNode): string => (multiRepo && n.repo ? `${repoLabel(n.repo)}/${n.id}` : n.id);

  const ensureFolder = (segs: string[], repo: string | undefined): HeatTreeNode => {
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
      repo,
    };
    byPath.set(fullPath, node);
    if (segs.length === 1) {
      rootMap.set(fullPath, node);
    } else {
      ensureFolder(segs.slice(0, -1), repo).children.push(node);
    }
    return node;
  };

  let maxFileCell = 0;
  for (const n of nodes ?? []) {
    const qualified = effectivePath(n);
    const segs = qualified.split(/[\\/]/).filter(Boolean);
    if (segs.length === 0) continue;
    const daily = (n.heat ?? []).slice(0, dayCount);
    while (daily.length < dayCount) daily.push(0);
    const total = daily.reduce((a, b) => a + (b || 0), 0);
    const fileNode: HeatTreeNode = {
      id: qualified,
      name: segs[segs.length - 1],
      type: 'file',
      depth: segs.length - 1,
      daily,
      total,
      // `agentsByFile` is keyed by the RAW (bare, un-qualified) file path from /api/usage's
      // filesTouched — always look it up by `n.id`, never the repo-qualified tree id.
      agentCount: agentsByFile?.get(n.id) ?? 0,
      children: [],
      repo: n.repo,
      rawPath: n.id,
    };
    for (const v of daily) if (v > maxFileCell) maxFileCell = v;
    fileList.push(fileNode);
    if (segs.length === 1) {
      rootMap.set(qualified, fileNode);
    } else {
      ensureFolder(segs.slice(0, -1), n.repo).children.push(fileNode);
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

// ───────────────────────────── comprehension fog (concern 04) ─────────────────────────────
//
// Every decision here — the join key, folder aggregation, cold-start gating, shortlist ranking —
// is a pure function so HeatTree.tsx stays a renderer: it fetches `/api/fog`, calls these, and
// draws whatever they return. Nothing here touches the DOM, React state, or `fetch`.

/** Lightweight client-side echo of `src/project-registry.ts`'s `normalizeRepoPath` — just enough to
 *  join two repo strings that name the same repo but differ in trivial formatting (a trailing
 *  slash, a backslash vs forward slash). Deliberately NOT a full port: tilde-expansion needs
 *  `os.homedir()` (server-only, meaningless in a browser), and this never resolves a real
 *  filesystem path — it only compares two strings the daemon already normalized before either
 *  reached the client.
 *
 *  Exported (batch-3 review, concern 04 minor): `attachFog`'s join below always normalizes both
 *  sides through this, but `coldStartRepos`/`topFogDebt`/`allFilesColdStart` and HeatTree.tsx's
 *  `fogVisual` used to test membership against RAW repo strings — a `repoHasHistory` key and a
 *  tree node's `repo` field naming the same repo with a trivial formatting difference (a trailing
 *  slash) would join fine in `attachFog` but fail every cold-start membership check, silently
 *  drawing that repo's real fog ramp where "no view history yet" was meant to render (or vice
 *  versa). Every membership check below now normalizes on both sides. */
export function normalizeRepoKey(repo: string): string {
  return repo.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

/** `${repo}\0${file}` — the SAME join convention `src/comprehension-fog.ts`'s `fogKey` and
 *  `src/attention.ts`'s `seenKey` use server-side (mirrored client-side in `attention.ts`'s
 *  `diffViewedKey`/`seenKey` doc). No real path can contain `\0`, so two distinct (repo,file) pairs
 *  can never collide into one key. */
function fogKey(repo: string, file: string): string {
  return `${normalizeRepoKey(repo)}\0${file}`;
}

/**
 * Join comprehension-fog entries onto a heat tree, attaching `HeatTreeNode.fog` where a match
 * exists. A file node's `repo`/`id` (its bare, un-qualified file path — see `buildHeatTree`'s
 * `agentsByFile` lookup note for why `id` alone isn't safe under multi-repo trees, but the ORIGINAL
 * per-node `repo` field always is) is joined against `fogEntries` by `fogKey`; nodes with no
 * matching entry are left with `fog: undefined` (honest "no data," e.g. a repo `/api/heat` can see
 * that `/api/fog` didn't scope in) rather than a fabricated zero-debt state.
 *
 * Folder aggregation is the MAX of children's fog debt, NOT the sum: DESIGN.md's "Fog UI" row
 * treats a full-tree red wall as training "toggle is noise," and summing would make a folder of
 * many small never-touched files outrank one heavily-churned file just by having more children — the
 * opposite of an actionable signal. The folder's `state`/`lastSeenAt` come from whichever child
 * achieved that max (the first one encountered wins ties, which is deterministic given `buildHeatTree`
 * always returns children in the same sorted order) — this keeps a folder's overlay internally
 * consistent with a REAL file's fog descriptor, instead of inventing a blended state no file has.
 */
export function attachFog(tree: HeatTree, fogEntries: FogEntryDTO[]): HeatTree {
  const byKey = new Map<string, FogEntryDTO>();
  for (const e of fogEntries) byKey.set(fogKey(e.repo, e.file), e);

  const decorate = (node: HeatTreeNode): HeatTreeNode => {
    if (node.type === 'file') {
      const bare = node.rawPath ?? node.id; // rawPath survives repo-qualification; see its own doc
      const match = node.repo !== undefined ? byKey.get(fogKey(node.repo, bare)) : undefined;
      if (!match) return node;
      return { ...node, fog: { debt: match.debt, state: match.state, lastSeenAt: match.lastSeenAt } };
    }
    const children = node.children.map(decorate);
    let best: NodeFog | undefined;
    for (const c of children) {
      if (c.fog && (!best || c.fog.debt > best.debt)) best = c.fog;
    }
    return best ? { ...node, children, fog: best } : { ...node, children };
  };

  return { ...tree, roots: tree.roots.map(decorate) };
}

/** The set of repos `/api/fog` reports as NOT having enough recorded view history yet
 *  (`repoHasHistory[repo] === false`) — DESIGN.md's "cold-start red wall" (RT2-12): a repo an
 *  operator just started using shows every file `never-seen` (nobody has looked at ANYTHING yet),
 *  which reads as an alarming full-red/hatched wall rather than a debt signal worth acting on. The
 *  renderer uses this to swap that repo's overlay for the "no view history yet" empty state instead
 *  of hatching everything — never by hiding real per-file `fog` data (still attached; only the
 *  render decision changes). Repos absent from `repoHasHistory` (not in the actor-visible scope) are
 *  NOT treated as cold-start here — `Object.entries` only sees repos the endpoint actually reported.
 *
 *  Returned keys are `normalizeRepoKey`-normalized (batch-3 review, concern 04 minor) — every
 *  caller MUST normalize whatever repo string it tests for membership (`.has(normalizeRepoKey(x))`),
 *  never a raw tree-node/entry `.repo` directly, or a trivial formatting difference (trailing
 *  slash, `\` vs `/`) silently defeats the membership check even though `attachFog`'s own join
 *  already normalizes both sides. */
export function coldStartRepos(repoHasHistory: Record<string, boolean>): Set<string> {
  return new Set(
    Object.entries(repoHasHistory)
      .filter(([, has]) => !has)
      .map(([repo]) => normalizeRepoKey(repo)),
  );
}

/**
 * Top-N debt shortlist (DESIGN.md "Fog UI" row: "an actionable shortlist is the contract"), mirroring
 * `src/comprehension-fog.ts`'s server-side `topDebt` ranking exactly (debt desc, `changesSinceSeen`
 * desc, then repo/file lexical) so the client's headline list would agree with the server's if the
 * server ever exposed one directly. Cold-start repos (see `coldStartRepos`) are excluded — their
 * debt numbers aren't wrong, but a day-1 repo where EVERY file is technically `never-seen` would
 * drown out genuinely actionable debt from repos with real viewing history.
 */
export function topFogDebt(entries: FogEntryDTO[], repoHasHistory: Record<string, boolean>, n = 10): FogEntryDTO[] {
  const coldStart = coldStartRepos(repoHasHistory);
  return entries
    .filter((e) => !coldStart.has(normalizeRepoKey(e.repo)))
    .sort(
      (a, b) =>
        b.debt - a.debt ||
        b.changesSinceSeen - a.changesSinceSeen ||
        normalizeRepoKey(a.repo).localeCompare(normalizeRepoKey(b.repo)) ||
        a.file.localeCompare(b.file),
    )
    .slice(0, n);
}

/** "3h ago" / "2d ago" / "just now" / "never" — locale-free (matches `fmtDay`'s convention in
 *  HeatTree.tsx), for the shortlist's "last seen X ago / never" column. */
export function fogLastSeenLabel(lastSeenAt: number | undefined, now: number): string {
  if (lastSeenAt === undefined) return 'never';
  const ms = Math.max(0, now - lastSeenAt);
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  if (ms < MIN) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / MIN)}m ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
  return `${Math.floor(ms / DAY)}d ago`;
}

/** The `${repo}\0${file}` join key for a fog entry — exported so HeatTree.tsx can build its own
 *  id → shortlist-entry lookup for "click focuses tree node" without re-deriving the convention. */
export function fogEntryKey(repo: string, file: string): string {
  return fogKey(repo, file);
}

/** The SAME join key, derived from a tree node instead of a raw fog entry — so HeatTree.tsx can map
 *  a shortlist row (keyed by `fogEntryKey`) back to the tree node id to focus. Uses `rawPath` (see
 *  its doc on `HeatTreeNode`), never `id`, so this agrees with `attachFog`'s own join exactly. */
export function nodeFogKey(node: HeatTreeNode): string | undefined {
  if (node.repo === undefined) return undefined;
  return fogKey(node.repo, node.rawPath ?? node.id);
}

/** Every ancestor folder id of a (possibly repo-qualified) tree node id, root-most first — e.g.
 *  `"src/engine/context.ts"` → `["src", "src/engine"]`. Shared logic behind `initialExpanded`'s
 *  ancestor-walk and the shortlist's "click focuses tree node" (HeatTree.tsx expands every entry
 *  this returns, then selects the node itself). */
export function ancestorFolderIds(id: string): string[] {
  const segs = id.split('/').filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i < segs.length; i++) out.push(segs.slice(0, i).join('/'));
  return out;
}

/**
 * True when EVERY file node in the tree belongs to a cold-start repo (see `coldStartRepos`) — the
 * common single-repo case where the operator just started using this repo and no fog signal
 * anywhere in the tree is trustworthy yet (DESIGN.md's "cold-start red wall," RT2-12). The renderer
 * uses this to show the whole-panel "no view history yet" empty state instead of a tri-state grid
 * that would otherwise be indistinguishable from a genuinely alarming all-`never-seen` wall. `false`
 * for an empty tree or a tree with no fog-eligible files at all (nothing to gate, nothing to hide).
 */
export function allFilesColdStart(tree: HeatTree, coldStart: Set<string>): boolean {
  let sawFile = false;
  const walk = (nodes: HeatTreeNode[]): boolean => {
    for (const n of nodes) {
      if (n.type === 'file') {
        sawFile = true;
        if (!n.repo || !coldStart.has(normalizeRepoKey(n.repo))) return false;
      } else if (!walk(n.children)) {
        return false;
      }
    }
    return true;
  };
  const allCold = walk(tree.roots);
  return sawFile && allCold;
}
