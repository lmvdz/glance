/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { LogOut, Building2, Bell, BellOff } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useTaskContext } from '../context/TaskContext';
import { JoinRequests } from './JoinRequests';
import { enablePush, pushPermission } from '../lib/push';

// Compact signed-in identity + sign-out, shown in the workbench header. Renders nothing in file mode
// (no session concept there), so it's inert unless the daemon runs in db mode with a logged-in user.
export const AccountMenu = () => {
  const { me, signOut } = useAuth();
  const { setView, showToast } = useTaskContext();
  const [open, setOpen] = React.useState(false);
  const [pushPerm, setPushPerm] = React.useState<NotificationPermission | 'unsupported'>(() => pushPermission());
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setPushPerm(pushPermission());
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const handleTogglePush = async () => {
    if (pushPerm === 'granted') return;
    const result = await enablePush();
    setPushPerm(pushPermission());
    if (result === 'granted') showToast('Background push enabled', 'success');
    else if (result === 'denied') showToast('Notification permission denied', 'error');
  };

  if (!me) return null;
  const { user, role, activeOrganizationId } = me;
  const label = user.name || user.email;
  const initial = (label.trim()[0] || '?').toUpperCase();

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-6 w-6 items-center justify-center rounded-full bg-ink-border text-caption font-semibold text-ink-text-label transition-colors hover:bg-ink-border-2 focus-visible:ring-2 focus-visible:ring-amber-500 bg-ink-surface text-ink-text-body dark:hover:bg-ink-text-label"
        aria-label="Account menu"
        title={`${label} · ${role}`}
      >
        {user.image ? (
          <img src={user.image} alt="" className="h-6 w-6 rounded-full object-cover" />
        ) : (
          initial
        )}
      </button>

      {open && (
        // Opens UPWARD: the menu's one mount point is the bottom bar of the workbench rail now
        // (GRAPH-FOLD.md §6e — org/settings moved to the gear down there), so a downward panel
        // would render off-viewport.
        <div className="absolute bottom-8 right-0 z-50 w-60 rounded-lg border border-ink-border bg-white p-1 shadow-lg border-ink-border bg-panel">
          <div className="px-3 py-2">
            <div className="truncate text-sm font-medium text-ink-text">{user.name || '—'}</div>
            <div className="truncate text-xs text-ink-text-muted">{user.email}</div>
            <div className="mt-1.5 flex items-center gap-1.5 text-caption text-ink-text-muted">
              <span className="rounded bg-ink-surface px-1.5 py-0.5 font-medium capitalize bg-ink-surface">{role}</span>
              {activeOrganizationId ? (
                <span className="truncate">org {activeOrganizationId.slice(0, 8)}</span>
              ) : (
                <span className="text-amber-600 dark:text-amber-500">no organization</span>
              )}
            </div>
          </div>
          {role === 'admin' && <JoinRequests />}
          <div className="my-1 h-px bg-ink-surface" />
          <button
            onClick={() => {
              setOpen(false);
              setView('org');
            }}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-ink-text-label transition-colors hover:bg-ink-surface text-ink-text-body dark:hover:bg-ink-surface"
          >
            <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
            Organization settings
          </button>
          {pushPerm !== 'unsupported' && (
            <button
              onClick={() => void handleTogglePush()}
              disabled={pushPerm === 'granted'}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-ink-text-label transition-colors hover:bg-ink-surface disabled:cursor-default disabled:opacity-60 text-ink-text-body dark:hover:bg-ink-surface"
            >
              {pushPerm === 'granted' ? (
                <Bell className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <BellOff className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {pushPerm === 'granted' ? 'Background notifications on' : 'Background notifications'}
            </button>
          )}
          <button
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-ink-text-label transition-colors hover:bg-ink-surface text-ink-text-body dark:hover:bg-ink-surface"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
};
