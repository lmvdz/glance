/**
 * planGraph.ts — turn a flat plan (plans/<name>/NN-concern.md + 00-overview.md)
 * into a dependency DAG the UI can draw.
 *
 * /plan emits a "Dependency graph" table in the overview (`| Concern | BLOCKED_BY |`)
 * and numbered concern docs with STATUS. This reads both — already shipped to the
 * client in the pipeline payload — and produces nodes + edges + a layered layout
 * (columns = batch order, derived by longest-path from the roots). No fetch, no
 * DOM: pure and unit-tested, like insights.ts / heatmap.ts.
 */

export interface GraphConcernInput {
  file: string;
  title: string;
  status: string;
  open: boolean;
  complexity?: string;
  prerequisites: string[];
  touches: string[];
}

export interface PlanGraphNode {
  id: string; // concern file
  num: number | null; // leading NN, when present
  title: string;
  status: string;
  open: boolean;
  complexity?: string;
  touches: string[];
  /** layout: column = dependency depth (batch), row = position within the column. */
  col: number;
  row: number;
}

export interface PlanGraphEdge {
  from: string; // prerequisite concern id
  to: string; // dependent concern id
}

export interface PlanGraph {
  nodes: PlanGraphNode[];
  edges: PlanGraphEdge[];
  cols: number;
  rows: number;
}

/** Leading concern number from a file like "03-runtime.md" → 3 (null if none). */
export function concernNum(file: string): number | null {
  const m = /(?:^|\/)(\d{1,3})[-_.]/.exec(file) ?? /^(\d{1,3})\b/.exec(file);
  return m ? Number(m[1]) : null;
}

/**
 * Parse the overview's "Dependency graph" markdown table into
 * concernNum → [blockedByNum…]. Tolerates "none"/"-" and extra columns.
 */
export function parseDependencyTable(overviewText: string): Map<number, number[]> {
  const out = new Map<number, number[]>();
  if (!overviewText) return out;
  const lines = overviewText.split(/\r?\n/);
  // find the "Dependency graph" heading, then read the table that follows
  let i = lines.findIndex((l) => /^#{1,6}\s*Dependency graph/i.test(l.trim()));
  if (i < 0) return out;
  for (i += 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (/^#{1,6}\s/.test(line)) break; // next section
    if (!line.startsWith("|")) {
      if (out.size > 0) break; // table ended
      continue;
    }
    // drop the empty leading/trailing cells produced by the outer pipes
    const cols = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cols.length < 2) continue;
    const c0 = cols[0];
    if (/concern/i.test(c0) || /^[-:\s]+$/.test(c0)) continue; // header or separator row
    const num = Number((/\d{1,3}/.exec(c0) ?? [])[0]);
    if (!Number.isFinite(num) || !c0.match(/\d/)) continue;
    const blockers = /\bnone\b|^[-—\s]*$/i.test(cols[1]) ? [] : [...cols[1].matchAll(/\d{1,3}/g)].map((m) => Number(m[0]));
    out.set(num, blockers);
  }
  return out;
}

/** Longest-path layering: a node's column is 1 + max(column of its prerequisites). */
function assignColumns(ids: string[], incoming: Map<string, Set<string>>): Map<string, number> {
  const col = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    if (col.has(id)) return col.get(id)!;
    if (visiting.has(id)) return 0; // cycle guard
    visiting.add(id);
    let d = 0;
    for (const pre of incoming.get(id) ?? []) d = Math.max(d, depth(pre) + 1);
    visiting.delete(id);
    col.set(id, d);
    return d;
  };
  for (const id of ids) depth(id);
  return col;
}

/**
 * Build the dependency DAG. Edges come from the overview dependency table first;
 * if a concern's row is missing there, its own `prerequisites` lines are scanned
 * for concern-number references as a fallback. Self/dangling refs are dropped.
 */
export function buildPlanGraph(concerns: GraphConcernInput[], overviewText = ""): PlanGraph {
  // nodes = concerns excluding the overview doc itself (00-overview)
  const nodes = concerns.filter((c) => !/(?:^|\/)0*0[-_.]?overview/i.test(c.file) && !/^overview\b/i.test(c.title));
  const byNum = new Map<number, string>();
  for (const c of nodes) {
    const n = concernNum(c.file);
    if (n != null && !byNum.has(n)) byNum.set(n, c.file);
  }

  const table = parseDependencyTable(overviewText);
  const incoming = new Map<string, Set<string>>();
  const ensure = (id: string): Set<string> => {
    let s = incoming.get(id);
    if (!s) incoming.set(id, (s = new Set()));
    return s;
  };
  for (const c of nodes) ensure(c.file);

  for (const c of nodes) {
    const n = concernNum(c.file);
    const fromTable = n != null ? table.get(n) : undefined;
    const blockerNums = fromTable && fromTable.length
      ? fromTable
      : // fallback: scan this concern's prerequisites lines for concern numbers
        [...new Set(c.prerequisites.flatMap((p) => [...p.matchAll(/(?:concern\s*)?#?\b(\d{1,3})\b/gi)].map((m) => Number(m[1]))))];
    for (const bn of blockerNums) {
      const from = byNum.get(bn);
      if (from && from !== c.file) ensure(c.file).add(from);
    }
  }

  const ids = nodes.map((c) => c.file);
  const colOf = assignColumns(ids, incoming);
  const rowCounters = new Map<number, number>();
  const layoutNodes: PlanGraphNode[] = nodes.map((c) => {
    const col = colOf.get(c.file) ?? 0;
    const row = rowCounters.get(col) ?? 0;
    rowCounters.set(col, row + 1);
    return {
      id: c.file,
      num: concernNum(c.file),
      title: c.title,
      status: c.status,
      open: c.open,
      complexity: c.complexity,
      touches: c.touches,
      col,
      row,
    };
  });

  const edges: PlanGraphEdge[] = [];
  for (const [to, froms] of incoming) for (const from of froms) edges.push({ from, to });

  const cols = layoutNodes.reduce((m, n) => Math.max(m, n.col + 1), 0);
  const rows = [...rowCounters.values()].reduce((m, r) => Math.max(m, r), 0);
  return { nodes: layoutNodes, edges, cols, rows };
}
