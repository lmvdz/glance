import React from 'react';
import type { Task } from '../types';


function formatWhen(ts?: number): string {
  return ts ? new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never';
}

/** A plan-reviser's edit deliberately stays uncommitted — plan revisions land only via a majority
 *  vote of the plan's assignees (a separate, incoming feature owns that commit step), never
 *  auto-committed on completion. The raw wire state name "candidate" reads as jargon here; "pending
 *  review" is the honest plain-language label for the same fact — this row exists specifically so a
 *  completed plan-reviser turn is legible as "plan updated, awaiting review" instead of nothing (the
 *  per-agent Land/Changes tab is correctly empty for this agent: there's no git-merge landing step to
 *  show, the doc edit isn't a mergeable branch — this candidates list is the real surface for it). */
function candidateStateLabel(state: string): string {
  return state === 'candidate' ? 'pending review' : state;
}

export function ProofProvenancePanel({ task }: { task: Task }) {
  const data = task.proofProvenance;
  if (!data) return null;
  const proof = data.proof;
  const readiness = data.readiness;
  const proofState = proof?.failed ? 'failed' : proof?.stale ? 'stale' : proof?.fresh ? 'fresh' : 'none';

  return (
    <section aria-label="Proof and provenance" className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-950">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Proof & provenance</h2>
        {readiness && <span className="rounded-full bg-gray-100 px-2 py-1 text-xs font-semibold text-gray-700 dark:bg-gray-900 dark:text-gray-200">{readiness.state.replace(/-/g, ' ')}</span>}
      </div>
      <dl className="space-y-3 text-sm">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">Canon source</dt>
          <dd className="mt-1 text-gray-900 dark:text-gray-100">{data.source.label}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">Proof</dt>
          <dd className="mt-1 text-gray-900 dark:text-gray-100">{proofState} · fresh {proof?.fresh ?? 0} / failed {proof?.failed ?? 0} / stale {proof?.stale ?? 0} / none {proof?.none ?? 0} · ran {formatWhen(proof?.latestRanAt)} · {proof?.artifacts ?? 0} artifacts</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">Next action</dt>
          <dd className="mt-1 text-gray-900 dark:text-gray-100">{readiness?.nextAction ?? 'Inspect candidate work.'}</dd>
        </div>
      </dl>
      {data.worktrees.length > 0 && (
        <div className="mt-4 space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Candidate worktrees</h3>
          {data.worktrees.map((wt) => (
            <div key={`${wt.worktree}:${wt.branch ?? ''}`} className="rounded-lg bg-gray-50 p-2 text-xs text-gray-700 dark:bg-gray-900 dark:text-gray-300">
              <div className="font-medium text-gray-900 dark:text-gray-100">{wt.agentName ?? wt.agentId ?? wt.branch ?? 'candidate'}</div>
              <div>{wt.branch ?? 'no branch'} · {wt.changedFiles} files · ahead {wt.ahead} / behind {wt.behind} · {wt.readiness} · proof {wt.proof?.state ?? 'none'}</div>
            </div>
          ))}
        </div>
      )}
      {data.candidates.length > 0 && (
        <div className="mt-4 space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Plan revision candidates</h3>
          {data.candidates.map((candidate) => (
            <div key={candidate.id} className="rounded-lg bg-blue-50 p-2 text-xs text-blue-900 dark:bg-blue-950/40 dark:text-blue-100">
              <div className="font-medium">{candidate.summary}</div>
              <div>{candidate.planPath} · {candidateStateLabel(candidate.state)}{candidate.producerAgentId ? ` · ${candidate.producerAgentId}` : ''}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
