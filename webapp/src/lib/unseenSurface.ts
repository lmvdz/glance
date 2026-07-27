/**
 * unseenSurface — what has changed under you while you were not reading it.
 *
 * `05-first-week.html` gives absence its own screen and its own voice: **WHAT THIS PRODUCT DOES NOT
 * KNOW YET**, a list that exists to empty, with the standing line *"Nothing pretends to be there
 * before it is."* This is the same shape pointed the other way — what YOU have not seen — because the
 * two are the same product idea: a system that says what it does not know instead of implying it knows
 * everything.
 *
 * The old Fog view rendered this as a tri-state colour overlay on a folder tree (never-seen /
 * seen-current / stale) behind a 7d/14d/30d range toggle. Everything true about the data was in there
 * and nothing about what it MEANT: a person had to learn a legend, pick a window, and then work out
 * for themselves which of six hundred files actually mattered. Debt is a number the machine can rank;
 * the ranking is the whole product.
 *
 * Three rules:
 *
 * 1. **The list is ranked and short.** Comprehension debt with no ceiling is a second codebase to
 *    read. The top of the list is the finding; the tail is noise wearing the same colour.
 * 2. **Never-seen and gone-stale are different facts.** A file you have never opened and a file you
 *    read before it changed eleven times are not the same kind of debt, and the second is the one that
 *    will surprise you.
 * 3. **The substrate being OFF is not zero debt.** `disabled: true` means nothing was measured. An
 *    empty list under a heading is the exact shape of a clean bill.
 */

export type FogState = 'never-seen' | 'seen-current' | 'stale';

export interface UnseenEntry {
  repo: string;
  file: string;
  changesSinceSeen: number;
  lastChangedAt: number;
  lastSeenAt?: number;
  debt: number;
  state: FogState;
}

export interface UnseenInput {
  entries: readonly UnseenEntry[];
  repoHasHistory: Record<string, boolean>;
  disabled?: boolean;
}

/**
 * The headline. Says what was measured before it says what was found — an empty list means one of
 * three different things and only one of them is good news.
 */
export function unseenHeadline(input: UnseenInput): string {
  if (input.disabled) {
    return 'Nothing is being measured. The attention substrate is off, so this screen has no idea what you have or have not read — that is an absence of measurement, not an absence of debt.';
  }
  const repos = Object.entries(input.repoHasHistory);
  if (repos.length > 0 && repos.every(([, has]) => !has)) {
    return 'No repository here has enough history to compare against. Nothing has been read and nothing has been missed, because there is nothing yet to miss.';
  }
  if (input.entries.length === 0) {
    return 'Nothing has changed under you since you last looked. Every file the fleet has touched, you have read since it was touched.';
  }
  const stale = input.entries.filter((entry) => entry.state === 'stale');
  const never = input.entries.filter((entry) => entry.state === 'never-seen');
  const parts: string[] = [];
  if (stale.length > 0) parts.push(`${stale.length} you read before ${stale.length === 1 ? 'it' : 'they'} changed`);
  if (never.length > 0) parts.push(`${never.length} you have never opened`);
  return `${input.entries.length} file${input.entries.length === 1 ? '' : 's'} the fleet has changed and you have not read — ${parts.join(', and ')}.`;
}

/** The one worth reading first, with the reason it is first. Ranked, never alphabetical. */
export function ranked(entries: readonly UnseenEntry[], limit = 12): UnseenEntry[] {
  return [...entries].sort((a, b) => b.debt - a.debt || b.changesSinceSeen - a.changesSinceSeen || a.file.localeCompare(b.file)).slice(0, limit);
}

/** Why this file is on the list, in words. Never a colour a reader has to learn. */
export function whyUnseen(entry: UnseenEntry, now: number): string {
  const changed = describeAge(now - entry.lastChangedAt);
  if (entry.state === 'never-seen') {
    return `You have never opened this. It changed ${changed}${entry.changesSinceSeen > 1 ? `, and ${entry.changesSinceSeen} times in all` : ''}.`;
  }
  if (entry.state === 'stale') {
    const seen = entry.lastSeenAt ? describeAge(now - entry.lastSeenAt) : 'at some point';
    return `You read it ${seen}. It has changed ${entry.changesSinceSeen} time${entry.changesSinceSeen === 1 ? '' : 's'} since, most recently ${changed}.`;
  }
  return 'You have read this since it last changed.';
}

function describeAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** What the list leaves out, said rather than truncated silently. */
export function tailNote(total: number, shown: number): string | undefined {
  if (total <= shown) return undefined;
  return `${total - shown} more carry less debt than these and are not listed. Comprehension debt with no ceiling is a second codebase to read; the top of this list is the finding.`;
}
