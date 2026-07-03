/**
 * PanelShell — the one wrapper EVERY dashboard panel uses.
 *
 * Owns the shared <main> + sticky header + scrolling body so the four panels
 * (and this reference one) are visually identical down to the pixel. Matches the
 * established AutomationPanel idiom exactly; panels supply only an icon, title,
 * optional subtitle/actions, and their body.
 */

import React from 'react';

export interface PanelShellProps {
  /** Lead icon (a lucide element), already colored by the caller. */
  icon: React.ReactNode;
  title: string;
  /** Optional sub-line under the title — often the verdict sentence. */
  subtitle?: React.ReactNode;
  /** Header right-side controls (refresh, filters, …). */
  actions?: React.ReactNode;
  children: React.ReactNode;
}

export const PanelShell: React.FC<PanelShellProps> = ({ icon, title, subtitle, actions, children }) => (
  <main className="flex-1 flex flex-col h-full overflow-hidden bg-white dark:bg-gray-950 transition-colors duration-200">
    <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-800 px-5 py-3 flex-shrink-0 bg-white dark:bg-gray-950">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="flex-shrink-0" aria-hidden="true">
          {icon}
        </span>
        <div className="min-w-0">
          <h1 className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">{title}</h1>
          {subtitle != null && <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{subtitle}</div>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
    </div>

    <div className="flex-1 overflow-y-auto p-5 scrollbar-custom space-y-4">{children}</div>
  </main>
);
