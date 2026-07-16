/**
 * AdoptCard — one "ad-hoc session detected" row (daily-onramp 06): a raw `claude`/`omp` CLI
 * session running OUTSIDE glance, spotted via the harness-hook presence roster, offered a
 * one-click "Adopt" instead of vanishing from view. Visual grammar mirrors AttentionRow
 * (dot + title/detail + age + single wired action); the dot is amber — detected, not blocking.
 *
 * The action calls back into the owner (WorkspaceCockpit posts `/api/agents/adopt`); a refusal's
 * server `reason` is the owner's to surface verbatim. Adoption captures the session's
 * uncommitted WORK into a fresh gated unit — the developer's checkout stays untouched, which is
 * exactly what the button's title promises.
 */

import React from 'react';
import { Terminal } from 'lucide-react';
import type { AdoptableSession } from '../../lib/adoptPromote';
import { relativeAge } from './time';

export interface AdoptCardProps {
  session: AdoptableSession;
  /** Disable the action while its POST is in flight. */
  busy?: boolean;
  onAdopt: (session: AdoptableSession) => void;
}

/** Session ids are long (UUIDs) — keep the head, which is what disambiguates side-by-side cards. */
const shortSessionId = (id: string) => (id.length > 10 ? `${id.slice(0, 8)}…` : id);

export const AdoptCard: React.FC<AdoptCardProps> = ({ session, busy, onAdopt }) => {
  const age = relativeAge(session.heartbeat);
  return (
    <div className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/40" data-adopt-card>
      <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Terminal className="h-3 w-3 flex-shrink-0 text-gray-400" aria-hidden="true" />
          <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100" title={session.label}>
            {session.harness} session <span className="font-mono text-xs text-gray-500 dark:text-gray-400">{shortSessionId(session.sessionId)}</span>
          </span>
          {age && <span className="flex-shrink-0 text-[10px] tabular-nums text-gray-400">{age}</span>}
        </div>
        <div className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400" title={session.cwd}>
          {session.repoName}
          {session.branch ? ` · ${session.branch}` : ''} · running outside glance
        </div>
      </div>
      <button
        type="button"
        onClick={() => onAdopt(session)}
        disabled={busy}
        title="Capture this session's uncommitted work into a fresh gated unit — the original checkout stays untouched"
        className="flex-shrink-0 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-900/40"
        aria-label={`Adopt ${session.label} into glance`}
      >
        {busy ? 'Adopting…' : 'Adopt'}
      </button>
    </div>
  );
};
