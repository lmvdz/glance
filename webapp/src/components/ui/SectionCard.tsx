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
  <section className="overflow-hidden rounded-lg border border-ink-border bg-panel">
    <header className="flex items-center justify-between gap-2 border-b border-ink-border px-4 py-2.5">
      <h2 className="text-caption font-semibold uppercase tracking-widest text-ink-text-subtle">{title}</h2>
      {right && <div className="flex items-center gap-2 text-xs text-ink-text-subtle">{right}</div>}
    </header>
    {children}
  </section>
);
