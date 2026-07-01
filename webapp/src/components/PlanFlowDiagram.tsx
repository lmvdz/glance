/**
 * PlanFlowDiagram — the plan's concerns as a dependency DAG, now editable.
 *
 * Turns a flat plan (read today as a stack of markdown files) into a picture:
 * concerns laid out left→right in batch/dependency order, status-colored, with
 * edges showing what blocks what. Built client-side from the pipeline payload
 * (lib/planGraph) — no new endpoint. Click a node to open that concern doc.
 *
 * When `onEdit` is supplied, each node gets a ✎ affordance that opens an inline
 * editor: change the concern's STATUS and the concerns that block it, straight
 * from the diagram. The edit is written back to the concern doc + the overview
 * dependency table by the backend (PATCH /api/features/:id/concerns).
 *
 * HTML node boxes (Tailwind-styled) over an SVG edge layer, so the boxes read
 * like the rest of the dashboard while the edges stay crisp curves.
 */

import React, { useMemo } from 'react';
import { buildPlanGraph, type GraphConcernInput } from '../lib/planGraph';

export interface ConcernEdit {
  status?: string;
  blockedBy?: number[];
}

export interface PlanFlowDiagramProps {
  concerns: GraphConcernInput[];
  overviewText?: string;
  selectedId?: string;
  onSelect?: (id: string) => void;
  /** When provided, nodes become editable: returns a promise so the editor can show a saving state. */
  onEdit?: (file: string, patch: ConcernEdit) => void | Promise<void>;
  /** 'horizontal' (default): batches flow left→right. 'vertical': batches stack top→bottom —
   *  better use of tall containers (e.g. the full-pane focus view). */
  orientation?: 'horizontal' | 'vertical';
}

// per-axis gaps; the cross axis (concerns within a batch) is tighter than the depth axis (between batches)
const V_GUTTER = 60; // left gutter for batch labels in vertical mode
const X_GAP_V = 28;
const Y_GAP_V = 54;

const COL_W = 196;
const COL_GAP = 64;
const NODE_H = 60;
const ROW_GAP = 18;
const PAD = 12;
const HEADER_H = 22;

const STATUS_OPTIONS = ['open', 'in-progress', 'blocked', 'done'] as const;

function tone(open: boolean, status: string): { border: string; dot: string; text: string } {
  const s = status.toLowerCase();
  if (!open) return { border: 'border-l-emerald-500', dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' };
  if (/progress|active|doing|wip|started/.test(s)) return { border: 'border-l-blue-500', dot: 'bg-blue-500', text: 'text-blue-600 dark:text-blue-400' };
  if (/block/.test(s)) return { border: 'border-l-red-500', dot: 'bg-red-500', text: 'text-red-600 dark:text-red-400' };
  return { border: 'border-l-amber-400', dot: 'bg-amber-400', text: 'text-amber-600 dark:text-amber-400' };
}

/** Map a free-form status onto one of the four canonical options the editor offers. */
function normStatus(open: boolean, status: string): string {
  const s = status.toLowerCase();
  if (!open || /done|complete|closed/.test(s)) return 'done';
  if (/progress|active|doing|wip|started/.test(s)) return 'in-progress';
  if (/block/.test(s)) return 'blocked';
  return 'open';
}

export const PlanFlowDiagram: React.FC<PlanFlowDiagramProps> = ({ concerns, overviewText = '', selectedId, onSelect, onEdit, orientation = 'horizontal' }) => {
  const vertical = orientation === 'vertical';
  const graph = useMemo(() => buildPlanGraph(concerns, overviewText), [concerns, overviewText]);
  const [editId, setEditId] = React.useState<string | null>(null);
  const [statusValue, setStatusValue] = React.useState<string>('open');
  const [blockedSet, setBlockedSet] = React.useState<Set<number>>(new Set());
  const [saving, setSaving] = React.useState(false);

  // depth axis = batch order (n.col); cross axis = position within a batch (n.row). Horizontal maps
  // depth→x, cross→y; vertical swaps them so batches march downward and use a tall container.
  const pos = useMemo(() => {
    const gutter = vertical ? V_GUTTER : 0;
    const xStep = COL_W + (vertical ? X_GAP_V : COL_GAP);
    const yStep = NODE_H + (vertical ? Y_GAP_V : ROW_GAP);
    const m = new Map<string, { x: number; y: number }>();
    for (const n of graph.nodes) {
      const xi = vertical ? n.row : n.col;
      const yi = vertical ? n.col : n.row;
      m.set(n.id, { x: PAD + gutter + xi * xStep, y: PAD + HEADER_H + yi * yStep });
    }
    return m;
  }, [graph, vertical]);

  // current blockers per node, derived from edges (from = blocker → to = dependent)
  const blockersOf = useMemo(() => {
    const numById = new Map(graph.nodes.map((n) => [n.id, n.num] as const));
    const m = new Map<string, number[]>();
    for (const e of graph.edges) {
      const bn = numById.get(e.from);
      if (bn == null) continue;
      const arr = m.get(e.to) ?? [];
      arr.push(bn);
      m.set(e.to, arr);
    }
    return m;
  }, [graph]);

  const editNode = editId ? graph.nodes.find((n) => n.id === editId) ?? null : null;

  // seed the editor's fields whenever the target node changes
  React.useEffect(() => {
    if (!editNode) return;
    setStatusValue(normStatus(editNode.open, editNode.status));
    setBlockedSet(new Set(blockersOf.get(editNode.id) ?? []));
  }, [editNode, blockersOf]);

  // a node leaving the graph (e.g. after a reload) should close a stale editor
  React.useEffect(() => {
    if (editId && !graph.nodes.some((n) => n.id === editId)) setEditId(null);
  }, [graph, editId]);

  if (graph.nodes.length === 0) {
    return <div className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400">No concerns to chart in this plan.</div>;
  }

  const rowsPerCol = new Map<number, number>();
  for (const n of graph.nodes) rowsPerCol.set(n.col, Math.max(rowsPerCol.get(n.col) ?? 0, n.row + 1));
  const maxRows = Math.max(1, ...rowsPerCol.values());
  const gutter = vertical ? V_GUTTER : 0;
  const xCount = vertical ? maxRows : graph.cols; // node columns laid along x
  const yCount = vertical ? graph.cols : maxRows; // node rows laid along y
  const xGap = vertical ? X_GAP_V : COL_GAP;
  const yGap = vertical ? Y_GAP_V : ROW_GAP;
  const width = PAD * 2 + gutter + xCount * COL_W + (xCount - 1) * xGap;
  const height = PAD * 2 + HEADER_H + yCount * NODE_H + (yCount - 1) * yGap;
  const doneCount = graph.nodes.filter((n) => !n.open).length;

  // candidates for the blockers picker: every other numbered concern
  const blockerChoices = graph.nodes
    .filter((n) => n.num != null && n.id !== editId)
    .map((n) => ({ num: n.num as number, title: n.title }))
    .sort((a, b) => a.num - b.num);

  const toggleBlocker = (num: number) => {
    setBlockedSet((prev) => {
      const next = new Set(prev);
      if (next.has(num)) next.delete(num); else next.add(num);
      return next;
    });
  };

  const handleSave = async () => {
    if (!editNode || !onEdit) return;
    setSaving(true);
    try {
      await onEdit(editNode.id, { status: statusValue, blockedBy: [...blockedSet].sort((a, b) => a - b) });
      setEditId(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {graph.issues.length > 0 && (
        <div className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          <div className="mb-1 font-semibold uppercase tracking-wider">Plan dependency issues</div>
          <ul className="list-disc space-y-0.5 pl-4">
            {graph.issues.map((issue, i) => <li key={`${issue.kind}-${i}`}>{issue.message}</li>)}
          </ul>
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-950/40 p-1 scrollbar-custom">
        <div className="relative" style={{ width, height }}>
          {/* edge layer */}
          <svg className="pointer-events-none absolute inset-0" width={width} height={height} aria-hidden="true">
            <defs>
              <marker id="planflow-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                <path d="M0,0 L7,3.5 L0,7 Z" className="fill-gray-400 dark:fill-gray-600" />
              </marker>
            </defs>
            {graph.edges.map((e) => {
              const a = pos.get(e.from);
              const b = pos.get(e.to);
              if (!a || !b) return null;
              // vertical: bottom of blocker → top of dependent; horizontal: right → left edge
              const d = vertical
                ? (() => {
                    const x1 = a.x + COL_W / 2, y1 = a.y + NODE_H, x2 = b.x + COL_W / 2, y2 = b.y, my = (y1 + y2) / 2;
                    return `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2 - 2}`;
                  })()
                : (() => {
                    const x1 = a.x + COL_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2, mx = (x1 + x2) / 2;
                    return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2 - 2} ${y2}`;
                  })();
              return (
                <path
                  key={`${e.from}->${e.to}`}
                  d={d}
                  className="fill-none stroke-gray-300 dark:stroke-gray-700"
                  strokeWidth={1.5}
                  markerEnd="url(#planflow-arrow)"
                />
              );
            })}
          </svg>

          {/* batch labels — column headers (horizontal) or left-gutter row labels (vertical) */}
          {Array.from({ length: graph.cols }, (_, c) => (
            <div
              key={`hdr-${c}`}
              className="absolute text-[10px] font-semibold uppercase tracking-wider text-gray-400"
              style={vertical
                ? { left: PAD, top: PAD + HEADER_H + c * (NODE_H + Y_GAP_V) + NODE_H / 2 - 6, width: V_GUTTER - 10 }
                : { left: PAD + c * (COL_W + COL_GAP), top: PAD - 2, width: COL_W }}
            >
              Batch {c + 1}
            </div>
          ))}

          {/* nodes */}
          {graph.nodes.map((n) => {
            const p = pos.get(n.id)!;
            const t = tone(n.open, n.status);
            const active = n.id === selectedId;
            const editing = n.id === editId;
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => onSelect?.(n.id)}
                title={`${n.title} — ${n.status}${n.touches.length ? ` · touches ${n.touches.length}` : ''}`}
                className={`absolute flex flex-col justify-center gap-1 rounded-lg border border-l-4 ${t.border} bg-white dark:bg-gray-900 ${onEdit ? 'pl-2.5 pr-7' : 'px-2.5'} py-1.5 text-left shadow-sm transition-colors hover:border-gray-300 dark:hover:border-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${active || editing ? 'ring-2 ring-blue-500' : ''}`}
                style={{ left: p.x, top: p.y, width: COL_W, height: NODE_H }}
              >
                <div className="flex items-center gap-1.5">
                  {n.num != null && <span className="shrink-0 rounded bg-gray-100 dark:bg-gray-800 px-1 text-[10px] font-semibold tabular-nums text-gray-500 dark:text-gray-400">{String(n.num).padStart(2, '0')}</span>}
                  <span className="truncate text-xs font-medium text-gray-800 dark:text-gray-200">{n.title}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${t.dot}`} aria-hidden="true" />
                  <span className={`text-[10px] ${t.text}`}>{n.open ? n.status || 'open' : 'done'}</span>
                  {n.complexity && <span className="ml-auto truncate text-[10px] text-gray-400">{n.complexity}</span>}
                </div>
              </button>
            );
          })}

          {/* edit affordances (separate layer so we don't nest buttons) */}
          {onEdit && graph.nodes.map((n) => {
            const p = pos.get(n.id)!;
            const editing = n.id === editId;
            return (
              <button
                key={`edit-${n.id}`}
                type="button"
                onClick={(ev) => { ev.stopPropagation(); setEditId(editing ? null : n.id); }}
                title="Edit status & dependencies"
                aria-label={`Edit ${n.title}`}
                aria-pressed={editing}
                className={`absolute z-10 flex h-5 w-5 items-center justify-center rounded text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${editing ? 'bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-300' : ''}`}
                style={{ left: p.x + COL_W - 23, top: p.y + 5 }}
              >
                <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
              </button>
            );
          })}
        </div>
      </div>

      {/* inline editor for the selected node */}
      {onEdit && editNode && (
        <div className="mt-2 rounded-lg border border-blue-200 bg-blue-50/60 p-3 dark:border-blue-900 dark:bg-blue-950/30">
          <div className="mb-2 flex items-center gap-2">
            {editNode.num != null && <span className="rounded bg-white dark:bg-gray-900 px-1.5 text-[10px] font-semibold tabular-nums text-gray-500 dark:text-gray-400">{String(editNode.num).padStart(2, '0')}</span>}
            <span className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">{editNode.title}</span>
            <button type="button" onClick={() => setEditId(null)} className="ml-auto text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 focus:outline-none focus-visible:underline">Close</button>
          </div>
          <div className="grid gap-3 sm:grid-cols-[auto_1fr]">
            <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
              <span className="font-semibold uppercase tracking-wider text-gray-400">Status</span>
              <select
                value={statusValue}
                onChange={(ev) => setStatusValue(ev.target.value)}
                className="rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-800 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              >
                {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <div className="text-xs text-gray-600 dark:text-gray-300">
              <div className="mb-1 font-semibold uppercase tracking-wider text-gray-400">Blocked by</div>
              {blockerChoices.length === 0 ? (
                <div className="text-gray-400">No other concerns to depend on.</div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {blockerChoices.map((c) => {
                    const on = blockedSet.has(c.num);
                    return (
                      <button
                        key={c.num}
                        type="button"
                        onClick={() => toggleBlocker(c.num)}
                        aria-pressed={on}
                        title={c.title}
                        className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${on ? 'border-blue-400 bg-blue-100 text-blue-700 dark:border-blue-700 dark:bg-blue-950 dark:text-blue-300' : 'border-gray-300 text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:text-gray-300'}`}
                      >
                        <span className="tabular-nums">#{c.num}</span> <span className="opacity-70">{c.title.length > 22 ? `${c.title.slice(0, 22)}…` : c.title}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={() => setEditId(null)} disabled={saving} className="rounded px-3 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-60 dark:text-gray-300 dark:hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">Cancel</button>
            <span className="text-[11px] text-gray-400">Writes the concern doc + overview dependency table.</span>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 px-2 py-1 text-[10px] text-gray-400">
        <span>{graph.nodes.length} concerns · {graph.cols} batch{graph.cols === 1 ? '' : 'es'} · {doneCount} done{graph.issues.length ? ` · ${graph.issues.length} dependency issue${graph.issues.length === 1 ? '' : 's'}` : ''}</span>
        <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> done</span>
        <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> open</span>
        <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-blue-500" /> in&nbsp;progress</span>
      </div>
    </div>
  );
};
