import React from 'react';

/**
 * DiffStat — the reference UIs' `+312 -332` chip (workspace/roster rows, PR rail). Reuses the
 * app's existing emerald/red semantic ramp (VerdictBadge, agent-badges.ts) rather than inventing
 * new colors — green additions, red deletions is already how this codebase reads a diff.
 */
export interface DiffStatProps {
  added: number;
  removed: number;
  className?: string;
}

export const DiffStat: React.FC<DiffStatProps> = ({ added, removed, className }) => {
  if (!added && !removed) {
    return <span className={`font-mono text-[11px] text-gray-400 dark:text-gray-600 ${className ?? ''}`}>—</span>;
  }
  return (
    <span
      className={`inline-flex flex-shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums ${className ?? ''}`}
      aria-label={`${added} added, ${removed} removed`}
      title={`+${added} -${removed}`}
    >
      {added > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>}
      {removed > 0 && <span className="text-red-500 dark:text-red-400">-{removed}</span>}
    </span>
  );
};
