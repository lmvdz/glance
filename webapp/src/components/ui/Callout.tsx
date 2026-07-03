/**
 * Callout — the insight/anomaly banner. The panel's voice: a colored, bordered
 * strip that states a finding and (optionally) offers the one action that
 * resolves it. Used for predictions ("approaching load limit") and anomalies
 * ("Dispatch scanned 6, spawned 0").
 */

import React from 'react';
import { AlertTriangle, AlertOctagon, Info, CheckCircle2 } from 'lucide-react';
import { toneClasses, type Tone } from './tokens';

export interface CalloutProps {
  tone: 'info' | 'warn' | 'critical' | 'success';
  title: React.ReactNode;
  children?: React.ReactNode;
  action?: { label: string; onClick: () => void };
}

const ICONS: Record<CalloutProps['tone'], React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>> = {
  info: Info,
  warn: AlertTriangle,
  critical: AlertOctagon,
  success: CheckCircle2,
};

export const Callout: React.FC<CalloutProps> = ({ tone, title, children, action }) => {
  const t = toneClasses(tone as Tone);
  const Icon = ICONS[tone];
  return (
    <div className={`flex items-start gap-3 rounded-lg border ${t.border} ${t.softBg} px-4 py-3`} role={tone === 'critical' ? 'alert' : 'status'}>
      <Icon className={`mt-0.5 h-4 w-4 flex-shrink-0 ${t.text}`} aria-hidden={true} />
      <div className="min-w-0 flex-1">
        <div className={`text-sm font-semibold ${t.text}`}>{title}</div>
        {children != null && <div className="mt-0.5 text-xs text-gray-600 dark:text-gray-300">{children}</div>}
      </div>
      {action && (
        <button
          onClick={action.onClick}
          className={`flex-shrink-0 rounded-md border ${t.border} bg-white/70 dark:bg-gray-900/50 px-2.5 py-1 text-xs font-medium ${t.text} transition-colors hover:bg-white dark:hover:bg-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500`}
        >
          {action.label}
        </button>
      )}
    </div>
  );
};
