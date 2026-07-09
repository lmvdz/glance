import React from 'react';
import { Users } from 'lucide-react';
import { apiJson, jsonInit } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { StatusChip } from './kit';

/**
 * AssigneesEditor — the human "who owns this feature" control, and the substrate for plan voting
 * (a later vote is majority-of-all-assignees). Self-contained: it fetches the feature's assignees
 * (GET /api/features/:id/assignees) and, in DB mode for an admin, the org roster (GET
 * /api/org/members), so it can be dropped anywhere in the task view with just `featureId` + `repo`.
 *
 * MODE SHAPES (matches the backend's mode-aware validation):
 *   - DB mode, admin  → an org-member multi-select: toggle members on/off, PUTs the new set.
 *   - DB mode, viewer → read-only human chips (the picker + PUT are admin-only server-side).
 *   - File mode       → the single operator identity, read-only, with a note that multi-user
 *                       voting needs DB mode.
 *
 * Kit-consistent: member chips use StatusChip's `human` tone (the cool-blue "this is a person, not
 * an agent" species color); the active toggle uses the ember/ink accent from the shared kit.
 */

interface OrgMember {
  userId: string;
  name: string;
  email: string;
  role: string;
}

export interface AssigneesEditorProps {
  featureId: string;
  repo?: string;
}

/** `db:<userId>` → `<userId>`; anything else (a file-mode operator id) passes through unchanged. */
function userIdOf(assigneeId: string): string {
  return assigneeId.startsWith('db:') ? assigneeId.slice('db:'.length) : assigneeId;
}

export const AssigneesEditor: React.FC<AssigneesEditorProps> = ({ featureId, repo }) => {
  const { status, me } = useAuth();
  const dbMode = status === 'authed' && !!me;
  const fileMode = status === 'file';
  const isAdmin = me?.role === 'admin';

  const [assignees, setAssignees] = React.useState<string[]>([]);
  const [members, setMembers] = React.useState<OrgMember[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const repoQ = repo ? `?repo=${encodeURIComponent(repo)}` : '';

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const a = await apiJson<{ assignees: string[] }>(
        `/api/features/${encodeURIComponent(featureId)}/assignees${repoQ}`,
      ).catch(() => ({ assignees: [] as string[] }));
      // The member roster is admin-only server-side; a viewer simply gets an empty list and falls
      // back to rendering raw identities (with "You" for self) — no picker.
      const m = dbMode && isAdmin ? await apiJson<OrgMember[]>('/api/org/members').catch(() => []) : [];
      if (cancelled) return;
      setAssignees(a.assignees);
      setMembers(m);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [featureId, repoQ, dbMode, isAdmin]);

  const nameByUserId = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) map.set(m.userId, m.name || m.email || m.userId);
    return map;
  }, [members]);

  const labelFor = React.useCallback(
    (assigneeId: string): string => {
      const uid = userIdOf(assigneeId);
      if (me && uid === me.user.id) return 'You';
      return nameByUserId.get(uid) ?? uid;
    },
    [me, nameByUserId],
  );

  const commit = React.useCallback(
    async (next: string[]) => {
      const prev = assignees;
      setAssignees(next); // optimistic
      setSaving(true);
      setErr(null);
      try {
        const res = await apiJson<{ assignees?: string[] }>(
          `/api/features/${encodeURIComponent(featureId)}/assignees${repoQ}`,
          jsonInit('PUT', { assignees: next }),
        );
        if (res.assignees) setAssignees(res.assignees);
      } catch (e) {
        setAssignees(prev); // revert
        setErr(e instanceof Error ? e.message : 'Could not save assignees.');
      } finally {
        setSaving(false);
      }
    },
    [assignees, featureId, repoQ],
  );

  const toggle = React.useCallback(
    (userId: string) => {
      const id = `db:${userId}`;
      const next = assignees.includes(id) ? assignees.filter((x) => x !== id) : [...assignees, id];
      void commit(next);
    },
    [assignees, commit],
  );

  if (!loaded) return null;

  const header = (
    <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest flex items-center gap-2 mb-3 border-b border-gray-100 dark:border-gray-800 pb-2">
      <Users className="w-3.5 h-3.5" /> Assignees <span className="text-gray-500 font-medium">{assignees.length}</span>
    </div>
  );

  // DB mode, admin → the org-member multi-select.
  if (dbMode && isAdmin) {
    const selected = new Set(assignees.map(userIdOf));
    return (
      <div className="mb-6" data-purpose="assignees-editor" data-mode="db-admin">
        {header}
        <div className="flex flex-wrap gap-1.5">
          {members.map((m) => {
            const on = selected.has(m.userId);
            return (
              <button
                key={m.userId}
                type="button"
                disabled={saving}
                onClick={() => toggle(m.userId)}
                aria-pressed={on}
                title={m.email}
                className={`rounded px-2 py-0.5 text-[11px] font-medium border transition-colors disabled:opacity-60 ${
                  on
                    ? 'border-amber-400/60 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300'
                    : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800'
                }`}
              >
                {me && m.userId === me.user.id ? `${m.name || m.email} (You)` : m.name || m.email}
              </button>
            );
          })}
          {members.length === 0 && <span className="text-gray-400 text-xs italic">No org members.</span>}
        </div>
        {err && (
          <div className="mt-2 text-[11px] text-red-600 dark:text-red-400" role="alert">
            {err}
          </div>
        )}
      </div>
    );
  }

  // DB mode, viewer → read-only human chips (picker is admin-only).
  if (dbMode) {
    return (
      <div className="mb-6" data-purpose="assignees-editor" data-mode="db-viewer">
        {header}
        <div className="flex flex-wrap gap-1.5">
          {assignees.length === 0 ? (
            <span className="text-gray-400 text-xs italic">No assignees.</span>
          ) : (
            assignees.map((id) => <StatusChip key={id} status={labelFor(id)} tone="human" variant="dim" />)
          )}
        </div>
      </div>
    );
  }

  // File mode → the single operator identity, read-only, with the multi-user note.
  if (fileMode) {
    return (
      <div className="mb-6" data-purpose="assignees-editor" data-mode="file">
        {header}
        <div className="flex flex-wrap items-center gap-1.5">
          {assignees.length === 0 ? (
            <span className="text-gray-400 text-xs italic">No assignees.</span>
          ) : (
            assignees.map((id) => <StatusChip key={id} status={labelFor(id)} tone="human" variant="dim" />)
          )}
        </div>
        <div className="mt-2 text-[11px] text-gray-400 dark:text-gray-500">
          Single-operator mode. Multi-user voting needs DB mode.
        </div>
      </div>
    );
  }

  return null;
};
