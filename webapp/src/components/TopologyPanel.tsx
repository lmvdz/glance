/**
 * TopologyPanel — fleet-wide parent/child forest.
 *
 * A port + extension of the legacy `renderRace` root/child split (src/web/index.html:1319-1341):
 * every top-level agent and workflow branch fan-out renders as one collapsible tree instead of a
 * flat list. Each agent's task-spawned subagents (if any — `AgentDTO.subagents`, src/subagents.ts)
 * render as a flat set of status-colored leaf rows beneath it: they don't themselves nest further
 * (a subagent spawning its own subagents flattens into the same list — "nesting is out of scope for
 * this slice", subagents.ts), so they're rows, not their own collapsible subtree. Workflow nodes get
 * a compact rollup progress bar ported from the legacy `renderWorkflowRun` (src/web/index.html:1275-
 * 1284, the "racebar" of segments). A dangling `parentId` (parent removed from the roster) shows as
 * a promoted root with an "orphaned" badge rather than silently vanishing — see lib/lineage.ts's
 * `orphaned` field.
 */

import React from 'react';
import { GitBranch, ChevronRight } from 'lucide-react';
import { useTaskContext } from '../context/TaskContext';
import { buildLineageTree, type LineageNode } from '../lib/lineage';
import type { SubagentNodeDTO } from '../lib/dto';
import { PanelShell } from './ui';
import { STATUS_DOT } from './AgentStatusStrip';

const KIND_LABEL: Record<string, string> = { 'omp-operator': 'operator', workflow: 'workflow', 'flue-service': 'flue' };

/** Status colors for a subagent leaf row — mirrors STATUS_DOT's convention but keyed on the
 *  `SubagentNode` status vocabulary (src/subagents.ts's LIFECYCLE_STATUS mapping + progress
 *  snapshots): pending/running/completed/failed/aborted, not an `AgentStatus`. */
const SUBAGENT_STATUS_DOT: Record<string, string> = {
  running: 'bg-emerald-500',
  pending: 'bg-sky-500',
  completed: 'bg-gray-400',
  failed: 'bg-red-500',
  aborted: 'bg-red-500',
};

/** One task-spawned subagent, rendered as a leaf row under its parent's TopologyRow — no expand
 *  toggle (subagents don't nest further), indented one level deeper than the parent. */
const SubagentRow: React.FC<{ node: SubagentNodeDTO; depth: number }> = ({ node, depth }) => (
  <div className="flex items-center gap-1.5 rounded px-1.5 py-1" style={{ paddingLeft: depth * 18 + 6 }}>
    <span className="h-4 w-4 shrink-0" aria-hidden="true" />
    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${SUBAGENT_STATUS_DOT[node.status] ?? 'bg-gray-400'}`} aria-hidden="true" />
    <span className="truncate text-xs text-gray-500 dark:text-gray-400">{node.agent}</span>
    <span className="ml-auto shrink-0 text-[10px] text-gray-400">{node.status}</span>
  </div>
);

/** Segmented rollup bar — one segment per workflow stage, filled as it completes. Direct port of
 *  the legacy `.racebar`/`.seg` markup, in Tailwind. */
const RollupBar: React.FC<{ rollup: { label: string; status: 'in_progress' | 'completed' }[] }> = ({ rollup }) => {
  if (rollup.length === 0) return null;
  const done = rollup.filter((r) => r.status === 'completed').length;
  return (
    <div className="mt-1 flex items-center gap-1.5" role="img" aria-label={`${done}/${rollup.length} steps complete`}>
      <div className="flex gap-0.5">
        {rollup.map((r, i) => (
          <span
            key={i}
            title={r.label}
            className={`h-1.5 w-3 rounded-sm ${r.status === 'completed' ? 'bg-emerald-500' : 'bg-blue-400 dark:bg-blue-500'}`}
          />
        ))}
      </div>
      <span className="text-[10px] text-gray-400">{done}/{rollup.length}</span>
    </div>
  );
};

export const TopologyRow: React.FC<{ node: LineageNode; depth: number }> = ({ node, depth }) => {
  const [open, setOpen] = React.useState(true);
  const { agent, children, orphaned } = node;
  const subagents = agent.subagents ?? [];
  const hasChildren = children.length > 0 || subagents.length > 0;
  const rollup = agent.workflowState?.rollup;

  return (
    <div>
      <div className="flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-gray-50 dark:hover:bg-gray-900/60" style={{ paddingLeft: depth * 18 + 6 }}>
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? `Collapse ${agent.name}` : `Expand ${agent.name}`}
            aria-expanded={open}
            className="flex h-4 w-4 shrink-0 items-center justify-center text-gray-400 hover:text-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:hover:text-gray-200"
          >
            <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
          </button>
        ) : (
          <span className="h-4 w-4 shrink-0" aria-hidden="true" />
        )}
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[agent.status] ?? 'bg-gray-400'}`} aria-hidden="true" />
        <span className="truncate text-xs font-medium text-gray-800 dark:text-gray-200">{agent.name}</span>
        {agent.kind && (
          <span className="shrink-0 rounded bg-gray-100 px-1 text-[10px] uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
            {KIND_LABEL[agent.kind] ?? agent.kind}
          </span>
        )}
        {agent.branchIndex != null && <span className="shrink-0 text-[10px] tabular-nums text-gray-400" title="Branch index">#{agent.branchIndex}</span>}
        {orphaned && (
          <span
            className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
            title="This agent's declared parent is no longer in the roster"
          >
            orphaned (parent removed)
          </span>
        )}
        <span className="ml-auto shrink-0 text-[10px] text-gray-400">{agent.status}</span>
      </div>
      {rollup && rollup.length > 0 && <div style={{ paddingLeft: depth * 18 + 30 }}><RollupBar rollup={rollup} /></div>}
      {open && subagents.map((s) => <SubagentRow key={s.id} node={s} depth={depth + 1} />)}
      {open && children.map((child) => <TopologyRow key={child.agent.id} node={child} depth={depth + 1} />)}
    </div>
  );
};

export const TopologyPanel: React.FC = () => {
  const { agents } = useTaskContext();
  const tree = React.useMemo(() => buildLineageTree(agents), [agents]);

  return (
    <PanelShell
      icon={<GitBranch className="h-4 w-4 text-amber-500" aria-hidden="true" />}
      title="Topology"
      subtitle={`${agents.length} agent${agents.length === 1 ? '' : 's'} · ${tree.length} tree${tree.length === 1 ? '' : 's'}`}
    >
      {tree.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-gray-500 dark:text-gray-400">No agents running.</div>
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white p-1 dark:border-gray-800 dark:bg-gray-950" aria-label="Agent lineage tree">
          {tree.map((node) => <TopologyRow key={node.agent.id} node={node} depth={0} />)}
        </div>
      )}
    </PanelShell>
  );
};
