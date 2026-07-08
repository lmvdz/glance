import React from 'react';
import { ExternalLink, GitMerge } from 'lucide-react';
import { StatusChip } from '../kit/StatusChip';
import { AgentMetaBar, AgentLandControls } from './AgentMetaBar';
import { spawnCardStatus, type SpawnedUnitRecord } from '../../lib/spawnProposal';
import type { AgentDTO } from '../../lib/dto';
import type { ToastTone } from '../../lib/agent-control';

/**
 * Feature 2 D3 — LINK-BACK. Pinned in the chat thread once a spawn is confirmed, tracking
 * RUNNING→verify→draft-PR live (re-derives its status from the live `agents` roster every render —
 * see `spawnCardStatus`'s doc for why nothing here is cached). "View run" hands off to the existing
 * console (`openConsole`), where the full `AgentMetaBar`/Composer stop control lives — this is the
 * "instantly visible + killable" half of the trust boundary (D5): a mistaken spawn is one click from
 * its live transcript and its Stop button, never buried.
 */
export const SpawnStatusCard = ({
  record,
  agent,
  showToast,
  onViewRun,
}: {
  record: SpawnedUnitRecord;
  agent: AgentDTO | undefined;
  showToast: (message: string, type?: ToastTone) => void;
  onViewRun: () => void;
}) => {
  const derived = spawnCardStatus(agent);
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-950"
      data-spawn-status-card
      aria-label={`Spawned unit ${agent?.name ?? record.agentId}`}
    >
      <div className="flex items-center gap-2">
        <StatusChip status={derived.status} tone={derived.tone} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-gray-800 dark:text-gray-200">{agent?.name ?? record.agentId}</span>
        <span className="flex-shrink-0 text-[10px] text-gray-400 dark:text-gray-500">{new Date(record.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <p className="text-[11px] text-gray-500 dark:text-gray-400">{derived.detail}</p>
      {agent && <AgentMetaBar agent={agent}><AgentLandControls agent={agent} showToast={showToast} /></AgentMetaBar>}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onViewRun}
          disabled={!agent}
          className="flex min-h-7 items-center gap-1 rounded-full border border-gray-200 px-2.5 text-[11px] font-medium text-gray-600 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          <ExternalLink className="h-3 w-3" aria-hidden />
          View run
        </button>
        {agent?.prUrl && (
          <a
            href={agent.prUrl}
            target="_blank"
            rel="noreferrer"
            className="flex min-h-7 items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2.5 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-900/40"
          >
            <GitMerge className="h-3 w-3" aria-hidden />
            Open PR #{agent.prNumber}
          </a>
        )}
      </div>
    </div>
  );
};
