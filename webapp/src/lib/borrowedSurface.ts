/**
 * borrowedSurface — what this product can do that you did not teach it.
 *
 * `05-first-week.html` runs the whole first week on one distinction: what the product knows because
 * you SAID it, and what it does because it borrowed a default. Its meta line is *"borrowed defaults in
 * force · 6, all reversible"*, and the five-days-in screen's whole argument is *"Four of the six
 * borrowed defaults have been replaced by things you actually said."*
 *
 * A capability pack is exactly that: an ability the product has that nobody here wrote. So the screen
 * is not an app store and not a health dashboard — it is the borrowed-defaults list, and the two facts
 * that matter about each entry are what it lets the fleet do and how to take it back.
 *
 * The old panel was five coloured badge states (Active / Broken / Pending / Disabled / Available) over
 * cards counting tools, skills and workflows. Counting a pack's tools tells a reader nothing about
 * whether they want it; and "Available" sat in the same list as "Active", which puts a thing you have
 * not installed next to a thing already acting on your behalf.
 *
 * So: **in force** is separated from **on offer**, because one of those is running against your
 * repository right now and the other is a catalogue. Broken leads, because a capability that thinks it
 * is working and is not is worse than one that is plainly off.
 */

export type PackHealth = 'active' | 'pending' | 'idle' | 'broken' | 'available';

export interface BorrowedPack {
  id: string;
  title: string;
  description: string;
  health: PackHealth;
  detail: string;
  requiredEnv: readonly string[];
  toolCount: number;
  skillCount: number;
  workflowCount: number;
}

/** In force = acting on your behalf now, or trying to. On offer = a catalogue entry, doing nothing. */
export function inForce(packs: readonly BorrowedPack[]): BorrowedPack[] {
  const rank: Record<PackHealth, number> = { broken: 0, active: 1, pending: 2, idle: 3, available: 9 };
  return packs.filter((pack) => pack.health !== 'available').sort((a, b) => rank[a.health] - rank[b.health] || a.title.localeCompare(b.title));
}

export function onOffer(packs: readonly BorrowedPack[]): BorrowedPack[] {
  return packs.filter((pack) => pack.health === 'available').sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * The headline, in the first-week voice.
 *
 * Counts what is acting, and leads with anything broken — a capability that believes it is working and
 * is not is worse than one that is plainly off, because the fleet is relying on it.
 */
export function borrowedHeadline(packs: readonly BorrowedPack[]): string {
  const force = inForce(packs);
  const broken = force.filter((pack) => pack.health === 'broken');
  const active = force.filter((pack) => pack.health === 'active');
  if (force.length === 0) {
    return 'Nothing here was borrowed. Everything the fleet does, it does because of something written in this repository — which is the state the first week is trying to reach, not a state to fix.';
  }
  if (broken.length > 0) {
    return `${broken.length} borrowed ${broken.length === 1 ? 'capability is' : 'capabilities are'} in force and not working. That is worse than one plainly switched off, because the fleet is still counting on ${broken.length === 1 ? 'it' : 'them'}.`;
  }
  return `${active.length} borrowed ${active.length === 1 ? 'capability is' : 'capabilities are'} in force, all reversible. Each is something the fleet can do that nobody here wrote down.`;
}

/** What taking one back actually costs — never a bare toggle. */
export function reversalNote(pack: BorrowedPack): string {
  if (pack.health === 'available') return 'Nothing happens until you install it. It is a catalogue entry and is doing nothing on your behalf.';
  if (pack.health === 'broken') return 'Switching this off changes nothing that is working, because nothing here is. What it was supposed to do stops being promised.';
  if (pack.health === 'idle') return 'Already off. It is installed and doing nothing — the fleet does not have this ability right now.';
  if (pack.health === 'pending') return 'Not in force yet. Turning it back now costs nothing, because nothing has relied on it.';
  const abilities = pack.toolCount + pack.skillCount + pack.workflowCount;
  return abilities > 0
    ? `Taking this back removes ${abilities} thing${abilities === 1 ? '' : 's'} the fleet can currently do. Work already done with it stays done.`
    : 'Taking this back is reversible and removes nothing the fleet has actually used.';
}

/** What it needs from you before it can work. Missing configuration is a fact, not a warning colour. */
export function requiresLine(pack: BorrowedPack): string | undefined {
  if (pack.requiredEnv.length === 0) return undefined;
  return `Needs ${pack.requiredEnv.join(', ')} to be set. Without ${pack.requiredEnv.length === 1 ? 'it' : 'them'} this cannot work, whatever its state says.`;
}

export const HEALTH_TONE: Record<PackHealth, string> = {
  broken: '#B4553A',
  active: '#3E7D57',
  pending: '#D9A03C',
  idle: '#4A4A52',
  available: '#3E5C8A',
};

export const HEALTH_WORD: Record<PackHealth, string> = {
  broken: 'in force, not working',
  active: 'in force',
  pending: 'not in force yet',
  idle: 'installed, switched off',
  available: 'on offer',
};
