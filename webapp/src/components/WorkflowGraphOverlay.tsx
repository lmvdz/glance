/**
 * WorkflowGraphOverlay — a workflow run's static topology (journaled once as `workflowGraph`)
 * with live progress (`workflowState`) overlaid.
 *
 * Layout/rendering modeled directly on PlanFlowDiagram: HTML node boxes (Tailwind-styled) over
 * an SVG edge layer, laid out left→right by BFS depth from `graph.start` (lib/workflowGraph).
 * Retry edges (from a node's `retryTarget`) render dashed, since they represent a failure route
 * rather than the run's normal forward path.
 */

import React, { useMemo } from 'react';
import { buildWorkflowFlow, type WorkflowFlowNode } from '../lib/workflowGraph';
import type { WorkflowGraphSnapshotDTO, WorkflowRunStateDTO } from '../lib/dto';

export interface WorkflowGraphOverlayProps {
  graph: WorkflowGraphSnapshotDTO;
  state?: WorkflowRunStateDTO;
  /** 'horizontal' (default): batches flow left→right. 'vertical': batches stack top→bottom —
   *  better use of tall containers (e.g. the full-pane focus view). */
  orientation?: 'horizontal' | 'vertical';
}

const V_GUTTER = 0;
const X_GAP_V = 28;
const Y_GAP_V = 54;
const COL_W = 176;
const COL_GAP = 64;
const NODE_H = 52;
const ROW_GAP = 18;
const PAD = 12;

function tone(node: WorkflowFlowNode, isCurrent: boolean): { border: string; dot: string; text: string } {
  if (isCurrent) return { border: 'border-l-blue-500 ring-2 ring-blue-400 dark:ring-blue-500', dot: 'bg-blue-500', text: 'text-blue-600 dark:text-blue-400' };
  if (node.status === 'completed') return { border: 'border-l-emerald-500', dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' };
  if (node.status === 'in_progress') return { border: 'border-l-blue-500', dot: 'bg-blue-500', text: 'text-blue-600 dark:text-blue-400' };
  return { border: 'border-l-gray-300 dark:border-l-gray-700', dot: 'bg-gray-300 dark:bg-gray-600', text: 'text-gray-500 dark:text-gray-400' };
}

export const WorkflowGraphOverlay: React.FC<WorkflowGraphOverlayProps> = ({ graph, state, orientation = 'horizontal' }) => {
  const vertical = orientation === 'vertical';
  const flow = useMemo(() => buildWorkflowFlow(graph, state), [graph, state]);

  const pos = useMemo(() => {
    const gutter = vertical ? V_GUTTER : 0;
    const xStep = COL_W + (vertical ? X_GAP_V : COL_GAP);
    const yStep = NODE_H + (vertical ? Y_GAP_V : ROW_GAP);
    const m = new Map<string, { x: number; y: number }>();
    for (const n of flow.nodes) {
      const xi = vertical ? n.row : n.col;
      const yi = vertical ? n.col : n.row;
      m.set(n.id, { x: PAD + gutter + xi * xStep, y: PAD + yi * yStep });
    }
    return m;
  }, [flow, vertical]);

  if (flow.nodes.length === 0) {
    return <div className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400">No workflow graph to chart.</div>;
  }

  const rowsPerCol = new Map<number, number>();
  for (const n of flow.nodes) rowsPerCol.set(n.col, Math.max(rowsPerCol.get(n.col) ?? 0, n.row + 1));
  const maxRows = Math.max(1, ...rowsPerCol.values());
  const gutter = vertical ? V_GUTTER : 0;
  const xCount = vertical ? maxRows : flow.cols;
  const yCount = vertical ? flow.cols : maxRows;
  const xGap = vertical ? X_GAP_V : COL_GAP;
  const yGap = vertical ? Y_GAP_V : ROW_GAP;
  const width = PAD * 2 + gutter + xCount * COL_W + (xCount - 1) * xGap;
  const height = PAD * 2 + yCount * NODE_H + (yCount - 1) * yGap;

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-950/40 p-1 scrollbar-custom">
      <div className="relative" style={{ width, height }}>
        <svg className="pointer-events-none absolute inset-0" width={width} height={height} aria-hidden="true">
          <defs>
            <marker id="workflowflow-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 Z" className="fill-gray-400 dark:fill-gray-600" />
            </marker>
          </defs>
          {flow.edges.map((e) => {
            const a = pos.get(e.from);
            const b = pos.get(e.to);
            if (!a || !b) return null;
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
                key={`${e.from}->${e.to}:${e.kind}`}
                d={d}
                className={e.kind === 'retry' ? 'fill-none stroke-amber-400 dark:stroke-amber-500' : 'fill-none stroke-gray-300 dark:stroke-gray-700'}
                strokeWidth={1.5}
                strokeDasharray={e.kind === 'retry' ? '4 3' : undefined}
                markerEnd="url(#workflowflow-arrow)"
              />
            );
          })}
        </svg>

        {flow.nodes.map((n) => {
          const p = pos.get(n.id)!;
          const isCurrent = state?.currentNode === n.id;
          const t = tone(n, isCurrent);
          return (
            <div
              key={n.id}
              title={`${n.label} — ${n.status}${n.kind ? ` · ${n.kind}` : ''}`}
              className={`absolute flex flex-col justify-center gap-1 rounded-lg border border-l-4 ${t.border} bg-white dark:bg-gray-900 px-2.5 py-1.5 shadow-sm`}
              style={{ left: p.x, top: p.y, width: COL_W, height: NODE_H }}
            >
              <div className="flex items-center gap-1.5">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${t.dot}`} aria-hidden="true" />
                <span className="truncate text-xs font-medium text-gray-800 dark:text-gray-200">{n.label}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className={`text-[10px] uppercase tracking-wide ${t.text}`}>{isCurrent ? 'current' : n.status.replace('_', ' ')}</span>
                <span className="ml-auto truncate text-[10px] text-gray-400">{n.kind}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
