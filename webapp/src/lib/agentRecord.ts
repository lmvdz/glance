/**
 * agentRecord — the sentences that keep a record from becoming a reputation.
 *
 * `03-machinery.html` states the law in five words: **a wrong reputation is worse than none**. Its
 * example screen shows an agent with six units and refuses to say anything about him — *"Six units is
 * not enough to tell you anything about Orin. Everything below is either a fact with no pattern behind
 * it, or what his role does by default."*
 *
 * That refusal is the feature. A page that shows three claims and a role, with no sample size beside
 * them, reads as a character assessment whether or not it meant to — and someone will pick who handles
 * stalled work from it. So:
 *
 * - Below the evidence floor the page says outright that it cannot tell you anything, and everything
 *   under it is labelled a fact or a default rather than a pattern.
 * - Rates are never shown for a sample too small to carry one.
 * - Agents are never ranked against each other. There is no comparison on this page and no score.
 * - Every claim links to the units it came from; nothing is inferred from anything you cannot open.
 */

export type ClaimState = 'current' | 'stale' | 'withdrawn';
export type Verification = 'checked' | 'agent-word' | 'unverifiable';

export interface RecordClaim {
  id: string;
  claim: string;
  verification: Verification;
  sampleSize: number;
  date: number;
  state: ClaimState;
  sourceNodeIds: string[];
}

export interface AgentRecordView {
  agentId: string;
  roleDefault?: string;
  provisional: boolean;
  checking?: { requiredUnits: number; checkedUnits: number; reviewerId?: string };
  profileMissing: boolean;
  claims: RecordClaim[];
}

/**
 * The floor beneath which no pattern may be claimed.
 *
 * Twelve, matching the reference's judgement that six is "too few for any rate". The exact number
 * matters less than that there IS one and that the page says which side of it you are on.
 */
export const EVIDENCE_FLOOR = 12;

/** The largest sample any single claim rests on — the closest thing to "how much do we know". */
export function evidenceWeight(record: AgentRecordView): number {
  return record.claims.reduce((most, claim) => Math.max(most, claim.sampleSize), 0);
}

/**
 * The judgement line, which is usually a refusal to judge.
 *
 * Returns undefined when the record is thick enough to speak for itself — at which point the claims
 * are the content and a summary over them would just be a score by another name.
 */
export function sampleCaveat(record: AgentRecordView, name: string): string | undefined {
  const weight = evidenceWeight(record);
  if (record.claims.length === 0) {
    return `Nothing has been recorded about ${name} yet. What is below is what the role does by default, which is not a prediction about ${name}.`;
  }
  if (weight < EVIDENCE_FLOOR) {
    return `${weight} unit${weight === 1 ? '' : 's'} is not enough to tell you anything about ${name}. Everything below is either a fact with no pattern behind it, or what the role does by default.`;
  }
  return undefined;
}

/** The sample line for the header: never a rate when the sample cannot carry one. */
export function sampleLine(record: AgentRecordView): string {
  const weight = evidenceWeight(record);
  if (weight === 0) return 'no units recorded';
  if (weight < EVIDENCE_FLOOR) return `${weight} unit${weight === 1 ? '' : 's'} · too few for any rate`;
  return `${weight} units`;
}

/** How a claim earned its place, in words. A withdrawn claim stays, with its reason. */
export function claimBasis(claim: RecordClaim, formatDate: (ms: number) => string): string {
  const basis = `${claim.sampleSize} ${claim.sampleSize === 1 ? 'unit' : 'units'} · ${formatDate(claim.date)}`;
  if (claim.state === 'withdrawn') return `${basis} · withdrawn; it stays here because it was true to its evidence then`;
  if (claim.state === 'stale') return `${basis} · stale; open the source units before relying on it`;
  if (claim.verification === 'checked') return `${basis} · checked against the units`;
  if (claim.verification === 'agent-word') return `${basis} · the agent's own word, not checked`;
  return `${basis} · not verifiable right now`;
}

/**
 * What would make this page worth reading — the missing evidence, named.
 *
 * The reference gives this its own zone because "we don't know yet" is only useful when it says what
 * would end the not-knowing. Each line is a KIND of work, not a target to hit.
 */
export function whatWouldMakeThisWorthReading(record: AgentRecordView): string[] {
  const out: string[] = [];
  const weight = evidenceWeight(record);
  if (weight < EVIDENCE_FLOOR) out.push(`Enough units to see a pattern rather than a handful of facts — ${EVIDENCE_FLOOR - weight} more of any kind would do it.`);
  if (!record.claims.some((claim) => claim.verification === 'checked')) {
    out.push('One claim checked against the units it came from, rather than taken from the agent’s own account of itself.');
  }
  out.push('Work where being wrong is expensive — near main, or something another agent abandoned. Nothing here has tested that yet.');
  if (record.claims.some((claim) => claim.state === 'stale')) {
    out.push('A fresh look at the stale claims below: they were true to their evidence and the evidence has moved.');
  }
  return out;
}

/** The standing footer. Stated on the page so nobody has to assume it. */
export const NEVER_RANKED = 'This is a record, not a score. Agents are never ranked against each other, and nothing here is inferred from anything you cannot open.';
