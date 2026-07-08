import React from 'react';
import { MonoLabel } from './MonoLabel';

/**
 * PanelSection — a hairline-bordered, boxy panel with a header slot. This is deliberately a
 * SEPARATE primitive from the existing `components/ui/SectionCard` (rounded-xl, shadowed,
 * sans-serif label): the reference UIs' visual language for dense, monospace-forward cockpit
 * screens is flatter and boxier than the rest of glance's dashboard, and forcing one shared
 * component to serve both would either flatten the whole dashboard or round off the cockpit —
 * neither of which the user asked for ("adopt the references' STRUCTURE... keep glance's
 * ember-on-ink identity"). Existing panels keep SectionCard; new kit/cockpit screens use this.
 */
export interface PanelSectionProps {
  title: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}

export const PanelSection: React.FC<PanelSectionProps> = ({ title, right, children, className, bodyClassName }) => (
  <section className={`flex flex-col overflow-hidden rounded-md border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950 ${className ?? ''}`}>
    <header className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-gray-200 px-3 py-1.5 dark:border-gray-800">
      <MonoLabel>{title}</MonoLabel>
      {right != null && <div className="flex-shrink-0 text-[11px] text-gray-400 dark:text-gray-500">{right}</div>}
    </header>
    <div className={`min-h-0 flex-1 ${bodyClassName ?? ''}`}>{children}</div>
  </section>
);
