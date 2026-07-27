/**
 * roomPeople — who is in this room, and what each of them can settle.
 *
 * `05-first-week.html` states the rule this replaces a settings page with: *"one conversation, two
 * humans, and every instruction carries the name of whoever gave it"*, and — the part that matters —
 * *"Rules are never merged into house policy, because then they stop being anybody's words. They
 * apply to the whole fleet and keep the name and date of whoever said them."*
 *
 * That is the opposite of an organisation settings screen. A settings screen turns people into rows
 * with a role dropdown; the design turns a role into a sentence about what that person's word does to
 * the fleet. Whether Dev can approve a land is not a permission flag — it is the reason Rune held a
 * failing test this morning.
 *
 * So each member is described by what their instructions DO, an invitation says what the invited
 * person will be able to settle before it is sent, and the join policy is a sentence rather than a
 * radio pair.
 */

export type MemberRole = 'owner' | 'admin' | 'member' | string;

export interface RoomMember {
  userId: string;
  name: string;
  email: string;
  role: MemberRole;
}

/**
 * What this person's word does to the fleet.
 *
 * Deliberately phrased as consequences rather than capabilities: "can remove members" is a checkbox,
 * "can end someone's access to everything here" is what actually happens.
 */
export function whatTheirWordDoes(role: MemberRole): string {
  switch (role) {
    case 'owner':
      return 'Their instructions bind the whole fleet, they can end anyone’s access here, and nobody can remove them.';
    case 'admin':
      return 'Their instructions bind the whole fleet, and they can bring people in or put them out.';
    case 'member':
      return 'Their instructions bind the whole fleet like anyone else’s. They cannot change who else is here.';
    default:
      return `Role recorded as “${role}”, which this screen does not have a sentence for. What it permits is unknown from here — that is worth resolving before relying on it.`;
  }
}

/** The standing rule, said on the page rather than assumed. */
export const RULES_ARE_NEVER_MERGED =
  'Rules are never merged into house policy, because then they stop being anybody’s words. Every instruction anyone here gives applies to the whole fleet and keeps the name and date of whoever said it.';

/** Who may walk in, as a sentence. */
export function joinPolicyLine(policy: 'auto' | 'approval' | null, pending: number): string {
  if (policy === 'auto') {
    return 'Anyone with an email at your domain becomes a member the moment they sign in, and their instructions bind the fleet from that moment. Nobody is asked first.';
  }
  if (policy === 'approval') {
    return pending > 0
      ? `New arrivals wait for someone here to let them in. ${pending} ${pending === 1 ? 'is' : 'are'} waiting now.`
      : 'New arrivals wait for someone here to let them in. Nobody is waiting.';
  }
  return 'How people join has not been set. This is not "closed" — it is unknown, and unknown means nobody here has decided it.';
}

/** What sending an invitation actually does, said before it is sent. */
export function inviteConsequence(role: MemberRole): string {
  return `They will be able to speak to the fleet immediately, and ${whatTheirWordDoes(role).charAt(0).toLowerCase()}${whatTheirWordDoes(role).slice(1)}`;
}

/**
 * The state of a key that lets something leave this app.
 *
 * A stored-but-disabled key and no key at all are different facts: one is a kill switch someone can
 * flip back, the other is nothing to flip. A settings page shows both as an empty toggle.
 */
export function outboundKeyLine(status: { configured: boolean; enabled?: boolean; last4?: string; updatedBy?: string; updatedAt?: number } | null): string {
  if (!status || !status.configured) {
    return 'No key is stored, so nothing here can reach that service at all. Nothing is being sent anywhere on your behalf.';
  }
  if (status.enabled === false) {
    return `A key is stored and switched OFF. Nothing is being sent, but the key is still here and one action turns it back on — that is different from having no key.${status.last4 ? ` Ends ${status.last4}.` : ''}`;
  }
  const who = status.updatedBy ? status.updatedBy.replace(/^db:/, '') : undefined;
  return `A key is stored and live. Things leave this app through it${who ? `, and ${who} is who put it there` : ''}.${status.last4 ? ` Ends ${status.last4}.` : ''}`;
}
