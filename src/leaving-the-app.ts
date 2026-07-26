/**
 * leaving-the-app.ts — the gate on reaching a person who is not looking at the room.
 *
 * A push notification is the only thing this system does that can interrupt someone's evening. The
 * standing law is that work waiting on a human is a defect; a notification is that defect escaping
 * the building. So it is gated on three conditions AT ONCE, and two out of three does not leave.
 *
 * 1. **No rule can settle it.** If the fleet has been told what to do here, telling a person is
 *    telling them something they already decided.
 * 2. **It blocks work that would otherwise be moving.** A question nothing is waiting on can wait.
 * 3. **It can be answered in one sentence.** Anything needing a screen is not a notification, it is
 *    an appointment, and pretending otherwise wastes the interruption.
 *
 * And a mandatory delay, because many things that look blocking at minute zero are settled by minute
 * nine — by a retry, by a sibling finishing, by the agent finding another way. Sending immediately
 * optimises for the system's confidence rather than the person's evening.
 *
 * Every send is reviewed afterwards. A gate whose decisions are never checked drifts, and the
 * direction it drifts is always toward sending more.
 */

import { Result, Schema } from "effect";

/** Why a notification did or did not leave. Each condition is recorded, not just the verdict. */
const GateEvaluationSchema = Schema.Struct({
	id: Schema.String,
	nodeId: Schema.String,
	createdAt: Schema.Number,
	/** What the person would be asked. */
	question: Schema.String,
	/** Condition 1: no rule settles this. */
	noRuleSettles: Schema.Boolean,
	/** Condition 2: work that would otherwise move is stopped. */
	blocksMovingWork: Schema.Boolean,
	/** Condition 3: one sentence is enough to answer it. */
	answerableInOneSentence: Schema.Boolean,
	/** What is NOT affected — carried on the notification itself. */
	blastRadius: Schema.String,
	/** When it became eligible; the send waits out the recovery delay from here. */
	eligibleAt: Schema.Number,
	sentAt: Schema.optional(Schema.Number),
	/** Set when the reason to send disappeared during the delay. That is the delay working. */
	cancelledAt: Schema.optional(Schema.Number),
	cancelledBecause: Schema.optional(Schema.String),
});

const WorthItReviewSchema = Schema.Struct({
	evaluationId: Schema.String,
	reviewedAt: Schema.Number,
	/** Did interrupting them turn out to be right? */
	worthIt: Schema.Boolean,
	/** In the reviewer's words. A verdict with no reason cannot correct the gate. */
	because: Schema.String,
});

export type GateEvaluation = typeof GateEvaluationSchema.Type;
export type WorthItReview = typeof WorthItReviewSchema.Type;

const decodeEvaluation = Schema.decodeUnknownResult(GateEvaluationSchema);
export function readGateEvaluation(value: unknown): GateEvaluation | undefined {
	const decoded = decodeEvaluation(value);
	return Result.isFailure(decoded) ? undefined : decoded.success;
}

/**
 * How long the fleet gets to sort itself out before anyone is interrupted.
 *
 * Nine minutes is not tuned — it is the design's own example, and it is deliberately long enough to
 * feel wrong to the system and right to the person. If it turns out to be wrong, the worth-it reviews
 * are the evidence that should change it, not an opinion.
 */
export const RECOVERY_DELAY_MS = 9 * 60_000;

export interface GateDecision {
	send: boolean;
	/** Written for the person deciding whether the gate is behaving. */
	because: string;
	/** Conditions that failed, by name. Empty when all three held. */
	failed: string[];
}

/**
 * Should this leave the app, right now?
 *
 * Fails closed on every axis: a missing condition is a failed condition, an already-cancelled
 * evaluation never sends, and the delay is enforced here rather than trusted to a caller's timer.
 */
export function shouldLeaveTheApp(evaluation: GateEvaluation, now: number): GateDecision {
	if (evaluation.sentAt !== undefined) return { send: false, because: "This already reached them; sending again would be the same interruption twice.", failed: [] };
	if (evaluation.cancelledAt !== undefined) {
		return { send: false, because: `The reason to interrupt them went away on its own${evaluation.cancelledBecause ? ` — ${evaluation.cancelledBecause}` : ""}. That is the delay doing its job.`, failed: [] };
	}

	const failed: string[] = [];
	if (!evaluation.noRuleSettles) failed.push("a rule already settles this");
	if (!evaluation.blocksMovingWork) failed.push("nothing is waiting on it");
	if (!evaluation.answerableInOneSentence) failed.push("it needs more than one sentence to answer");
	if (failed.length > 0) {
		return {
			send: false,
			because: `Not worth their evening: ${failed.join(", and ")}. All three conditions have to hold at once, and ${3 - failed.length} did.`,
			failed,
		};
	}

	const waited = now - evaluation.eligibleAt;
	if (waited < RECOVERY_DELAY_MS) {
		const left = Math.ceil((RECOVERY_DELAY_MS - waited) / 60_000);
		return { send: false, because: `All three conditions hold, but the fleet gets ${left} more minute${left === 1 ? "" : "s"} to sort it out first. Most things that look blocking at minute zero are gone by minute nine.`, failed: [] };
	}
	return { send: true, because: `Nothing here can settle this, it is holding up work that would otherwise be moving, and one sentence answers it. ${evaluation.blastRadius}`, failed: [] };
}

/** The notification text. States what it needs AND what is not affected. */
export function notificationText(evaluation: GateEvaluation): string {
	return `${evaluation.question.trim()} ${evaluation.blastRadius.trim()}`;
}

export interface GateHealth {
	sent: number;
	cancelledByDelay: number;
	reviewed: number;
	worthIt: number;
	/** Written for a person deciding whether to trust the gate. */
	sentence: string;
}

/**
 * Whether the gate is behaving, in the only terms that matter: how often it interrupted someone, how
 * often the delay made the interruption unnecessary, and how often the person said it was worth it.
 *
 * Unreviewed sends are counted and named. A gate whose sends are never reviewed has no evidence it is
 * calibrated, and "no evidence of a problem" is not evidence of no problem.
 */
export function gateHealth(evaluations: readonly GateEvaluation[], reviews: readonly WorthItReview[]): GateHealth {
	const sent = evaluations.filter((evaluation) => evaluation.sentAt !== undefined);
	const cancelledByDelay = evaluations.filter((evaluation) => evaluation.cancelledAt !== undefined).length;
	const byId = new Map(reviews.map((review) => [review.evaluationId, review]));
	const reviewed = sent.filter((evaluation) => byId.has(evaluation.id));
	const worthIt = reviewed.filter((evaluation) => byId.get(evaluation.id)?.worthIt).length;

	if (sent.length === 0) {
		return {
			sent: 0, cancelledByDelay, reviewed: 0, worthIt: 0,
			sentence: cancelledByDelay === 0
				? "Nothing has left the app. Nobody has been interrupted outside the room."
				: `Nothing has left the app. ${cancelledByDelay} thing${cancelledByDelay === 1 ? "" : "s"} looked urgent and then sorted ${cancelledByDelay === 1 ? "itself" : "themselves"} out during the wait.`,
		};
	}
	const unreviewed = sent.length - reviewed.length;
	const tail = unreviewed > 0
		? ` ${unreviewed} of them ${unreviewed === 1 ? "has" : "have"} not been reviewed, so there is no evidence either way about ${unreviewed === 1 ? "it" : "those"}.`
		: "";
	return {
		sent: sent.length, cancelledByDelay, reviewed: reviewed.length, worthIt,
		sentence: `${sent.length} interruption${sent.length === 1 ? "" : "s"} left the app; ${worthIt} of the ${reviewed.length} reviewed ${reviewed.length === 1 ? "was" : "were"} judged worth it.${tail} ${cancelledByDelay} more sorted ${cancelledByDelay === 1 ? "itself" : "themselves"} out during the wait.`,
	};
}
