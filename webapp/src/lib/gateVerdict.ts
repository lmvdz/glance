/**
 * gateVerdict — a judgement, and what it rests on.
 *
 * `02-surfaces.html` draws this screen and states its whole contract in three sentences: *"Nothing
 * unusual happened in these nineteen minutes. That is a judgement, so here is what it rests on. You
 * should be able to disagree with it in under a minute — and this view closes itself again, because
 * reading it is not the job."*
 *
 * The old proof view got the facts right and the shape wrong. It opened with a chip reading the raw
 * verdict string — and when nothing had been pinned, that chip said **unknown**, which reads as a
 * verdict of unknown rather than as the absence of one. It then laid out per-criterion rows, a done-
 * proof table and a land-assessment table with equal weight, so the thing that nearly stopped the unit
 * sat in the same grey as the thing nobody was worried about.
 *
 * The reference's ordering instead:
 *
 * 1. **The judgement, as a sentence.** Not a status chip.
 * 2. **WHAT THE VERDICT RESTS ON** — the criteria that carried it, each with why.
 * 3. **CONSIDERED, AND DELIBERATELY NOT SURFACED** — what was checked and left out, named, so the
 *    reader can tell a quiet check from a check that never ran.
 * 4. **The firehose opens on request, never by default.**
 */

export interface VerdictCriterion {
  id: string;
  satisfied: boolean;
  note?: string;
}

export interface VerdictInput {
  unitName?: string;
  verdict?: string;
  agreement?: number;
  confidence?: number;
  rationale?: string;
  perCriterion?: VerdictCriterion[];
}

/**
 * The judgement in one sentence.
 *
 * A verdict that was never pinned is reported as MISSING, never as a verdict of "unknown". The old
 * chip could not tell those apart, and they mean opposite things: one is a reviewer saying they are
 * unsure, the other is nobody having reviewed.
 */
export function verdictSentence(input: VerdictInput): string {
  const name = input.unitName || 'This unit';
  const verdict = input.verdict?.trim();
  if (!verdict) return `No verdict was pinned to this card. That is not a verdict of “unsure” — it means nothing was recorded here, and anything below is evidence without a conclusion attached to it.`;
  if (verdict === 'veto') return `${name} was vetoed. Something below is the reason, and it was decisive enough that agreement elsewhere did not matter.`;
  if (verdict === 'fail') return `${name} did not pass. The failing checks are first below, because they are what the verdict rests on.`;
  if (verdict === 'pass') return `${name} passed. That is a judgement, so here is what it rests on — you should be able to disagree with it in under a minute.`;
  return `${name} was judged “${verdict}”. That is a judgement, so here is what it rests on.`;
}

/**
 * How sure, in words.
 *
 * The reference's standing line is *"confidence stated, not scored"*. A bare "92%" invites a reader to
 * compare it against other numbers on other screens as though the scale meant something across them.
 */
export function confidenceLine(input: VerdictInput): string | undefined {
  const { agreement, confidence } = input;
  const parts: string[] = [];
  if (typeof confidence === 'number' && Number.isFinite(confidence)) {
    parts.push(confidence >= 0.9 ? 'the reviewer was sure' : confidence >= 0.6 ? 'the reviewer was fairly sure' : 'the reviewer was not sure');
  }
  if (typeof agreement === 'number' && Number.isFinite(agreement)) {
    parts.push(agreement >= 0.99 ? 'and the reviewers agreed completely' : agreement >= 0.6 ? 'and the reviewers mostly agreed' : 'and the reviewers disagreed with each other');
  }
  if (parts.length === 0) return undefined;
  return `${parts.join(' ')}.`;
}

/**
 * What the verdict rests on: the failures first, then the checks that carried it with a reason
 * recorded. Order is the argument — the thing that nearly stopped the unit does not belong in the same
 * grey as the thing nobody was worried about.
 */
export function restsOn(criteria: readonly VerdictCriterion[]): VerdictCriterion[] {
  return [...criteria.filter((c) => !c.satisfied), ...criteria.filter((c) => c.satisfied && !!c.note?.trim())];
}

/**
 * Checked, passed, and left out of the argument above.
 *
 * Named rather than dropped: a reader who cannot see this list cannot tell a check that passed quietly
 * from a check that never ran, and the second is the one that should worry them.
 */
export function consideredNotSurfaced(criteria: readonly VerdictCriterion[]): VerdictCriterion[] {
  return criteria.filter((c) => c.satisfied && !c.note?.trim());
}

/** Why the quiet ones are quiet — the sentence that keeps the list from reading as an omission. */
export function notSurfacedSentence(count: number): string {
  if (count === 0) return 'Every check that ran is in the argument above. Nothing was left out of it.';
  return `${count} check${count === 1 ? '' : 's'} passed with nothing to say about ${count === 1 ? 'it' : 'them'}. They are named here so you can tell a quiet pass from a check that never ran — the second is the one worth worrying about.`;
}

/** What is missing from the record, stated rather than left blank. */
export function absences(input: { validation?: unknown; doneProof?: unknown; landAttempt?: unknown; malformedLandRecords?: number }): string[] {
  const out: string[] = [];
  if (!input.validation) out.push('No review record was pinned to this card, so there is no verdict and no criteria behind one.');
  if (!input.doneProof) out.push('No done-proof matched this branch or issue. The unit may still have landed — this says the proof was not found, not that it does not exist.');
  if (!input.landAttempt) out.push('No land assessment matched this unit. Whether the merge was observed is unknown from here.');
  const malformed = input.malformedLandRecords ?? 0;
  if (malformed > 0) out.push(`${malformed} land record${malformed === 1 ? '' : 's'} could not be read and ${malformed === 1 ? 'was' : 'were'} ignored. Ignored is not the same as absent — one of them may have been about this unit.`);
  return out;
}
