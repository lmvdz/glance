/**
 * WorkflowGraphOverlay — a workflow run's static topology (journaled once as `workflowGraph`)
 * with live progress (`workflowState`) overlaid.
 *
 * Layout/rendering modeled directly on PlanFlowDiagram: HTML node boxes (Tailwind-styled) over
 * an SVG edge layer, laid out left→right by BFS depth from `graph.start` (lib/workflowGraph).
 * Retry edges (from a node's `retryTarget`) render dashed, since they represent a failure route
 * rather than the run's normal forward path.
 *
 * When `traceId` is supplied, clicking any node toggles a drill-in panel fetched from
 * `/api/trace/:id` (server-side cached, see src/server.ts's tracePayload). The trace is per-run,
 * not per-node — every node opens the same run trace — so the click target is "show me what this
 * run actually did", not a per-node breakdown. `trace.rollup` (never sampled) is the primary view;
 * `trace.root`'s span waterfall renders underneath, labeled "sampled — partial" when
 * `trace.partial` is true.
 */

import React, { useMemo, useState } from 'react';
import { buildWorkflowFlow, type WorkflowFlowNode } from '../lib/workflowGraph';
import type { WorkflowGraphSnapshotDTO, WorkflowRunStateDTO, TraceResponseDTO, TraceNodeDTO } from '../lib/dto';
import { apiJson } from '../lib/api';
import { formatDurationMs, formatUsd } from '../lib/trace';

export interface WorkflowGraphOverlayProps {
  graph: WorkflowGraphSnapshotDTO;
  state?: WorkflowRunStateDTO;
  /** 'horizontal' (default): batches flow left→right. 'vertical': batches stack top→bottom —
   *  better use of tall containers (e.g. the full-pane focus view). */
  orientation?: 'horizontal' | 'vertical';
  /** When present, nodes become clickable and open a trace drill-in panel for this run/feature. */
  traceId?: string;
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

export const WorkflowGraphOverlay: React.FC<WorkflowGraphOverlayProps> = ({ graph, state, orientation = 'horizontal', traceId }) => {
  const vertical = orientation === 'vertical';
  const flow = useMemo(() => buildWorkflowFlow(graph, state), [graph, state]);
  const [traceOpen, setTraceOpen] = useState(false);
  const [traceData, setTraceData] = useState<TraceResponseDTO | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);

  const handleNodeClick = (n: WorkflowFlowNode) => {
    void n; // the trace is per-run, not per-node — any node opens the same run trace
    if (!traceId) return;
    if (traceOpen) {
      setTraceOpen(false);
      return;
    }
    setTraceOpen(true);
    setTraceLoading(true);
    setTraceError(null);
    apiJson<TraceResponseDTO>(`/api/trace/${encodeURIComponent(traceId)}`)
      .then((data) => setTraceData(data))
      .catch((err) => setTraceError(err instanceof Error ? err.message : String(err)))
      .finally(() => setTraceLoading(false));
  };

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
          {flow.edges.map((e, i) => {
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
            const midX = (a.x + b.x) / 2 + COL_W / 2;
            const midY = (a.y + b.y) / 2 + NODE_H / 2;
            const edgeLabel = e.label ?? e.condition;
            return (
              <React.Fragment key={`${e.from}->${e.to}:${e.kind}:${i}`}>
                <path
                  d={d}
                  className={e.kind === 'retry' ? 'fill-none stroke-amber-400 dark:stroke-amber-500' : 'fill-none stroke-gray-300 dark:stroke-gray-700'}
                  strokeWidth={1.5}
                  strokeDasharray={e.kind === 'retry' ? '4 3' : undefined}
                  markerEnd="url(#workflowflow-arrow)"
                />
                {edgeLabel && (
                  <text x={midX} y={midY - 4} textAnchor="middle" className="fill-gray-500 dark:fill-gray-400" style={{ fontSize: 9 }}>
                    {edgeLabel}
                  </text>
                )}
              </React.Fragment>
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
              role={traceId ? 'button' : undefined}
              tabIndex={traceId ? 0 : undefined}
              onClick={traceId ? () => handleNodeClick(n) : undefined}
              onKeyDown={traceId ? (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); handleNodeClick(n); } } : undefined}
              title={`${n.label} — ${n.status}${n.kind ? ` · ${n.kind}` : ''}${traceId ? ' · click for trace' : ''}`}
              className={`absolute flex flex-col justify-center gap-1 rounded-lg border border-l-4 ${t.border} bg-white dark:bg-gray-900 px-2.5 py-1.5 shadow-sm${traceId ? ' cursor-pointer hover:ring-1 hover:ring-gray-300 dark:hover:ring-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400' : ''}`}
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
      {traceOpen && (
        <TraceDrilldown data={traceData} loading={traceLoading} error={traceError} onClose={() => setTraceOpen(false)} />
      )}
    </div>
  );
};

/** Primary view: `trace.rollup` (never sampled — cost/duration/tool counts always present).
 *  Secondary: the span waterfall under `trace.root`, labeled "sampled — partial" when
 *  `trace.partial` is true (fine spans were tail-sampled out of at least one receipt). */
const TraceDrilldown: React.FC<{ data: TraceResponseDTO | null; loading: boolean; error: string | null; onClose: () => void }> = ({
  data,
  loading,
  error,
  onClose,
}) => {
  return (
    <div className="mt-1 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3 text-xs">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-medium text-gray-700 dark:text-gray-200">Trace</span>
        {data?.partial && (
          <span className="rounded-full bg-amber-100 dark:bg-amber-900/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-400">
            sampled — partial
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          className="ml-auto text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 focus:outline-none focus-visible:underline"
        >
          Close
        </button>
      </div>
      {loading && <div className="text-gray-500 dark:text-gray-400">Loading trace…</div>}
      {error && <div className="text-red-500 dark:text-red-400">Failed to load trace: {error}</div>}
      {!loading && !error && data && (
        <>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            <Stat label="runs" value={String(data.rollup.runs)} />
            <Stat label="tool calls" value={String(data.rollup.toolCalls)} />
            <Stat label="cost" value={formatUsd(data.rollup.costUsd)} />
            <Stat label="tokens" value={data.rollup.tokens.toLocaleString()} />
            <Stat label="duration" value={formatDurationMs(data.rollup.durationMs)} />
            <Stat label="errors" value={String(data.rollup.errors)} />
          </div>
          <div className="mt-3 border-t border-gray-100 dark:border-gray-800 pt-2">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-gray-400">Span waterfall</div>
            <TraceSpanRow node={data.root} depth={0} />
          </div>
        </>
      )}
      {!loading && !error && !data && <div className="text-gray-500 dark:text-gray-400">No trace data.</div>}
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex flex-col">
    <span className="text-[10px] uppercase tracking-wide text-gray-400">{label}</span>
    <span className="text-xs font-medium text-gray-700 dark:text-gray-200">{value}</span>
  </div>
);

const SPAN_STATUS_DOT: Record<string, string> = { ok: 'bg-emerald-500', error: 'bg-red-500', running: 'bg-blue-500' };

const TraceSpanRow: React.FC<{ node: TraceNodeDTO; depth: number }> = ({ node, depth }) => (
  <div>
    <div className="flex items-center gap-1.5 py-0.5" style={{ paddingLeft: depth * 14 }}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${SPAN_STATUS_DOT[node.status] ?? 'bg-gray-300'}`} aria-hidden="true" />
      <span className="truncate text-gray-700 dark:text-gray-300">{node.name}</span>
      <span className="text-[10px] text-gray-400">{node.kind}</span>
      <span className="ml-auto shrink-0 text-[10px] text-gray-400">
        {node.endedAt !== undefined ? formatDurationMs(node.endedAt - node.startedAt) : 'running'}
      </span>
    </div>
    {node.children.map((c) => (
      <TraceSpanRow key={c.spanId} node={c} depth={depth + 1} />
    ))}
  </div>
);
