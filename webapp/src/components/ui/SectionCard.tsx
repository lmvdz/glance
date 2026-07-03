/**
 * SectionCard — bordered card with an uppercase-tracked header (the exact header
 * style the legacy panels already use), plus an optional right slot for counts or
 * controls. The standard container for any grouped list/table in a panel.
 */

import React from 'react';

export interface SectionCardProps {
  title: React.ReactNode;
  /** right-aligned header slot (a count chip, a filter, …). */
  right?: React.ReactNode;
  children: React.ReactNode;
}

export const SectionCard: React.FC<SectionCardProps> = ({ title, right, children }) => (
  <section className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
    <header className="flex items-center justify-between gap-2 border-b border-gray-100 dark:border-gray-800 px-4 py-2.5">
      <h2 className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">{title}</h2>
      {right && <div className="flex items-center gap-2 text-xs text-gray-400">{right}</div>}
    </header>
    {children}
  </section>
);
