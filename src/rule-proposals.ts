/**
 * rule-proposals.ts — noticing that a human keeps making the same decision, and offering to stop asking.
 *
 * There is no settings page for autonomy, and that is the point. A rule is never configured; it is
 * proposed from decisions the person actually made, and it is stored as their own sentence so it can
 * be quoted verbatim wherever it decides work.
 *
 * Three properties make a proposal honest, and all three are enforced here rather than left to the
 * caller:
 *
 * 1. **It replays real decisions.** Every proposal cites the decision records it was generated from,
 *    with what was asked, what was chosen, and how long it took. A proposal that cannot show its
 *    evidence is a configuration prompt with better manners.
 * 2. **It states what it would NOT have caught.** The design's own example keeps a credential
 *    interruption visible and says plainly that the rule would not have touched it. A rule that
 *    oversells its reach is worse than no rule, because the human calibrates on the overselling.
 * 3. **It refuses to generalise across different reasons.** Four "yes"es to four different kinds of
 *    question is not a pattern, it is a coincidence with a sample size.
 *
 * Nothing here writes a rule. A proposal is an offer; only a human's sentence becomes a rule.
 */

import { nonDelegatableClassOf } from "./delegation-boundary.ts";
import type { DecisionRecord, NodeRecord } from "./node-records.ts";
import { proposalSampleFloor } from "./unknowns.ts";

/** Below this, a repetition is a coincidence. Deliberately not configurable — see `sampleFloor`. */
export const MIN_SAMPLE = 4;

export interface RuleProposal {
	action: string;
	evidence: DecisionRecord[];
	consistentChoice: string;
	reason: DecisionRecord["reason"];
	wouldNotHaveCaught: DecisionRecord[];
	sentence: string;
}

/**
 * The question a decision is "about", used to tell repetitions apart. Deliberately the verbatim
 * question rather than a fuzzy match: two questions that merely look similar are two questions, and
 * generalising across them is how a rule ends up settling something nobody agreed to.
 */
function subject(decision: DecisionRecord): string {
	return decision.question.trim().toLowerCase();
}

function minutes(ms: number): string {
	const m = Math.round(ms / 60_000);
	if (m < 1) return "under a minute";
	return m === 1 ? "a minute" : `${m} minutes`;
}

/**
 * Propose rules from a node's decision history.
 *
 * Fails closed in the ways that matter: decisions in the non-delegatable class never generate a
 * proposal (no rule may widen that boundary, so offering one would be offering something that cannot
 * be accepted), and neither do actions whose class says they always reach a person.
 *
 * The unknowns ledger (concern 16) can RAISE the floor for a subject it has not settled yet — an offer
 * made below its own declared evidence requirement would be the product contradicting itself in the
 * same breath. It can never lower it.
 */
export function proposeRules(records: readonly NodeRecord[], opts: { sampleFloor?: number } = {}): RuleProposal[] {
	const floor = Math.max(MIN_SAMPLE, opts.sampleFloor ?? MIN_SAMPLE);
	const decisions = records.filter((record): record is DecisionRecord => record.kind === "decision");
	const bySubject = new Map<string, DecisionRecord[]>();
	for (const decision of decisions) {
		if (decision.boundaryClass || nonDelegatableClassOf(decision.chose)) continue;
		const key = `${decision.reason}${subject(decision)}`;
		bySubject.set(key, [...(bySubject.get(key) ?? []), decision]);
	}

	const proposals: RuleProposal[] = [];
	for (const [key, group] of bySubject) {
		const ordered = [...group].sort((a, b) => a.decidedAt - b.decidedAt);
		const action = subject(ordered[0]!);
		const requiredSample = Math.max(floor, proposalSampleFloor(records, action) ?? MIN_SAMPLE);
		if (ordered.length < requiredSample) continue;
		const choices = new Set(ordered.map((decision) => decision.chose.trim()));
		if (choices.size !== 1) continue;

		const consistentChoice = ordered[0]!.chose.trim();
		const wouldNotHaveCaught = decisions.filter(
			(decision) => decision.decidedAt >= ordered[0]!.decidedAt && !(`${decision.reason}${subject(decision)}` === key),
		);
		const median = ordered.map((decision) => decision.decidedAt - decision.askedAt).sort((a, b) => a - b)[Math.floor(ordered.length / 2)] ?? 0;
		proposals.push({
			action,
			evidence: ordered,
			consistentChoice,
			reason: ordered[0]!.reason,
			wouldNotHaveCaught,
			sentence: proposalSentence(ordered, consistentChoice, wouldNotHaveCaught, median),
		});
	}
	return proposals.sort((a, b) => b.evidence.length - a.evidence.length || a.action.localeCompare(b.action));
}

/**
 * The proposal as the human reads it. Every clause states a fact AND what it means, and the last
 * clause is the one that matters most: what this would not have caught.
 */
function proposalSentence(evidence: DecisionRecord[], choice: string, wouldNotHaveCaught: DecisionRecord[], medianLatencyMs: number): string {
	const times = evidence.length;
	const question = evidence[0]!.question.trim();
	const head = `${times} times you were asked "${question}", and ${times} times you said "${choice}" — the last ${times === 2 ? "twice" : `${times} times`} taking a median of ${minutes(medianLatencyMs)} to answer. Should the fleet stop asking?`;
	if (wouldNotHaveCaught.length === 0) return `${head} Nothing else interrupted you in this window, so this rule would have made the difference between being asked and not being asked at all.`;
	const spared = wouldNotHaveCaught.slice(0, 2).map((decision) => `"${decision.question.trim()}"`).join(" and ");
	return `${head} It would not have caught ${spared}${wouldNotHaveCaught.length > 2 ? ` and ${wouldNotHaveCaught.length - 2} more` : ""} — those still reach you.`;
}
