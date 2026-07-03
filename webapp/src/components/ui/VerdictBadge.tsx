/**
 * VerdictBadge — a colored pill with a status dot that states the posture in one
 * glance. The dashboard's primary "lead with a verdict" affordance.
 */

import React from 'react';
import { toneClasses, type ToneLike } from './tokens';

export interface VerdictBadgeProps {
  verdict: 'healthy' | 'warn' | 'critical' | 'ok';
  children: React.ReactNode;
}

export const VerdictBadge: React.FC<VerdictBadgeProps> = ({ verdict, children }) => {
  const t = toneClasses(verdict as ToneLike);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${t.pillBg} ${t.pillText}`}
      role="status"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} aria-hidden="true" />
      {children}
    </span>
  );
};
