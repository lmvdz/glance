/**
 * gate-wiring.ts — turning a stopped unit into the three conditions, honestly.
 *
 * `leaving-the-app.ts` decides whether something may interrupt a person. It has been correct and
 * unreachable since it was written, because nothing ever built it a `GateEvaluation`. This module is
 * that missing half, and it is deliberately separate: the DECISION is worth reading on its own, and
 * so is the evidence the decision is made on.
 *
 * Every condition here is answered from something the daemon actually knows. Where it cannot know,
 * the answer is NO, because the failure modes are not symmetric: a notification that should have gone
 * and did not costs someone a slower afternoon, and one that should not have gone and did costs them
 * their evening and, after a few, their trust in every future one.
 */

import type { AgentDTO, PendingRequest } from "./types.ts";

/** The subset of an active rule this needs: what a human said the fleet may settle on their behalf. */
export interface SettlingRule {
	sentence: string;
	settles: readonly string[];
}

/**
 * Condition 1 — no rule can settle it.
 *
 * A rule that names this pending's class means the human already decided; telling them again is
 * telling them something they have already said. Matching is on the recorded `settles` classes, never
 * on the sentence text: a rule's prose is for a person to read, and pattern-matching English to decide
 * whether to interrupt somebody would be exactly the kind of guess this gate exists to refuse.
 */
export function noRuleSettles(request: PendingRequest, rules: readonly SettlingRule[]): boolean {
	const classes = new Set(rules.flatMap((rule) => rule.settles.map((cls) => cls.trim().toLowerCase())).filter(Boolean));
	if (classes.size === 0) return true;
	const candidates = [request.kind, request.title].map((value) => (value ?? "").trim().toLowerCase()).filter(Boolean);
	return !candidates.some((candidate) => classes.has(candidate));
}

/**
 * Condition 2 — it blocks work that would otherwise be moving.
 *
 * The unit itself is stopped on this question, which is the plainest form of blocked work there is.
 * A unit that was already stopped for some OTHER reason is not blocked by this question, so `input`
 * is required rather than merely "not running".
 */
export function blocksMovingWork(agent: Pick<AgentDTO, "status">): boolean {
	return agent.status === "input";
}

/**
 * Condition 3 — one sentence can answer it.
 *
 * A confirm, or a select with a small closed set, is answerable in a sentence. Free text and an
 * editor are not: they need a screen, which makes them an appointment rather than a notification, and
 * sending one wastes the interruption on something the person cannot finish from a lock screen.
 *
 * An unknown kind answers NO. This is the asymmetry above: not knowing is not permission.
 */
export function answerableInOneSentence(request: PendingRequest): boolean {
	if (request.kind === "confirm") return true;
	if (request.kind === "select") return (request.options?.length ?? 0) > 0 && (request.options?.length ?? 0) <= 4;
	return false;
}

/**
 * What is NOT affected, which rides on the notification itself.
 *
 * The reference never sends a demand without its blast radius: the point of being interrupted at
 * eight in the evening is to learn both that something needs you AND that the rest is fine. A count
 * of what is still moving is the cheapest honest form of that.
 */
export function blastRadius(agents: readonly Pick<AgentDTO, "id" | "status">[], stoppedId: string): string {
	const others = agents.filter((agent) => agent.id !== stoppedId);
	const moving = others.filter((agent) => agent.status === "working" || agent.status === "starting").length;
	if (others.length === 0) return "Nothing else is running, so nothing else is affected.";
	if (moving === 0) return `The other ${others.length} unit${others.length === 1 ? "" : "s"} ${others.length === 1 ? "is" : "are"} not moving either, so this is not the only thing stopped.`;
	return `${moving} other unit${moving === 1 ? "" : "s"} ${moving === 1 ? "is" : "are"} still running and unaffected.`;
}

export interface BuildEvaluationInput {
	request: PendingRequest;
	agent: Pick<AgentDTO, "id" | "name" | "status">;
	fleet: readonly Pick<AgentDTO, "id" | "status">[];
	rules: readonly SettlingRule[];
	nodeId: string;
	now: number;
}

/**
 * The evaluation a stopped unit produces, recorded whether or not it will ever send.
 *
 * Declining is as much a decision as sending, and a gate that only records what it sent cannot be
 * audited for what it suppressed. `eligibleAt` starts the mandatory wait from NOW rather than from
 * the question's creation, so a question that arrives during a daemon restart does not skip the wait
 * on a technicality.
 */
export function buildEvaluation(input: BuildEvaluationInput): {
	id: string;
	nodeId: string;
	createdAt: number;
	question: string;
	noRuleSettles: boolean;
	blocksMovingWork: boolean;
	answerableInOneSentence: boolean;
	blastRadius: string;
	eligibleAt: number;
} {
	const { request, agent, fleet, rules, nodeId, now } = input;
	return {
		// Stable per (unit, pending): a restart must not create a second evaluation for one question,
		// which is the same defect the room's own re-announce had.
		id: `${agent.id}:${request.id}`,
		nodeId,
		createdAt: request.createdAt ?? now,
		question: `${agent.name || agent.id} needs you: ${request.title}`,
		noRuleSettles: noRuleSettles(request, rules),
		blocksMovingWork: blocksMovingWork(agent),
		answerableInOneSentence: answerableInOneSentence(request),
		blastRadius: blastRadius(fleet, agent.id),
		eligibleAt: now,
	};
}
