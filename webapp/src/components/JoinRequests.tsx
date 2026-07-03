/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Check, X, UserPlus } from 'lucide-react';
import { apiFetch, apiJson, jsonInit } from '../lib/api';

interface PendingRequest {
  id: string;
  userId: string;
  email: string;
  createdAt: number;
}

// Admin-only: pending domain-match join requests for the active org ("require approval" policy). Renders
// nothing when there are none. Shown inside the account menu.
export const JoinRequests = () => {
  const [reqs, setReqs] = React.useState<PendingRequest[]>([]);
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setReqs(await apiJson<PendingRequest[]>('/api/workos/join-requests'));
    } catch {
      setReqs([]);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const decide = async (id: string, action: 'approve' | 'deny') => {
    setBusy(id);
    try {
      await apiFetch('/api/workos/join-requests/decide', jsonInit('POST', { id, action }));
      setReqs((rs) => rs.filter((r) => r.id !== id));
    } finally {
      setBusy(null);
    }
  };

  if (reqs.length === 0) return null;

  return (
    <div className="border-t border-gray-100 px-3 py-2 dark:border-gray-800">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-gray-500 dark:text-gray-400">
        <UserPlus className="h-3 w-3" aria-hidden="true" />
        Join requests
        <span className="rounded bg-gray-100 px-1 font-mono dark:bg-gray-800">{reqs.length}</span>
      </div>
      <div className="flex flex-col gap-1">
        {reqs.map((r) => (
          <div key={r.id} className="flex items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-200" title={r.email}>
              {r.email}
            </span>
            <button
              onClick={() => void decide(r.id, 'approve')}
              disabled={busy === r.id}
              className="flex h-6 w-6 items-center justify-center rounded text-emerald-600 transition-colors hover:bg-emerald-50 disabled:opacity-50 dark:text-emerald-400 dark:hover:bg-emerald-950/40"
              aria-label={`Approve ${r.email}`}
              title="Approve"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => void decide(r.id, 'deny')}
              disabled={busy === r.id}
              className="flex h-6 w-6 items-center justify-center rounded text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50 dark:hover:bg-gray-800 dark:hover:text-gray-300"
              aria-label={`Deny ${r.email}`}
              title="Deny"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};
