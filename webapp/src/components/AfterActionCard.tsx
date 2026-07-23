/**
 * AfterActionCard — "what happened to this agent", on the task where you'd look for it.
 *
 * Every terminal unit already writes a durable post-mortem (src/after-action.ts) that OUTLIVES its
 * auto-reaped roster row — but the only reader was the `glance aar` CLI, so the webapp's answer to
 * a dead agent was a bare "error" status with the why living in a file nobody opens. This section
 * fetches the report list once per task visit and shows the reports whose ids match the task's
 * (current + historical) agent ids: classification, terminal reason, branch state at death, and the
 * full rendered post-mortem behind an expand.
 *
 * Renders NOTHING when no report matches — most tasks never had a terminal unit, and an empty
 * "no post-mortems" card on every healthy task would be noise, not signal. The markdown is rendered,
 * never executed (it embeds redacted agent/gate output — see AfterActionReport.markdown's doc).
 * The pure list/matching logic lives in lib/loop-meters.ts (`reportsForAgents`); the presentational
 * list is exported for fixture tests.
 */

import React, { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { ChevronRight, FileClock } from 'lucide-react';
import { fetchAfterActions } from '../lib/api';
import { coerceAfterActions, reportsForAgents, type AfterActionWire } from '../lib/loop-meters';
import { relativeAge } from './ui/time';

const MARKDOWN_CLASS = 'prose prose-sm max-w-none dark:prose-invert prose-pre:text-[11px] prose-headings:text-sm';

const CLASSIFICATION_STYLE: Record<AfterActionWire['classification'], string> = {
  environment: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  implementation: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  unknown: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
};

/** One report row: headline (classification + reason + when), branch-state line, expandable full
 *  post-mortem. Counts of -1 mean "unknown" (fail-closed upstream) and are rendered as such. */
export const AfterActionRow: React.FC<{ report: AfterActionWire; now?: number }> = ({ report, now }) => {
  const [open, setOpen] = useState(false);
  const age = relativeAge(report.terminalAt, now);
  const branchState = [
    report.branch,
    report.commitsAhead >= 0 ? `${report.commitsAhead} commit${report.commitsAhead === 1 ? '' : 's'} ahead` : 'commits ahead unknown',
    report.dirtyFiles >= 0 ? `${report.dirtyFiles} dirty file${report.dirtyFiles === 1 ? '' : 's'}` : 'dirty state unknown',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className="border-b border-gray-100 last:border-b-0 dark:border-gray-800/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start gap-2 px-3 py-2.5 text-left transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500 dark:hover:bg-gray-800/60"
      >
        <ChevronRight
          className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${CLASSIFICATION_STYLE[report.classification]}`}
            >
              {report.classification}
            </span>
            <span className="text-xs font-medium text-gray-800 dark:text-gray-200">{report.terminalReason}</span>
            {age && (
              <span className="text-[11px] text-gray-400" title={new Date(report.terminalAt).toISOString()}>
                {age} ago
              </span>
            )}
          </span>
          <span className="mt-0.5 block truncate font-mono text-[11px] text-gray-500 dark:text-gray-400" title={report.id}>
            {report.name} {branchState && <span className="text-gray-400 dark:text-gray-500">— {branchState}</span>}
          </span>
        </span>
      </button>
      {open && (
        <div className={`overflow-x-auto px-3 pb-3 pl-9 ${MARKDOWN_CLASS}`}>
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{report.markdown}</ReactMarkdown>
        </div>
      )}
    </li>
  );
};

/** The pure list block — exported so fixture tests never need a fetch. */
export const AfterActionList: React.FC<{ reports: AfterActionWire[]; now?: number }> = ({ reports, now }) => (
  <details open className="group rounded-lg border border-gray-200 dark:border-gray-800">
    <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-3 py-2.5 text-[11px] font-semibold uppercase tracking-widest text-gray-400 hover:text-gray-600 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500 dark:hover:text-gray-200">
      <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
      <FileClock className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="mr-auto">After-action</span>
      <span className="font-normal normal-case text-gray-400">
        {reports.length} report{reports.length === 1 ? '' : 's'}
      </span>
    </summary>
    <ul className="border-t border-gray-100 dark:border-gray-800">
      {reports.map((r) => (
        <AfterActionRow key={r.id} report={r} now={now} />
      ))}
    </ul>
  </details>
);

/** Self-fetching section for TaskDetail: one list fetch per task visit, filtered to this task's
 *  agent ids. Renders nothing while loading, on error, or with zero matches — a post-mortem section
 *  must never add noise to a task that has no post-mortems. */
export const AfterActionSection: React.FC<{ agentIds: string[] }> = ({ agentIds }) => {
  const [all, setAll] = useState<AfterActionWire[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchAfterActions()
      .then((raw) => {
        if (!cancelled) setAll(coerceAfterActions(raw));
      })
      .catch(() => {
        if (!cancelled) setAll([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const reports = useMemo(() => (all ? reportsForAgents(all, agentIds) : []), [all, agentIds]);
  if (reports.length === 0) return null;
  return (
    <div className="mb-6">
      <AfterActionList reports={reports} />
    </div>
  );
};
