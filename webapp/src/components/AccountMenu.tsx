/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { LogOut, Building2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useTaskContext } from '../context/TaskContext';
import { JoinRequests } from './JoinRequests';

// Compact signed-in identity + sign-out, shown in the workbench header. Renders nothing in file mode
// (no session concept there), so it's inert unless the daemon runs in db mode with a logged-in user.
export const AccountMenu = () => {
  const { me, signOut } = useAuth();
  const { setView } = useTaskContext();
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!me) return null;
  const { user, role, activeOrganizationId } = me;
  const label = user.name || user.email;
  const initial = (label.trim()[0] || '?').toUpperCase();

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-200 text-[11px] font-semibold text-gray-700 transition-colors hover:bg-gray-300 focus-visible:ring-2 focus-visible:ring-amber-500 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
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
        <div className="absolute right-0 top-8 z-50 w-60 rounded-lg border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-800 dark:bg-gray-900">
          <div className="px-3 py-2">
            <div className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{user.name || '—'}</div>
            <div className="truncate text-xs text-gray-500 dark:text-gray-400">{user.email}</div>
            <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
              <span className="rounded bg-gray-100 px-1.5 py-0.5 font-medium capitalize dark:bg-gray-800">{role}</span>
              {activeOrganizationId ? (
                <span className="truncate">org {activeOrganizationId.slice(0, 8)}</span>
              ) : (
                <span className="text-amber-600 dark:text-amber-500">no organization</span>
              )}
            </div>
          </div>
          {role === 'admin' && <JoinRequests />}
          <div className="my-1 h-px bg-gray-100 dark:bg-gray-800" />
          <button
            onClick={() => {
              setOpen(false);
              setView('org');
            }}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
            Organization settings
          </button>
          <button
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
};
