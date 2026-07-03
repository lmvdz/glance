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
  /** disable the action button while its command is in flight. */
  busy?: boolean;
}

const SEVERITY_TONE = {
  critical: 'critical',
  warn: 'warn',
  ok: 'success',
} as const;

export const AttentionRow: React.FC<AttentionRowProps> = ({ item, onAction, busy }) => {
  const t = toneClasses(SEVERITY_TONE[item.severity]);
  const age = relativeAge(item.since);

  return (
    <div className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/40">
      <span className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${t.dot}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{item.title}</span>
          {age && <span className="flex-shrink-0 text-[10px] tabular-nums text-gray-400">{age}</span>}
        </div>
        {item.detail && <div className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400" title={item.detail}>{item.detail}</div>}
      </div>
      {item.action && (
        <button
          onClick={() => onAction?.(item)}
          disabled={busy}
          className={`flex-shrink-0 rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 ${t.border} ${t.softBg} ${t.text} hover:brightness-95`}
          aria-label={`${item.action.label}: ${item.title}`}
        >
          {busy ? '…' : item.action.label}
        </button>
      )}
    </div>
  );
};
