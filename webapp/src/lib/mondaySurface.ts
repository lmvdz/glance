/**
 * mondaySurface — what changed in how this gets used, and what is still rubbing.
 *
 * `05-first-week.html` measures a week the only way that means anything: *"You were interrupted
 * fourteen times on Monday and five times yesterday… Next week will be quieter than this one for
 * reasons you can read, not because a model settled down."* A direction, and then the reason for it.
 *
 * The old Daily panel had the same two signals — adoption counters and the friction ledger — as a row
 * of stat tiles with sparklines and a list of gripes. Sparklines are the exact failure this screen is
 * supposed to avoid: a shape with no sentence, which a reader either over-reads or ignores. And a
 * friction ledger sorted newest-first buries the thing that has happened eleven times under the thing
 * that happened once.
 *
 * So: the direction is said in words, the friction is grouped by what it IS rather than when it
 * happened, and the difference between a human writing down a gripe and the daemon noticing one is
 * kept visible — a machine's complaint about itself is weaker evidence than a person's.
 */

export interface CounterSeries {
  key: string;
  label: string;
  today: number;
  week: number;
  spark: number[];
}

export interface FrictionEntry {
  id: string;
  ts: number;
  repo: string;
  context?: string;
  gripe: string;
  source?: 'human' | 'auto';
}

/**
 * Which way a counter is going, in words — comparing the first half of the window with the second.
 *
 * Deliberately NOT a percentage: a move from 1 to 3 is "up 200%", which is true and useless. What a
 * reader wants is whether this is going the right way and by how much in real units.
 */
export function direction(series: CounterSeries): string {
  const spark = series.spark;
  if (spark.length < 4) return `${series.week} this week. Not enough days recorded to say which way it is going.`;
  const half = Math.floor(spark.length / 2);
  const early = spark.slice(0, half).reduce((a, b) => a + b, 0);
  const late = spark.slice(spark.length - half).reduce((a, b) => a + b, 0);
  if (early === 0 && late === 0) return 'Nothing recorded either half of this week.';
  if (early === late) return `${series.week} this week, evenly spread — no movement either way.`;
  const word = late > early ? 'more' : 'fewer';
  return `${series.week} this week: ${Math.abs(late - early)} ${word} in the last few days than the first few.`;
}

/** True when nothing at all was recorded — a first-class state, never fake zeros dressed as data. */
export function nothingRecorded(series: readonly CounterSeries[]): boolean {
  return series.every((entry) => entry.week === 0);
}

export const NOTHING_RECORDED_LINE =
  'Nothing has been recorded this week. That is an absence of measurement as much as an absence of use — the counters only move when somebody actually reaches for this.';

/**
 * Friction grouped by what it is, largest group first.
 *
 * The ledger sorted newest-first buries the thing that has happened eleven times under the thing that
 * happened once. Grouping is done on the gripe's opening words, which is crude and honest: it will
 * miss two phrasings of one complaint, and it will never invent a group that is not there.
 */
export function frictionGroups(entries: readonly FrictionEntry[], limit = 8): Array<{ key: string; gripe: string; count: number; humans: number; lastAt: number }> {
  const groups = new Map<string, { key: string; gripe: string; count: number; humans: number; lastAt: number }>();
  for (const entry of entries) {
    const key = entry.gripe.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).slice(0, 6).join(' ');
    const found = groups.get(key) ?? { key, gripe: entry.gripe, count: 0, humans: 0, lastAt: 0 };
    found.count += 1;
    if ((entry.source ?? 'human') === 'human') found.humans += 1;
    found.lastAt = Math.max(found.lastAt, entry.ts);
    groups.set(key, found);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt).slice(0, limit);
}

/**
 * How much a group of complaints is worth listening to.
 *
 * A person writing something down is stronger evidence than the daemon noticing a pattern about
 * itself, and the two must not be summed into one number that hides which is which.
 */
export function frictionWeight(group: { count: number; humans: number }): string {
  const auto = group.count - group.humans;
  if (group.humans === 0) return `${auto} time${auto === 1 ? '' : 's'}, all noticed by the daemon rather than written down by anyone. Weaker evidence than a person complaining once.`;
  if (auto === 0) return `${group.humans} time${group.humans === 1 ? '' : 's'}, each one written down by a person.`;
  return `${group.count} times — ${group.humans} written down by a person, ${auto} noticed by the daemon. The ${group.humans} count for more.`;
}

/** What the friction list means as a whole. */
export function frictionHeadline(entries: readonly FrictionEntry[]): string {
  if (entries.length === 0) {
    return 'Nothing is written down as friction. That may mean nothing is rubbing, or it may mean nobody has said so — the ledger only fills when someone bothers, and an empty one proves neither.';
  }
  const groups = frictionGroups(entries, 99);
  const repeated = groups.filter((group) => group.count > 1);
  if (repeated.length === 0) return `${entries.length} thing${entries.length === 1 ? '' : 's'} noted, none of them twice. Nothing here is a pattern yet.`;
  return `${entries.length} noted, and ${repeated.length} of them ${repeated.length === 1 ? 'is' : 'are'} a repeat. A thing that keeps happening is worth more than a thing that happened.`;
}
