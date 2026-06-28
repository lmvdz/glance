/**
 * PlanFlowDiagram — the plan's concerns as a dependency DAG.
 *
 * Turns a flat plan (read today as a stack of markdown files) into a picture:
 * concerns laid out left→right in batch/dependency order, status-colored, with
 * edges showing what blocks what. Built client-side from the pipeline payload
 * (lib/planGraph) — no new endpoint. Click a node to open that concern doc.
 *
 * HTML node boxes (Tailwind-styled) over an SVG edge layer, so the boxes read
 * like the rest of the dashboard while the edges stay crisp curves.
 */

import React, { useMemo } from 'react';
import { buildPlanGraph, type GraphConcernInput } from '../lib/planGraph';

export interface PlanFlowDiagramProps {
  concerns: GraphConcernInput[];
  overviewText?: string;
  selectedId?: string;
  onSelect?: (id: string) => void;
}

const COL_W = 196;
const COL_GAP = 64;
const NODE_H = 60;
const ROW_GAP = 18;
const PAD = 12;
const HEADER_H = 22;

function tone(open: boolean, status: string): { border: string; dot: string; text: string } {
  const s = status.toLowerCase();
  if (!open) return { border: 'border-l-emerald-500', dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' };
  if (/progress|active|doing|wip|started/.test(s)) return { border: 'border-l-blue-500', dot: 'bg-blue-500', text: 'text-blue-600 dark:text-blue-400' };
  if (/block/.test(s)) return { border: 'border-l-red-500', dot: 'bg-red-500', text: 'text-red-600 dark:text-red-400' };
  return { border: 'border-l-amber-400', dot: 'bg-amber-400', text: 'text-amber-600 dark:text-amber-400' };
}

export const PlanFlowDiagram: React.FC<PlanFlowDiagramProps> = ({ concerns, overviewText = '', selectedId, onSelect }) => {
  const graph = useMemo(() => buildPlanGraph(concerns, overviewText), [concerns, overviewText]);

  const pos = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    for (const n of graph.nodes) {
      m.set(n.id, { x: PAD + n.col * (COL_W + COL_GAP), y: PAD + HEADER_H + n.row * (NODE_H + ROW_GAP) });
    }
    return m;
  }, [graph]);

  if (graph.nodes.length === 0) {
    return <div className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400">No concerns to chart in this plan.</div>;
  }

  const rowsPerCol = new Map<number, number>();
  for (const n of graph.nodes) rowsPerCol.set(n.col, Math.max(rowsPerCol.get(n.col) ?? 0, n.row + 1));
  const maxRows = Math.max(1, ...rowsPerCol.values());
  const width = PAD * 2 + graph.cols * COL_W + (graph.cols - 1) * COL_GAP;
  const height = PAD * 2 + HEADER_H + maxRows * NODE_H + (maxRows - 1) * ROW_GAP;
  const doneCount = graph.nodes.filter((n) => !n.open).length;

  return (
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
            const x1 = a.x + COL_W;
            const y1 = a.y + NODE_H / 2;
            const x2 = b.x;
            const y2 = b.y + NODE_H / 2;
            const mx = (x1 + x2) / 2;
            return (
              <path
                key={`${e.from}->${e.to}`}
                d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2 - 2} ${y2}`}
                className="fill-none stroke-gray-300 dark:stroke-gray-700"
                strokeWidth={1.5}
                markerEnd="url(#planflow-arrow)"
              />
            );
          })}
        </svg>

        {/* column (batch) headers */}
        {Array.from({ length: graph.cols }, (_, c) => (
          <div
            key={`hdr-${c}`}
            className="absolute text-[10px] font-semibold uppercase tracking-wider text-gray-400"
            style={{ left: PAD + c * (COL_W + COL_GAP), top: PAD - 2, width: COL_W }}
          >
            Batch {c + 1}
          </div>
        ))}

        {/* nodes */}
        {graph.nodes.map((n) => {
          const p = pos.get(n.id)!;
          const t = tone(n.open, n.status);
          const active = n.id === selectedId;
          return (
            <button
              key={n.id}
              type="button"
              onClick={() => onSelect?.(n.id)}
              title={`${n.title} — ${n.status}${n.touches.length ? ` · touches ${n.touches.length}` : ''}`}
              className={`absolute flex flex-col justify-center gap-1 rounded-lg border border-l-4 ${t.border} bg-white dark:bg-gray-900 px-2.5 py-1.5 text-left shadow-sm transition-colors hover:border-gray-300 dark:hover:border-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${active ? 'ring-2 ring-blue-500' : ''}`}
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
      </div>

      <div className="flex items-center gap-3 px-2 py-1 text-[10px] text-gray-400">
        <span>{graph.nodes.length} concerns · {graph.cols} batch{graph.cols === 1 ? '' : 'es'} · {doneCount} done</span>
        <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> done</span>
        <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> open</span>
        <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-blue-500" /> in&nbsp;progress</span>
      </div>
    </div>
  );
};
