/**
 * planSurface — a plan as a shape you can still change.
 *
 * `02-surfaces.html` draws the plan screen around one sentence: *"Change the shape here — rename,
 * split, remove or reorder — because after you start it is the fleet's plan and not yours."* Everything
 * else follows from that. The heading is **NOTHING HAS STARTED**, the meta reads *0 agents woken · 0
 * files touched*, and the assumptions get their own zone titled **WHAT TAM ASSUMED, SO YOU CAN CORRECT
 * IT** — not "notes", not "context". An assumption filed as a note is one nobody corrects.
 *
 * The old brief view had the same data and made none of these claims. It opened with a Sparkles chip
 * reading "Brief", three metric tiles counting concerns, and a status breakdown — the vocabulary of a
 * dashboard for work that is already underway, on a screen whose entire purpose is the moment before
 * it is.
 *
 * Two things this module is careful about:
 *
 * 1. **Parallelism is counted, not implied.** "Six units, two of them in parallel" is a fact about the
 *    phases; a reader who has to count the columns is being asked to do the machine's job.
 * 2. **"Nothing has started" is a claim, so it is checked.** A plan with work already done says so
 *    instead, because telling someone they can still reshape it when four units have landed is the
 *    worst thing this screen could do.
 */

export interface PlanConcern {
  file: string;
  title: string;
  status: string;
  open: boolean;
  phase: number;
  blockedBy: string[];
  touches: string[];
  acceptanceCount: number;
}

export interface PlanShape {
  concerns: readonly PlanConcern[];
  status: { total: number; open: number; done: number; blocked: number };
  outOfScope: readonly string[];
  dependencyIssues: readonly string[];
  touches: readonly string[];
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'] as const;
const say = (n: number): string => WORDS[n] ?? String(n);

/** Concerns that can run at the same time, by phase. A phase with more than one member is parallel. */
export function phases(concerns: readonly PlanConcern[]): Array<{ phase: number; concerns: PlanConcern[] }> {
  const byPhase = new Map<number, PlanConcern[]>();
  for (const concern of concerns) byPhase.set(concern.phase, [...(byPhase.get(concern.phase) ?? []), concern]);
  return [...byPhase.entries()].sort((a, b) => a[0] - b[0]).map(([phase, members]) => ({ phase, concerns: members }));
}

/**
 * The shape, in one sentence — how many units and how many of them run alongside another.
 *
 * The reference's own phrasing. Counting the parallel ones is the whole value: a reader looking at
 * columns has to work it out, and the number is the thing that tells them whether this plan finishes
 * this afternoon or this week.
 */
export function shapeSentence(concerns: readonly PlanConcern[]): string {
  if (concerns.length === 0) return 'There are no units in this plan yet — it is a title and an intention.';
  const groups = phases(concerns);
  const parallel = groups.filter((group) => group.concerns.length > 1).reduce((sum, group) => sum + group.concerns.length, 0);
  const units = `${say(concerns.length)} unit${concerns.length === 1 ? '' : 's'}`;
  if (parallel === 0) return `${units[0]!.toUpperCase()}${units.slice(1)}, one after another — nothing in this plan can run alongside anything else.`;
  return `${units[0]!.toUpperCase()}${units.slice(1)}, ${say(parallel)} of them in parallel.`;
}

/**
 * Whether this plan is still the reader's to reshape.
 *
 * Telling someone they can rename, split and reorder when four units have already landed would be the
 * worst thing this screen could do, so the claim is derived rather than assumed.
 */
export function startedState(status: PlanShape['status']): { started: boolean; line: string; meta: string } {
  const moved = status.done + status.blocked;
  if (status.total === 0) return { started: false, line: 'NOTHING HAS STARTED', meta: 'no units yet' };
  if (moved === 0) {
    return {
      started: false,
      line: 'NOTHING HAS STARTED',
      meta: `${status.total} unit${status.total === 1 ? '' : 's'} · 0 agents woken · 0 files touched`,
    };
  }
  return {
    started: true,
    line: 'THIS PLAN IS UNDERWAY',
    meta: `${status.done} done · ${status.blocked} blocked · ${status.open} still open`,
  };
}

/** The sentence under the heading: what you may still do, or why you may no longer do it. */
export function reshapeSentence(started: boolean): string {
  if (!started) return 'Change the shape here — rename, split, remove or reorder — because after you start it is the fleet’s plan and not yours.';
  return 'Work has begun, so the shape is no longer yours alone to change. Reordering what has not started is still safe; anything already done stays where it is in the record.';
}

/**
 * What is holding this plan — cross-concern blocks and unresolved dependency problems, together.
 *
 * The reference gives WHAT IS HOLDING IT one zone rather than splitting "blocked by a sibling" from
 * "the dependency table does not parse". To the reader they are the same fact: this cannot move.
 */
export function holdingIt(plan: PlanShape): string[] {
  const out: string[] = [];
  for (const concern of plan.concerns) {
    if (concern.blockedBy.length > 0) out.push(`${concern.title} — waiting on ${concern.blockedBy.join(', ')}`);
  }
  for (const issue of plan.dependencyIssues) out.push(issue);
  return out;
}

/** What is holding it, when nothing is. Said, rather than left as an empty region under a heading. */
export function holdingNothingSentence(plan: PlanShape): string {
  if (plan.concerns.length === 0) return 'Nothing is holding it, because nothing is in it yet.';
  return 'Nothing is holding it. Every unit here can start as soon as someone picks it up.';
}

/**
 * What was deliberately left out.
 *
 * `02-surfaces` calls this **WHAT I LEFT OUT OF THIS** and puts it beside the plan rather than at the
 * end of a document, because scope a reader has to go looking for is scope they will assume was
 * included.
 */
export function leftOutSentence(outOfScope: readonly string[]): string {
  if (outOfScope.length === 0) {
    return 'Nothing was written down as out of scope. That does not mean the plan covers everything — it means nobody drew the line, and the line is the thing people argue about later.';
  }
  return `${say(outOfScope.length)[0]!.toUpperCase()}${say(outOfScope.length).slice(1)} thing${outOfScope.length === 1 ? '' : 's'} ${outOfScope.length === 1 ? 'was' : 'were'} deliberately left out. They are here rather than at the end of a document, because scope you have to go looking for is scope you assume was included.`;
}

/** Concern status as a dot colour. Blocked reads as alarm; done as settled; open as in motion. */
export function statusTone(concern: PlanConcern): string {
  if (/block|hold|waiting|stuck/i.test(concern.status)) return '#B4553A';
  if (!concern.open) return '#3E7D57';
  return '#3E5C8A';
}

/**
 * What the plan can be checked against, said once.
 *
 * Every concern carries an acceptance count, and printing "nothing to check it against" on each of
 * nine rows turns a real problem into wallpaper — the reader stops seeing it by the third repetition.
 * When it is true of the whole plan it is stated once, at plan level, where it is a finding rather
 * than a decoration.
 */
export function acceptanceState(concerns: readonly PlanConcern[]): { perRow: boolean; sentence?: string } {
	if (concerns.length === 0) return { perRow: false };
	const withChecks = concerns.filter((concern) => concern.acceptanceCount > 0).length;
	if (withChecks === 0) {
		return { perRow: false, sentence: 'No unit in this plan has anything written down to check it against. Every "done" here will be somebody\u2019s judgement rather than a test.' };
	}
	if (withChecks === concerns.length) return { perRow: true };
	return {
		perRow: true,
		sentence: `${concerns.length - withChecks} of ${concerns.length} units have nothing to check them against. Those are the ones where "done" is a judgement.`,
	};
}
