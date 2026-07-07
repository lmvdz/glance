/**
 * AttentionRow — one row in the "Needs you" list: a severity dot, a title +
 * detail, an age label, and the single wired action that resolves it. The visual
 * unit of the reference Attention panel; the other panels reuse it for their
 * own "needs you" sub-lists.
 */

import React from 'react';
import type { AttentionItem } from '../../lib/insights';
import { toneClasses } from './tokens';
import { relativeAge } from './time';

export interface AttentionRowProps {
  item: AttentionItem;
  onAction?: (item: AttentionItem) => void;
  /** Open the full step-in surface for this row's agent. When set, the title/detail become a button. */
  onOpen?: (item: AttentionItem) => void;
  /** disable the action button while its command is in flight. */
  busy?: boolean;
}

const SEVERITY_TONE = {
  critical: 'critical',
  warn: 'warn',
  ok: 'success',
} as const;

export const AttentionRow: React.FC<AttentionRowProps> = ({ item, onAction, onOpen, busy }) => {
  const t = toneClasses(SEVERITY_TONE[item.severity]);
  const age = relativeAge(item.since);
  // Only rows tied to a concrete agent can be stepped into; capacity/collision rows can't.
  const canOpen = !!onOpen && !!item.agentId;

  const body = (
    <>
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{item.title}</span>
        {age && <span className="flex-shrink-0 text-[10px] tabular-nums text-gray-400">{age}</span>}
      </div>
      {item.detail && <div className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400" title={item.detail}>{item.detail}</div>}
    </>
  );

  return (
    <div className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/40">
      <span className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${t.dot}`} aria-hidden="true" />
      {canOpen ? (
        <button onClick={() => onOpen?.(item)} className="min-w-0 flex-1 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500" aria-label={`Step into ${item.title}`}>
          {body}
        </button>
      ) : (
        <div className="min-w-0 flex-1">{body}</div>
      )}
      {item.action && (
        <button
          onClick={() => onAction?.(item)}
          disabled={busy}
          className={`flex-shrink-0 rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-50 ${t.border} ${t.softBg} ${t.text} hover:brightness-95`}
          aria-label={`${item.action.label}: ${item.title}`}
        >
          {busy ? '…' : item.action.label}
        </button>
      )}
    </div>
  );
};
