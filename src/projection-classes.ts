/**
 * projection-classes.ts — what an event class projects into the room, and why anyone should believe it.
 *
 * The room used to be tuned with a volume knob. Concern 26 was filed because `#fleet` had become 544
 * cards of pure noise; concern 27 was filed because removing the noise revealed that nothing signalled
 * at all. Both are symptoms of the same missing thing: no event class ever declared what it projects,
 * so the only available controls were "all of it" and "none of it".
 *
 * Two rules replace that knob:
 *
 * 1. **Each class declares its own projection.** Whether it reaches the room at all, and what it
 *    projects — never the raw event. An event is a fact about a unit; a card is a claim made to a
 *    person, and the two are not the same object.
 * 2. **A card is authored by the manager and cannot be forged by a unit.** A unit that could
 *    manufacture its own room presence could manufacture a gate verdict, a land, or a needs-you it was
 *    never given. Provenance is carried on the card and checked, not assumed from where it arrived.
 *
 * Everything not in a projecting class still stays at its node. The anti-firehose goal is unchanged —
 * only the mechanism is, from a binary rule to a declared contract.
 */

import {
	TRANSCRIPT_EVENT_DESIGN_REVISED,
	TRANSCRIPT_EVENT_GATE_VERDICT,
	TRANSCRIPT_EVENT_LAND_MERGE,
	TRANSCRIPT_EVENT_NEEDS_YOU,
	TRANSCRIPT_EVENT_PLAN_CARD,
	TRANSCRIPT_EVENT_PR_OPENED,
	TRANSCRIPT_EVENT_RETURN_EMIT,
	TRANSCRIPT_EVENT_UNIT_FAILED,
	TRANSCRIPT_EVENT_UNIT_SPAWNED,
	TRANSCRIPT_EVENT_UNIT_TURN_FINISHED,
	TRANSCRIPT_EVENT_VERIFICATION_RAN,
} from "./transcript-event-kinds.ts";

/** Where an event's card lands. */
export type Projection =
	/** The unit's own room. Reserved for things a person would want to be interrupted by. */
	| "room"
	/** The node's own channel. Real, addressable, and out of the way. */
	| "node";

/**
 * @substrate the return type of `projectionFor`, so it must be exported for any caller to name what
 * it got back. No consumer names it yet; concern 03's shell will, when it renders the reason a card
 * did or did not interrupt someone.
 */
export interface ProjectionClass {
	projection: Projection;
	/** Why this class does or does not reach a person. Written for someone arguing with the choice. */
	because: string;
	/** A room card must carry evidence a person can open. Node cards may be bare. */
	requiresEvidence: boolean;
}

/**
 * Every event class this system emits, and what it projects.
 * @substrate the declared table itself, read by the test that requires every class to state WHY it
 * does or does not interrupt a person. Production reads it through `projectionFor`; exposing the table
 * is what makes the policy auditable from outside rather than only observable one kind at a time.
 *
 * `room` is deliberately small. The standing law is that work waiting on a human is a defect, so
 * anything that interrupts has to earn it — and the 544-card run proves that an unearned interruption
 * does not merely annoy, it destroys the signal value of everything beside it.
 */
export const projectionClasses: Record<string, ProjectionClass> = {
	[TRANSCRIPT_EVENT_NEEDS_YOU]: {
		projection: "room",
		because: "Work has stopped and only a person can restart it. This is the one thing the room exists for.",
		requiresEvidence: true,
	},
	[TRANSCRIPT_EVENT_GATE_VERDICT]: {
		projection: "room",
		because: "A verdict is a claim about whether the work is sound. A person who cannot see it cannot disagree with it.",
		requiresEvidence: true,
	},
	[TRANSCRIPT_EVENT_LAND_MERGE]: {
		projection: "room",
		because: "Something left the machine. That is not reversible by doing more work, so it is said out loud.",
		requiresEvidence: true,
	},
	[TRANSCRIPT_EVENT_UNIT_FAILED]: {
		projection: "room",
		because: "A unit stopped in a way it did not choose. Everything else in the fleet keeps running, and the card says so.",
		requiresEvidence: true,
	},
	[TRANSCRIPT_EVENT_PLAN_CARD]: {
		projection: "room",
		because: "A plan changing shape is a decision about what the fleet will do next, and planning is the human's.",
		requiresEvidence: true,
	},
	[TRANSCRIPT_EVENT_DESIGN_REVISED]: {
		projection: "room",
		because: "A concern's status is the plan's own claim about itself. Silent revision is how plans start lying.",
		requiresEvidence: true,
	},
	[TRANSCRIPT_EVENT_UNIT_SPAWNED]: {
		projection: "node",
		because: "That work started is only interesting at the work. In the room it is one line per unit per run, which is the firehose.",
		requiresEvidence: false,
	},
	[TRANSCRIPT_EVENT_UNIT_TURN_FINISHED]: {
		projection: "node",
		because: "A turn ending says nothing about whether anything was achieved. It belongs where someone is reading the detail.",
		requiresEvidence: false,
	},
	[TRANSCRIPT_EVENT_VERIFICATION_RAN]: {
		projection: "node",
		because: "That tests RAN is not a result. The verdict projects; the run does not.",
		requiresEvidence: false,
	},
	[TRANSCRIPT_EVENT_PR_OPENED]: {
		projection: "node",
		because: "A branch became a pull request. Nothing has left the machine yet — the merge is what a person needs.",
		requiresEvidence: false,
	},
	[TRANSCRIPT_EVENT_RETURN_EMIT]: {
		projection: "node",
		because: "An echo of a steer the person just sent. Showing it back to them in the room is telling them what they did.",
		requiresEvidence: false,
	},
};

/**
 * Where this event class projects. An unclassified kind stays at its node — the quiet default.
 * @substrate production routes through `projectsToRoom`; this returns the `because` sentence too,
 * which concern 03's shell renders when a person asks why a card did or did not interrupt them.
 */
export function projectionFor(kind: string): ProjectionClass {
	// Fail QUIET rather than fail loud. An unclassified event reaching the room would let any new emit
	// site interrupt a person without anyone deciding it should — which is exactly how #fleet
	// accumulated 544 cards nobody chose. Here, unlike the delegation boundary, the safe default is
	// silence: the cost of a missed card is that someone looks at the node, and the cost of an unearned
	// one is that every card beside it stops being read.
	return (
		projectionClasses[kind] ?? {
			projection: "node",
			because: "Nobody has decided this belongs in the room, and an undecided event is not an interruption.",
			requiresEvidence: false,
		}
	);
}

/** True when this class reaches a person. */
export function projectsToRoom(kind: string): boolean {
	return projectionFor(kind).projection === "room";
}

/**
 * Provenance carried on every projected card: which node it is about, which agent produced it, and —
 * when a rule decided it — that rule's identity, so the sentence can be quoted at the point it acted.
 */
export interface CardProvenance {
	nodeId: string;
	agentId: string;
	/** Set when a learned rule (concern 11) settled the thing this card reports. */
	ruleId?: string;
	/** Ids of the evidence records behind the claim, openable by a person. */
	evidenceIds?: string[];
}

export class ForgedCardError extends Error {}

/**
 * Check a card's provenance before it is written.
 *
 * The forgery this prevents is specific: a unit emitting a transcript event that claims to be about a
 * DIFFERENT node, so its card lands in a room describing work it does not own. The check is that the
 * provenance names the emitting unit's own node — a unit may say anything about itself and nothing
 * about anyone else.
 *
 * A room card additionally has to carry evidence. A claim a person cannot open is a claim they have to
 * take on trust, and the whole point of a proof card is that they do not have to.
 */
export function assertAuthentic(kind: string, provenance: CardProvenance, emittingNodeId: string): void {
	if (provenance.nodeId !== emittingNodeId) {
		throw new ForgedCardError(
			`a unit at ${emittingNodeId} cannot author a card about ${provenance.nodeId} — a unit speaks for itself and nothing else`,
		);
	}
	const cls = projectionFor(kind);
	if (cls.projection === "room" && cls.requiresEvidence && !(provenance.evidenceIds?.length || provenance.ruleId)) {
		throw new ForgedCardError(
			`a ${kind} card interrupts a person, so it carries either the evidence behind it or the rule that decided it — this one carries neither`,
		);
	}
}
