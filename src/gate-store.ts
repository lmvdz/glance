/**
 * gate-store.ts — the durable record of every time this product considered interrupting someone.
 *
 * Not just the sends. Declining is as much a decision as sending, and a gate that only records what
 * it sent cannot be audited for what it suppressed — which is the direction a notification gate
 * actually drifts, and the direction nobody notices.
 *
 * The record survives restarts on purpose. The nine-minute wait is meaningless if a daemon bounce
 * either fires everything that was waiting or forgets it was waiting at all; both have happened to
 * this room's own cards.
 */

import { JsonlLog } from "./jsonl-log.ts";
import type { GateEvaluation, WorthItReview } from "./leaving-the-app.ts";

/** One line of the record: an evaluation as it stands, or a review of one that was sent. */
export type GateRecord =
	| ({ type: "evaluation" } & GateEvaluation)
	| ({ type: "review" } & WorthItReview);

export class GateStore {
	private readonly log: JsonlLog<GateRecord>;

	constructor(path: string, logger?: (message: string) => void) {
		this.log = new JsonlLog<GateRecord>({ path, max: 500, log: logger });
	}

	/**
	 * Latest-wins per evaluation id.
	 *
	 * The file is append-only, so an evaluation that was created, then sent, then reviewed appears
	 * several times; the last line is the truth. Reconstructing by fold rather than by mutation is
	 * what lets the raw file stay a legible history of what the gate thought and when.
	 */
	evaluations(): GateEvaluation[] {
		const byId = new Map<string, GateEvaluation>();
		for (const record of this.log.recent()) {
			if (record.type !== "evaluation") continue;
			const { type: _type, ...evaluation } = record;
			byId.set(evaluation.id, evaluation as GateEvaluation);
		}
		return [...byId.values()];
	}

	reviews(): WorthItReview[] {
		const byId = new Map<string, WorthItReview>();
		for (const record of this.log.recent()) {
			if (record.type !== "review") continue;
			const { type: _type, ...review } = record;
			byId.set(review.evaluationId, review as WorthItReview);
		}
		return [...byId.values()];
	}

	/** The evaluation for one question, or nothing. */
	get(id: string): GateEvaluation | undefined {
		return this.evaluations().find((evaluation) => evaluation.id === id);
	}

	/**
	 * Record an evaluation, but never re-open one that has already resolved.
	 *
	 * A question that was sent or cancelled is finished. Re-recording it — which a restart would
	 * otherwise do, since the unit still has the pending — would restart its wait and eventually
	 * interrupt somebody a second time about the same thing.
	 */
	put(evaluation: GateEvaluation): boolean {
		const existing = this.get(evaluation.id);
		if (existing && (existing.sentAt !== undefined || existing.cancelledAt !== undefined)) return false;
		if (existing) {
			// Keep the ORIGINAL eligibleAt: the wait is measured from when the question was first
			// seen, not from the last time the daemon looked at it.
			this.log.append({ type: "evaluation", ...evaluation, eligibleAt: existing.eligibleAt, createdAt: existing.createdAt });
			return false;
		}
		this.log.append({ type: "evaluation", ...evaluation });
		return true;
	}

	markSent(id: string, at: number): void {
		const existing = this.get(id);
		if (!existing || existing.sentAt !== undefined || existing.cancelledAt !== undefined) return;
		this.log.append({ type: "evaluation", ...existing, sentAt: at });
	}

	/** The delay working: the reason to interrupt went away before anyone was interrupted. */
	markCancelled(id: string, at: number, because: string): void {
		const existing = this.get(id);
		if (!existing || existing.sentAt !== undefined || existing.cancelledAt !== undefined) return;
		this.log.append({ type: "evaluation", ...existing, cancelledAt: at, cancelledBecause: because });
	}

	review(review: WorthItReview): void {
		this.log.append({ type: "review", ...review });
	}

	/** Sends with no review yet — the only ones a person can still be asked about. */
	awaitingReview(): GateEvaluation[] {
		const reviewed = new Set(this.reviews().map((review) => review.evaluationId));
		return this.evaluations().filter((evaluation) => evaluation.sentAt !== undefined && !reviewed.has(evaluation.id));
	}
}
