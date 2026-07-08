import React from 'react';

/**
 * MonoLabel — a small uppercase monospace section label, the reference UIs' "TASKS" /
 * "ARTIFACTS" / "COMMENTS" chrome. glance's existing panels label sections in the UI sans
 * stack; this is the monospace-forward alternative the cockpit/kit screens use instead
 * (brand.md already names JetBrains Mono for "code, ids, counts, timestamps" — section
 * furniture in a dense, data-forward screen is the same register).
 */
export const MonoLabel: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <span className={`font-mono text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500 ${className ?? ''}`}>
    {children}
  </span>
);
