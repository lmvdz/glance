import React from 'react';
import { apiJson, deleteOrgVoiceKey, jsonInit, putOrgVoiceKey, setOrgVoiceEnabled, type VoiceKeyStatus } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { RULES_ARE_NEVER_MERGED, inviteConsequence, joinPolicyLine, outboundKeyLine, whatTheirWordDoes, type RoomMember } from '../../lib/roomPeople';

/**
 * PeopleSurface — who is in this room, and what each of them can settle.
 *
 * `05-first-week.html` refuses to have a settings page for this. Its line is *"one conversation, two
 * humans, and every instruction carries the name of whoever gave it"*, and its law is *"Rules are
 * never merged into house policy, because then they stop being anybody's words."*
 *
 * A settings screen turns people into rows with a role dropdown. Whether someone can approve a land is
 * not a permission flag — it is the reason an agent held a failing test this morning. So each member
 * is described by what their instructions DO to the fleet, an invitation states what the invited
 * person will be able to settle before it is sent, and the join policy is a sentence rather than a
 * radio pair.
 */

const MONO = "'JetBrains Mono',ui-monospace,monospace";

interface OrgProfile { id: string; name: string; slug: string; memberCount: number; workosOrgId: string | null; personal: boolean }
interface JoinReq { id: string; userId: string; email: string; createdAt: number }

function Zone({ label, tone, children }: { label: string; tone?: string; children: React.ReactNode }) {
  return (
    <div className="mt-8" style={{ borderTop: '1px solid #1F1F22', paddingTop: 22 }}>
      <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: tone ?? '#5A5A61' }}>{label}</div>
      <div className="mt-2.5">{children}</div>
    </div>
  );
}

export function PeopleSurface() {
  const { me } = useAuth();
  const [org, setOrg] = React.useState<OrgProfile | null>(null);
  const [members, setMembers] = React.useState<RoomMember[]>([]);
  const [requests, setRequests] = React.useState<JoinReq[]>([]);
  const [policy, setPolicy] = React.useState<'auto' | 'approval' | null>(null);
  const [voice, setVoice] = React.useState<VoiceKeyStatus | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState('');
  const [inviteEmail, setInviteEmail] = React.useState('');
  const [inviteRole, setInviteRole] = React.useState<'member' | 'admin'>('member');
  const [notice, setNotice] = React.useState('');

  const reload = React.useCallback(async () => {
    try {
      const profile = await apiJson<OrgProfile | null>('/api/org');
      setOrg(profile);
      if (profile) {
        setMembers(await apiJson<RoomMember[]>('/api/org/members').catch(() => []));
        setRequests(await apiJson<JoinReq[]>('/api/workos/join-requests').catch(() => []));
        if (profile.workosOrgId) {
          setPolicy((await apiJson<{ policy: 'auto' | 'approval' | null }>('/api/org/join-policy').catch(() => ({ policy: null }))).policy);
        }
      }
      setVoice(await apiJson<VoiceKeyStatus>('/api/org/voice-key').catch(() => null));
    } catch (err) {
      // A failed read is not an empty room. Rendering "no members" would be a claim about who is here.
      setError(err instanceof Error ? err.message : 'this room’s people could not be read');
    } finally {
      setLoaded(true);
    }
  }, []);
  React.useEffect(() => { void reload(); }, [reload]);

  // `me` from auth is the SESSION; `myMembership` is this room's record of that person. They are
  // different objects and conflating them shadowed one with the other.
  const myId = me?.user.id;
  const myMembership = members.find((member) => member.userId === myId);
  const canChange = myMembership?.role === 'owner' || myMembership?.role === 'admin';

  if (!loaded) return <div className="px-8 py-9" style={{ background: '#0A0A0B', fontFamily: MONO, fontSize: 10.5, color: '#4A4A52' }}>reading who is in this room…</div>;

  return (
    <div className="h-full overflow-y-auto" style={{ background: '#0A0A0B', color: '#E8E8EA' }}>
      <div className="mx-auto max-w-[900px] px-8 py-9">
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.16em', color: '#5A5A61' }}>
          WHO IS IN THIS ROOM{org ? ` · ${org.name.toUpperCase()}` : ''}
        </div>

        {error ? (
          <div className="mt-3.5 px-3.5 py-2.5 text-[12.5px] leading-[1.5]" style={{ border: '1px solid #241A17', borderLeft: '2px solid #B4553A', background: '#100D0C', color: '#DEDEE2', textWrap: 'pretty', maxWidth: 720 }}>
            {error}. Nothing on this screen should be read as a statement about who is here or what they can settle.
          </div>
        ) : null}

        {/* The law, on the page, so nobody has to assume it. */}
        <div className="mt-3.5 text-[13px] leading-[1.55]" style={{ color: '#8A8A91', textWrap: 'pretty', maxWidth: 720 }}>{RULES_ARE_NEVER_MERGED}</div>

        {members.length > 0 ? (
          <div className="mt-6 flex flex-col">
            {members.map((member) => (
              <div key={member.userId} className="flex gap-3 py-3" style={{ borderTop: '1px solid #17171A' }}>
                <div className="mt-[7px] h-[5px] w-[5px] flex-none rounded-full" style={{ background: member.role === 'owner' ? '#F0A35A' : member.role === 'admin' ? '#D9A03C' : '#3E5C8A' }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2.5">
                    <div className="truncate text-[13px]" style={{ color: '#DEDEE2' }}>{member.name || member.email}</div>
                    {member.userId === myId ? <div style={{ fontFamily: MONO, fontSize: 10, color: '#F0A35A' }}>you</div> : null}
                  </div>
                  {/* What their word DOES, not what boxes are ticked. */}
                  <div className="mt-[3px] text-[11.5px] leading-[1.45]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>{whatTheirWordDoes(member.role)}</div>
                  <div className="mt-[2px] truncate" style={{ fontFamily: MONO, fontSize: 10, color: '#4A4A52' }}>{member.email}</div>
                </div>
                {canChange && member.userId !== myId ? (
                  <button
                    type="button"
                    onClick={async () => {
                      await apiJson('/api/org/members/remove', jsonInit('POST', { userId: member.userId })).catch(() => {});
                      setNotice(`${member.name || member.email} no longer has access here. What they already said stays in the record with their name on it.`);
                      void reload();
                    }}
                    className="h-7 flex-none rounded-[3px] px-2.5"
                    style={{ border: '1px solid #26262B', fontFamily: MONO, fontSize: 10, color: '#C9C9CF' }}
                    title="Ends their access. Everything they already said stays in the record under their name."
                  >
                    remove
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : !error ? (
          <div className="mt-6 text-[12.5px] leading-[1.5]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>
            Nobody else is here. Everything the fleet has been told, you told it.
          </div>
        ) : null}

        {notice ? <div className="mt-3 text-[12px] leading-[1.5]" style={{ color: '#8A6A45', textWrap: 'pretty', maxWidth: 700 }}>{notice}</div> : null}

        {org && !org.personal ? (
          <Zone label="WHO CAN WALK IN">
            <div className="text-[12.5px] leading-[1.55]" style={{ color: '#DEDEE2', textWrap: 'pretty', maxWidth: 720 }}>{joinPolicyLine(policy, requests.length)}</div>
            {canChange && org.workosOrgId ? (
              <div className="mt-3 flex gap-2">
                {(['approval', 'auto'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={async () => { await apiJson('/api/org/join-policy', jsonInit('POST', { policy: option })).catch(() => {}); void reload(); }}
                    className="h-7 rounded-[3px] px-2.5"
                    style={{ border: `1px solid ${policy === option ? '#F0A35A' : '#26262B'}`, fontFamily: MONO, fontSize: 10, color: policy === option ? '#F0A35A' : '#C9C9CF' }}
                  >
                    {option === 'approval' ? 'they wait to be let in' : 'they walk straight in'}
                  </button>
                ))}
              </div>
            ) : null}

            {requests.length > 0 ? (
              <div className="mt-4 flex flex-col">
                {requests.map((request) => (
                  <div key={request.id} className="flex items-center gap-3 py-2" style={{ borderTop: '1px solid #17171A' }}>
                    <div className="min-w-0 flex-1 truncate text-[12.5px]" style={{ color: '#DEDEE2' }}>{request.email}</div>
                    {canChange ? (['approve', 'deny'] as const).map((action) => (
                      <button
                        key={action}
                        type="button"
                        onClick={async () => { await apiJson('/api/workos/join-requests/decide', jsonInit('POST', { id: request.id, action })).catch(() => {}); void reload(); }}
                        className="h-7 flex-none rounded-[3px] px-2.5"
                        style={{ border: '1px solid #26262B', fontFamily: MONO, fontSize: 10, color: '#C9C9CF' }}
                      >
                        {action === 'approve' ? 'let them in' : 'turn them away'}
                      </button>
                    )) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </Zone>
        ) : null}

        {canChange ? (
          <Zone label="BRINGING SOMEONE IN">
            {/* What it does, said before it is done. */}
            <div className="text-[12.5px] leading-[1.5]" style={{ color: '#8A8A91', textWrap: 'pretty', maxWidth: 720 }}>{inviteConsequence(inviteRole)}</div>
            <div className="mt-3 flex gap-2">
              <input
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                placeholder="their email"
                className="h-8 flex-1 rounded-[3px] bg-transparent px-2.5 outline-none"
                style={{ border: '1px solid #26262B', fontFamily: MONO, fontSize: 11, color: '#C9C9CF' }}
              />
              {(['member', 'admin'] as const).map((role) => (
                <button
                  key={role}
                  type="button"
                  onClick={() => setInviteRole(role)}
                  className="h-8 rounded-[3px] px-2.5"
                  style={{ border: `1px solid ${inviteRole === role ? '#F0A35A' : '#26262B'}`, fontFamily: MONO, fontSize: 10, color: inviteRole === role ? '#F0A35A' : '#C9C9CF' }}
                >
                  {role}
                </button>
              ))}
              <button
                type="button"
                disabled={!inviteEmail.trim()}
                onClick={async () => {
                  const response = await apiJson<{ ok: boolean; error?: string }>('/api/org/members/invite', jsonInit('POST', { email: inviteEmail.trim(), role: inviteRole })).catch(() => ({ ok: false, error: 'the invitation could not be sent' }));
                  setNotice(response.ok ? `${inviteEmail.trim()} can now speak to the fleet.` : response.error ?? 'the invitation could not be sent');
                  if (response.ok) { setInviteEmail(''); void reload(); }
                }}
                className="h-8 rounded-[3px] px-3 disabled:opacity-40"
                style={{ background: '#F0A35A', color: '#140D06', fontSize: 12, fontWeight: 600 }}
              >
                invite
              </button>
            </div>
          </Zone>
        ) : null}

        <Zone label="WHAT LEAVES THIS APP" tone={voice?.configured && voice.enabled !== false ? '#8A6A45' : undefined}>
          {/* A stored-but-disabled key and no key at all are different facts; a toggle shows both as
              empty. */}
          <div className="text-[12.5px] leading-[1.55]" style={{ color: '#DEDEE2', textWrap: 'pretty', maxWidth: 720 }}>{outboundKeyLine(voice)}</div>
          {canChange ? (
            <div className="mt-3 flex gap-2">
              {voice?.configured ? (
                <>
                  <button
                    type="button"
                    onClick={async () => { await setOrgVoiceEnabled(!(voice.enabled !== false)).catch(() => {}); void reload(); }}
                    className="h-7 rounded-[3px] px-2.5"
                    style={{ border: '1px solid #26262B', fontFamily: MONO, fontSize: 10, color: '#C9C9CF' }}
                  >
                    {voice.enabled === false ? 'turn it back on' : 'switch it off'}
                  </button>
                  <button
                    type="button"
                    onClick={async () => { await deleteOrgVoiceKey().catch(() => {}); void reload(); }}
                    className="h-7 rounded-[3px] px-2.5"
                    style={{ border: '1px solid #26262B', fontFamily: MONO, fontSize: 10, color: '#C2704A' }}
                    title="Removes the key itself. Switching off leaves it here; this does not."
                  >
                    remove the key
                  </button>
                </>
              ) : (
                <KeyEntry onSaved={() => void reload()} />
              )}
            </div>
          ) : null}
        </Zone>
      </div>
    </div>
  );
}

function KeyEntry({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = React.useState('');
  return (
    <>
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="paste the key"
        type="password"
        className="h-7 w-[280px] rounded-[3px] bg-transparent px-2.5 outline-none"
        style={{ border: '1px solid #26262B', fontFamily: MONO, fontSize: 11, color: '#C9C9CF' }}
      />
      <button
        type="button"
        disabled={!value.trim()}
        onClick={async () => { await putOrgVoiceKey(value.trim()).catch(() => {}); setValue(''); onSaved(); }}
        className="h-7 rounded-[3px] px-2.5 disabled:opacity-40"
        style={{ border: '1px solid #26262B', fontFamily: MONO, fontSize: 10, color: '#C9C9CF' }}
      >
        store it
      </button>
    </>
  );
}
