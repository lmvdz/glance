/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Loader2, Check, X, Trash2, Building2, UserPlus, ShieldCheck, Mic } from 'lucide-react';
import {
  apiJson,
  jsonInit,
  getOrgVoiceStatus,
  putOrgVoiceKey,
  deleteOrgVoiceKey,
  setOrgVoiceEnabled,
  type VoiceKeyStatus,
} from '../lib/api';
import { useAuth } from '../context/AuthContext';

interface OrgProfile {
  id: string;
  name: string;
  slug: string;
  memberCount: number;
  workosOrgId: string | null;
  personal: boolean;
}
interface Member { userId: string; name: string; email: string; role: string }
interface JoinReq { id: string; userId: string; email: string; createdAt: number }

const card = 'rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900';

export const OrgSettings = () => {
  const { me } = useAuth();
  const isAdmin = me?.role === 'admin';
  const selfId = me?.user.id;

  const [org, setOrg] = React.useState<OrgProfile | null>(null);
  const [members, setMembers] = React.useState<Member[]>([]);
  const [requests, setRequests] = React.useState<JoinReq[]>([]);
  const [name, setName] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [savingName, setSavingName] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = React.useState('');
  const [inviteRole, setInviteRole] = React.useState('member');
  const [inviting, setInviting] = React.useState(false);
  const [joinPolicy, setJoinPolicy] = React.useState<'auto' | 'approval' | null>(null);
  const [voice, setVoice] = React.useState<VoiceKeyStatus | null>(null);
  const [voiceKey, setVoiceKey] = React.useState('');
  const [savingVoice, setSavingVoice] = React.useState(false);
  const [voiceBusy, setVoiceBusy] = React.useState(false);
  const [voiceErr, setVoiceErr] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const p = await apiJson<OrgProfile | null>('/api/org');
      setOrg(p);
      setName(p?.name ?? '');
      if (p && isAdmin) {
        setMembers(await apiJson<Member[]>('/api/org/members').catch(() => []));
        setRequests(await apiJson<JoinReq[]>('/api/workos/join-requests').catch(() => []));
        if (p.workosOrgId) setJoinPolicy((await apiJson<{ policy: 'auto' | 'approval' | null }>('/api/org/join-policy').catch(() => ({ policy: null }))).policy);
        // Admin-tier only; a non-admin GET 403s, so members never fetch it (they see a read-only line).
        setVoice(await getOrgVoiceStatus().catch(() => ({ configured: false })));
      }
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const saveName = async () => {
    if (!name.trim() || name === org?.name) return;
    setSavingName(true);
    setErr(null);
    try {
      const r = await apiJson<{ ok: boolean }>('/api/org', jsonInit('PATCH', { name: name.trim() }));
      if (r.ok) setOrg((o) => (o ? { ...o, name: name.trim() } : o));
      else setErr('Could not rename the organization.');
    } finally {
      setSavingName(false);
    }
  };

  const changeRole = async (userId: string, role: string) => {
    setErr(null);
    const r = await apiJson<{ ok: boolean; error?: string }>('/api/org/members/role', jsonInit('POST', { userId, role }));
    if (r.ok) setMembers((ms) => ms.map((m) => (m.userId === userId ? { ...m, role } : m)));
    else setErr(r.error ?? 'Could not change role.');
  };

  const removeMember = async (userId: string) => {
    setErr(null);
    const r = await apiJson<{ ok: boolean; error?: string }>('/api/org/members/remove', jsonInit('POST', { userId }));
    if (r.ok) setMembers((ms) => ms.filter((m) => m.userId !== userId));
    else setErr(r.error ?? 'Could not remove member.');
  };

  const decide = async (id: string, action: 'approve' | 'deny') => {
    await apiJson('/api/workos/join-requests/decide', jsonInit('POST', { id, action })).catch(() => {});
    setRequests((rs) => rs.filter((r) => r.id !== id));
    if (action === 'approve') void load();
  };

  const invite = async () => {
    if (!inviteEmail.trim() || inviting) return;
    setInviting(true);
    setErr(null);
    try {
      const r = await apiJson<{ ok: boolean; error?: string }>('/api/org/members/invite', jsonInit('POST', { email: inviteEmail.trim(), role: inviteRole }));
      if (r.ok) {
        setInviteEmail('');
        setMembers(await apiJson<Member[]>('/api/org/members').catch(() => members));
      } else setErr(r.error ?? 'Could not add member.');
    } finally {
      setInviting(false);
    }
  };

  const setPolicy = async (policy: 'auto' | 'approval') => {
    setJoinPolicy(policy); // optimistic
    const r = await apiJson<{ ok: boolean }>('/api/org/join-policy', jsonInit('POST', { policy })).catch(() => ({ ok: false }));
    if (!r.ok) {
      setErr('Could not update the join policy.');
      void load();
    }
  };

  const saveVoiceKey = async () => {
    const candidate = voiceKey.trim();
    if (!candidate || savingVoice) return;
    setSavingVoice(true);
    setVoiceErr(null);
    try {
      // The server verifies the key before persisting; a rejected key throws with its message and the
      // card stays in "not configured" (setVoice is only reached on success).
      setVoice(await putOrgVoiceKey(candidate));
      setVoiceKey('');
    } catch (e) {
      setVoiceErr(e instanceof Error && e.message ? e.message : 'That key was rejected.');
    } finally {
      setSavingVoice(false);
    }
  };

  const toggleVoiceEnabled = async () => {
    if (!voice?.configured || voiceBusy) return;
    setVoiceBusy(true);
    setVoiceErr(null);
    try {
      setVoice(await setOrgVoiceEnabled(!voice.enabled));
    } catch (e) {
      setVoiceErr(e instanceof Error && e.message ? e.message : 'Could not update voice.');
    } finally {
      setVoiceBusy(false);
    }
  };

  const removeVoiceKey = async () => {
    if (!voice?.configured || voiceBusy) return;
    setVoiceBusy(true);
    setVoiceErr(null);
    try {
      setVoice(await deleteOrgVoiceKey());
    } catch (e) {
      setVoiceErr(e instanceof Error && e.message ? e.message : 'Could not remove the key.');
    } finally {
      setVoiceBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-gray-400">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (!org) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-gray-500 dark:text-gray-400">
        <Building2 className="h-6 w-6" />
        <p className="text-sm">You’re not part of an organization yet.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-[#f7f8f9] px-6 py-8 dark:bg-gray-950">
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-6 flex items-center gap-2">
          <Building2 className="h-5 w-5 text-gray-500 dark:text-gray-400" />
          <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Organization settings</h1>
          {org.personal && <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400">personal workspace</span>}
        </div>

        {err && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300" role="alert">
            {err}
          </div>
        )}

        {/* Profile */}
        <section className={`${card} mb-5 p-4`}>
          <h2 className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">Profile</h2>
          <label className="mb-1.5 block text-xs font-medium text-gray-500 dark:text-gray-400">Name</label>
          <div className="flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-[#f0a35a] focus:ring-2 focus:ring-[#f0a35a]/20 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
              value={name}
              disabled={!isAdmin}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
            />
            {isAdmin && (
              <button
                onClick={() => void saveName()}
                disabled={savingName || !name.trim() || name === org.name}
                className="flex items-center rounded-md bg-gray-900 px-4 text-sm font-medium text-white transition-colors hover:bg-gray-700 disabled:opacity-40 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
              >
                {savingName ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
              </button>
            )}
          </div>
          <p className="mt-2 text-xs text-gray-400">{org.memberCount} member{org.memberCount === 1 ? '' : 's'}{org.workosOrgId ? ' · enterprise (WorkOS)' : ''}</p>
        </section>

        {!isAdmin && (
          <>
            <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">Only organization admins can manage members.</p>
            <VoiceKeyCard
              isAdmin={false}
              status={null}
              keyInput=""
              onKeyInput={() => {}}
              onSave={() => {}}
              saving={false}
              onToggleEnabled={() => {}}
              onRemove={() => {}}
              busy={false}
              error={null}
            />
          </>
        )}

        {isAdmin && (
          <>
            <VoiceKeyCard
              isAdmin
              status={voice}
              keyInput={voiceKey}
              onKeyInput={setVoiceKey}
              onSave={saveVoiceKey}
              saving={savingVoice}
              onToggleEnabled={toggleVoiceEnabled}
              onRemove={removeVoiceKey}
              busy={voiceBusy}
              error={voiceErr}
            />

            {/* Domain-join policy (WorkOS-backed orgs) */}
            {joinPolicy !== null && (
              <section className={`${card} mb-5 p-4`}>
                <h2 className="mb-1 text-sm font-semibold text-gray-900 dark:text-gray-100">Domain join</h2>
                <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">How people with a verified company email domain join this organization.</p>
                <div className="inline-flex rounded-md border border-gray-200 p-0.5 dark:border-gray-800">
                  {(['approval', 'auto'] as const).map((p) => (
                    <button
                      key={p}
                      onClick={() => void setPolicy(p)}
                      className={`rounded px-3 py-1 text-xs font-medium transition-colors ${joinPolicy === p ? 'bg-[#f0a35a] text-black' : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'}`}
                    >
                      {p === 'approval' ? 'Require approval' : 'Auto-join'}
                    </button>
                  ))}
                </div>
              </section>
            )}

            {/* Pending join requests */}
            {requests.length > 0 && (
              <section className={`${card} mb-5 p-4`}>
                <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
                  <UserPlus className="h-4 w-4" /> Join requests
                  <span className="rounded bg-gray-100 px-1.5 text-[11px] font-mono dark:bg-gray-800">{requests.length}</span>
                </h2>
                <ul className="flex flex-col gap-1.5">
                  {requests.map((r) => (
                    <li key={r.id} className="flex items-center gap-2 text-sm">
                      <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-200">{r.email}</span>
                      <button onClick={() => void decide(r.id, 'approve')} className="flex h-7 items-center gap-1 rounded-md bg-emerald-600 px-2.5 text-xs font-medium text-white hover:bg-emerald-500" title="Approve">
                        <Check className="h-3.5 w-3.5" /> Approve
                      </button>
                      <button onClick={() => void decide(r.id, 'deny')} className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800" aria-label="Deny" title="Deny">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Members */}
            <section className={`${card} p-4`}>
              <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
                <ShieldCheck className="h-4 w-4" /> Members
              </h2>
              {/* Invite by email */}
              <form
                onSubmit={(e) => { e.preventDefault(); void invite(); }}
                className="mb-3 flex gap-2"
              >
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="teammate@company.com"
                  className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 outline-none focus:border-[#f0a35a] focus:ring-2 focus:ring-[#f0a35a]/20 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                  aria-label="Invite by email"
                />
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                  className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-700 outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
                  aria-label="Invite role"
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
                <button
                  type="submit"
                  disabled={inviting || !inviteEmail.trim()}
                  className="flex items-center gap-1.5 rounded-md bg-[#f0a35a] px-3 py-1.5 text-xs font-semibold text-black transition-colors hover:bg-[#e89440] disabled:opacity-40"
                >
                  {inviting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><UserPlus className="h-3.5 w-3.5" /> Add</>}
                </button>
              </form>
              <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                {members.map((m) => {
                  const isSelf = m.userId === selfId;
                  return (
                    <li key={m.userId} className="flex items-center gap-3 py-2.5">
                      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gray-200 text-xs font-semibold text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                        {(m.name || m.email).trim().charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                          {m.name || m.email} {isSelf && <span className="text-xs font-normal text-gray-400">(you)</span>}
                        </div>
                        <div className="truncate text-xs text-gray-500 dark:text-gray-400">{m.email}</div>
                      </div>
                      <select
                        className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 outline-none focus:border-[#f0a35a] disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
                        value={m.role === 'owner' ? 'admin' : m.role}
                        disabled={isSelf}
                        onChange={(e) => void changeRole(m.userId, e.target.value)}
                        aria-label={`Role for ${m.email}`}
                      >
                        <option value="admin">Admin</option>
                        <option value="member">Member</option>
                      </select>
                      <button
                        onClick={() => void removeMember(m.userId)}
                        disabled={isSelf}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-30 dark:hover:bg-red-950/40"
                        aria-label={`Remove ${m.email}`}
                        title={isSelf ? "You can't remove yourself" : 'Remove member'}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          </>
        )}
      </div>
    </div>
  );
};

function fmtWhen(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

interface VoiceKeyCardProps {
  isAdmin: boolean;
  /** Session-org status, or `null` for a non-admin (who never fetches it). */
  status: VoiceKeyStatus | null;
  keyInput: string;
  onKeyInput: (value: string) => void;
  onSave: () => void;
  saving: boolean;
  onToggleEnabled: () => void;
  onRemove: () => void;
  busy: boolean;
  error: string | null;
}

/**
 * The org voice-key card. Kept a pure, prop-driven component (like `TaskProperties`' `CategoryChip`)
 * so its three honest states SSR-render standalone in the test suite without an `AuthProvider` stack.
 *
 * The funding + attribution copy is load-bearing, not decoration: enabling voice spends every
 * operator-tier member's dispatches on the org's own OpenAI key, and glance can only ever show *who*
 * started a session — never *what it cost* (audio never transits the daemon). No dollar figure appears
 * anywhere in this card by design; the honest daemon-side controls live on the OpenAI dashboard.
 */
export const VoiceKeyCard = ({
  isAdmin,
  status,
  keyInput,
  onKeyInput,
  onSave,
  saving,
  onToggleEnabled,
  onRemove,
  busy,
  error,
}: VoiceKeyCardProps) => {
  const alert = error ? (
    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300" role="alert">
      {error}
    </div>
  ) : null;

  return (
    <section className={`${card} mb-5 p-4`}>
      <h2 className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
        <Mic className="h-4 w-4" /> Voice
      </h2>
      <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
        Enabling voice funds every operator-tier member’s voice sessions — including the agents they spawn
        against this organization’s repositories — on this organization’s own OpenAI key. glance can show you
        who started a session, never what it spent: audio never passes through the daemon.
      </p>

      {!isAdmin ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">Voice is configured by an organization admin.</p>
      ) : status?.configured ? (
        <div className="space-y-3">
          <div>
            <div className="text-sm text-gray-700 dark:text-gray-200">
              Key ending in <span className="font-mono">{status.last4}</span> — check this matches your OpenAI key when you rotate it.
            </div>
            <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              Set by {status.updatedBy ?? 'an admin'}{status.updatedAt ? ` · ${fmtWhen(status.updatedAt)}` : ''}
            </div>
          </div>
          {status.enabled === false && (
            <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
              Voice is turned off for this organization. The key is still stored — enable it to allow calls again.
            </p>
          )}
          {alert}
          <div className="flex gap-2">
            {/* Kill switch — reversible, keeps the key. Deliberately styled as a neutral toggle so it
                cannot be mistaken for the destructive Remove beside it. */}
            <button
              onClick={() => onToggleEnabled()}
              disabled={busy}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
              aria-label={status.enabled === false ? 'Enable voice' : 'Disable voice'}
            >
              {status.enabled === false ? 'Enable' : 'Disable'}
            </button>
            {/* Destructive — forgets the key entirely (a re-paste is needed to restore voice). */}
            <button
              onClick={() => onRemove()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-40 dark:text-red-400 dark:hover:bg-red-950/40"
              aria-label="Remove voice key"
            >
              <Trash2 className="h-3.5 w-3.5" /> Remove key
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <label htmlFor="voice-key" className="block text-xs font-medium text-gray-500 dark:text-gray-400">
            OpenAI API key
          </label>
          {alert}
          <div className="flex gap-2">
            <input
              id="voice-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={keyInput}
              onChange={(e) => onKeyInput(e.target.value)}
              placeholder="sk-…"
              className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-[#f0a35a] focus:ring-2 focus:ring-[#f0a35a]/20 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
            />
            <button
              onClick={() => onSave()}
              disabled={saving || !keyInput.trim()}
              className="flex items-center rounded-md bg-gray-900 px-4 text-sm font-medium text-white transition-colors hover:bg-gray-700 disabled:opacity-40 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
            </button>
          </div>
          <p className="text-xs text-gray-400">
            The key is verified with OpenAI before it’s saved, then stored encrypted. It goes to the daemon and nowhere else.
          </p>
        </div>
      )}
    </section>
  );
};
