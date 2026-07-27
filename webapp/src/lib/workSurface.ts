/**
 * workSurface — what is on, in the order it needs you.
 *
 * `02-surfaces.html` never draws a task board. It draws **WHERE YOU HAVE BEEN STANDING TODAY** — a
 * short recency list of places, each with its address and when you were last there — and it puts
 * everything else behind the room's own tree. There is no status column, no percent-done, no
 * assignee avatars, because none of those is a thing a person acts on.
 *
 * The old list was a Plane/Linear board: a COLUMNS config of pluggable slots (Pin · ID · Title ·
 * Status · % · Agents) grouped PINNED → IN PROGRESS → PLANNED → DONE. That is a project-management
 * tool for humans assigning work to humans, on a product whose whole premise is that the fleet
 * assigns work to itself and only stops when it genuinely cannot proceed.
 *
 * So this ranks by whether it needs you, says why in a sentence, and keeps DONE out of the way rather
 * than as a fourth column of equal weight.
 */

export type Posture = 'needs-you' | 'working' | 'idle' | 'settled';

export interface WorkItem {
  id: string;
  title: string;
  /** The one-line answer to "does this need me?" — never a status word on its own. */
  headline: string;
  posture: Posture;
  verdict: 'critical' | 'warn' | 'healthy';
  done: boolean;
  /** When anything last moved. */
  lastActivity?: number;
  agentCount: number;
}

const RANK: Record<Posture, number> = { 'needs-you': 0, working: 1, idle: 2, settled: 3 };

/**
 * Needs-you first, then what is moving, then what is not, then what is finished.
 *
 * Within a band, most recent first — a thing that moved a minute ago is more likely to be what you
 * came here about than one that stopped on Tuesday.
 */
export function ranked(items: readonly WorkItem[]): WorkItem[] {
  return [...items].sort((a, b) => {
    const rank = (item: WorkItem) => (item.done ? 4 : RANK[item.posture]);
    return rank(a) - rank(b) || (b.lastActivity ?? 0) - (a.lastActivity ?? 0) || a.title.localeCompare(b.title);
  });
}

/**
 * The one line at the top: how much of this is actually yours to deal with.
 *
 * Leads with the count that requires action. "18 tasks, 4 in progress" is the shape of a board and
 * tells a person nothing about whether they can close the tab.
 *
 * `unattached` is the units belonging to no task on this list, and it exists because of a defect seen
 * live: the top bar read "1 waiting on you" while this line read "not one of them needs you". Both
 * were true of what they measured and together they were a contradiction, which is worse than either
 * being wrong — a reader cannot tell which screen to believe. This line is scoped to what it can
 * actually see, and says so when there is work it cannot.
 */
export function workHeadline(items: readonly WorkItem[], unattached = 0): string {
  const live = items.filter((item) => !item.done);
  const elsewhere = unattached > 0
    ? ` ${unattached} unit${unattached === 1 ? ' is' : 's are'} running outside any plan on this list — the room is where ${unattached === 1 ? 'it lives' : 'they live'}.`
    : '';
  if (items.length === 0) {
    return unattached > 0
      ? `No plan is on. The fleet is not idle —${elsewhere}`
      : 'Nothing is on. This is not a filtered view — there is no work here at all.';
  }
  if (live.length === 0) return `Everything here is finished. ${items.length} thing${items.length === 1 ? '' : 's'}, none of them waiting on anything.${elsewhere}`;
  const needs = live.filter((item) => item.posture === 'needs-you');
  if (needs.length === 0) {
    const working = live.filter((item) => item.posture === 'working').length;
    // "not one of them needs you" is scoped to THESE — never a claim about the fleet.
    return `${live.length} thing${live.length === 1 ? '' : 's'} on, ${working === 0 ? 'none of them moving' : `${working} of them moving`}, and none of these needs you.${elsewhere}`;
  }
  return `${needs.length} of the ${live.length} things on ${needs.length === 1 ? 'needs' : 'need'} you. The rest are moving or waiting on each other.${elsewhere}`;
}

/** The band a thing sits in, named as a state of the world rather than a workflow column. */
export function bandLabel(posture: Posture, done: boolean): string {
  if (done) return 'FINISHED';
  switch (posture) {
    case 'needs-you': return 'WAITING ON YOU';
    case 'working': return 'MOVING';
    case 'idle': return 'ON, BUT NOT MOVING';
    default: return 'SETTLED';
  }
}

/** Group in rank order, dropping empty bands rather than drawing a heading over nothing. */
export function bands(items: readonly WorkItem[]): Array<{ label: string; items: WorkItem[] }> {
  const out: Array<{ label: string; items: WorkItem[] }> = [];
  for (const item of ranked(items)) {
    const label = bandLabel(item.posture, item.done);
    const last = out[out.length - 1];
    if (last && last.label === label) last.items.push(item);
    else out.push({ label, items: [item] });
  }
  return out;
}

/**
 * Where you have been standing today — the reference's own zone.
 *
 * Recency, capped, and only things actually visited. A list padded out with places you have never
 * been is a menu, not a history.
 */
export function whereYouHaveBeen(items: readonly WorkItem[], now: number, limit = 5): WorkItem[] {
  const dayAgo = now - 86_400_000;
  return [...items]
    .filter((item) => (item.lastActivity ?? 0) > dayAgo)
    .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))
    .slice(0, limit);
}
