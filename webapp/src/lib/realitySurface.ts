/**
 * realitySurface — what is claimed, and what is actually true.
 *
 * `01-room.html` names the two zones this screen exists for: **WHAT IS TRUE RIGHT NOW** and **THE
 * EVIDENCE SURVIVED**. `06-other-side.html` names the rule underneath them — **HOW CLAIMS ARE MARKED
 * FROM NOW ON** — and it is the whole point: a plan saying "done" is a CLAIM, and this screen is the
 * only place that distinguishes a claim from a fact.
 *
 * The old view drew that distinction as two progress rings and four badge colours. Rings compress the
 * distinction back out again: a plan that is 90% done-unproven and one that is 90% done-proven draw
 * the same arc, and the arc is the thing a reader remembers. The number that matters is not how much
 * is done — it is how much is claimed done with nothing behind it.
 *
 * So the headline is the gap, stated as a sentence, and "stale" is never folded into "proven": evidence
 * that was green against a different main is evidence about a different repository.
 */

export type RealityState = 'open' | 'done-proven' | 'done-stale' | 'done-unproven';

export interface RealityRollup {
  totalConcerns: number;
  done: number;
  open: number;
  blocked: number;
  doneProven: number;
  doneStale: number;
  doneUnproven: number;
  proofPresent: boolean;
  proofReachable: boolean | null;
}

/**
 * The headline: the gap between what is claimed and what is proven.
 *
 * Leads with the unproven count when there is one, because that is the only number on this screen a
 * person can act on. "14 of 21 done" leads with the reassuring half of the same fact.
 */
export function realityHeadline(rollup: RealityRollup): string {
  const { totalConcerns, done, doneProven, doneStale, doneUnproven } = rollup;
  if (totalConcerns === 0) return 'This plan has no units in it, so there is nothing to claim and nothing to check.';
  if (done === 0) return `Nothing in this plan claims to be done yet. ${totalConcerns} unit${totalConcerns === 1 ? '' : 's'} still open — there is no gap to worry about because there are no claims.`;
  const gap = doneUnproven + doneStale;
  if (gap === 0) return `${done} of ${totalConcerns} units say they are done, and every one of them has evidence behind it that still holds.`;
  const parts: string[] = [];
  if (doneUnproven > 0) parts.push(`${doneUnproven} with no evidence at all`);
  if (doneStale > 0) parts.push(`${doneStale} whose evidence was green against an older main`);
  return `${gap} of the ${done} units claiming to be done cannot back the claim — ${parts.join(', and ')}. ${doneProven} can.`;
}

/**
 * Whether the evidence survived — the second zone, and a separate question from whether it existed.
 *
 * `reachable: null` is neither yes nor no, and must not be rendered as either. A proof we cannot
 * locate is a proof we cannot vouch for, which is different from one we know is gone.
 */
export function evidenceLine(rollup: RealityRollup, detail?: string): string {
  if (!rollup.proofPresent) {
    return 'No proof is attached to this plan at all. Nothing here has been checked against a run — every "done" is somebody’s word.';
  }
  if (rollup.proofReachable === true) {
    return `The evidence survived: the commit it was taken against is still reachable from main.${detail ? ` ${detail}` : ''}`;
  }
  if (rollup.proofReachable === false) {
    return `The evidence did not survive. The commit it was taken against is no longer reachable from main, so it proves something about a version of this repository that no longer exists.${detail ? ` ${detail}` : ''}`;
  }
  return `Whether the evidence survived could not be determined — the commit it was taken against could not be located either way.${detail ? ` ${detail}` : ''} Unknown is not the same as gone, and it is not the same as fine.`;
}

/** How a single claim is marked. Stale is never folded into proven. */
export function claimMark(state: RealityState): { label: string; tone: string; why: string } {
  switch (state) {
    case 'done-proven':
      return { label: 'proven', tone: '#3E7D57', why: 'done, with evidence that still holds' };
    case 'done-stale':
      // The distinction this whole module exists for.
      return { label: 'stale', tone: '#D9A03C', why: 'done, but its evidence was green against an older main — that is evidence about a different repository' };
    case 'done-unproven':
      return { label: 'unproven', tone: '#B4553A', why: 'claims to be done with nothing behind it' };
    default:
      return { label: 'open', tone: '#3E5C8A', why: 'not claimed done, so there is nothing to check' };
  }
}

/**
 * Scope drift, in words.
 *
 * Two different facts, and the reference keeps them apart: files a plan said it would touch and did
 * not (the plan over-promised) and files it touched without saying so (the plan under-declared). Only
 * the second is a surprise to anyone reading the plan.
 */
export function driftLines(drift: { plannedNotTouched: readonly string[]; touchedNotPlanned: readonly string[]; actualChangedFiles: number | null }): string[] {
  const out: string[] = [];
  if (drift.actualChangedFiles === null) {
    out.push('What this plan actually changed could not be read, so nothing below is a comparison — it is only what the plan said it would touch.');
    return out;
  }
  if (drift.touchedNotPlanned.length > 0) {
    out.push(`${drift.touchedNotPlanned.length} file${drift.touchedNotPlanned.length === 1 ? ' was' : 's were'} changed that the plan never mentioned. That is the half worth reading — nobody reviewing the plan knew about ${drift.touchedNotPlanned.length === 1 ? 'it' : 'them'}.`);
  }
  if (drift.plannedNotTouched.length > 0) {
    out.push(`${drift.plannedNotTouched.length} file${drift.plannedNotTouched.length === 1 ? '' : 's'} the plan named ${drift.plannedNotTouched.length === 1 ? 'was' : 'were'} never touched. The plan promised more than it delivered, which is less alarming and still worth knowing.`);
  }
  if (out.length === 0) out.push('What this plan changed is what it said it would change.');
  return out;
}
