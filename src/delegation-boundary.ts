/**
 * delegation-boundary.ts — the actions autonomy may not take on its own initiative.
 *
 * This is a DIFFERENT axis from `authz.ts`. That map answers "which human tier may do what".
 * This one answers "may this be done without a human deciding at all". A human admin may land a
 * pull request; a rule the fleet taught itself may never decide to.
 *
 * Product policy, not configuration. There is no setting that empties this class, and no learned
 * rule may widen it — `NodeRecordStore` refuses a rule whose `settles` list names an action in it,
 * at creation rather than at invocation, so an overreaching rule cannot exist to be evaluated.
 *
 * What CAN happen is that a human argues a specific action out of the class deliberately: a
 * `DelegationGrant`, which records who granted it, when, and why. That is the only door, it is
 * attributable, and it is revocable. An env flag is not a decision anybody made — so where one
 * previously enabled autonomy in this class (`OMP_SQUAD_AUTOLAND`), it now materialises as a grant
 * with a stated author, which preserves the behaviour and makes it answerable.
 *
 * Enforcement is server-side, at the same chokepoints authz uses. A label in the client is not
 * enforcement; it is a description of enforcement that may or may not exist.
 */

import type { ClientCommand } from "./types.ts";

export const nonDelegatableClasses = ["credentials", "spend", "deletion", "publishing", "legal"] as const;
export type NonDelegatableClass = (typeof nonDelegatableClasses)[number];

/**
 * One sentence per member on why no rule can cover it. These are rendered to the human, so they are
 * written for a person deciding whether to argue with the boundary — not as internal labels.
 */
export const boundaryJustification: Record<NonDelegatableClass, string> = {
	credentials:
		"A credential you did not hand over is not one you agreed to spend. Nothing the fleet learns about your habits tells it whose secret this is.",
	spend:
		"Money leaves and does not come back. The fleet can observe that you approved four payouts; it cannot observe that you would have approved the fifth.",
	deletion:
		"Deletion is the one outcome no later decision can reach. Everything else in this system is recoverable by doing more work.",
	publishing:
		"Once something is outside this machine it is outside your control — a tag, a merge, a message someone else has already read.",
	legal:
		"A licence, a contract, or a disclosure is a claim made on your behalf by name. Only you can make a claim in your own name.",
};

/**
 * Actions in the non-delegatable class. Keyed by the action name used at the enforcement point.
 *
 * Only actions with a real backing system appear here. Following `authz.ts`'s own discipline: an
 * action mapped to a class that does not exist yet would authorize against nothing, which reads as
 * enforcement while being decoration. `credentials` and `legal` therefore have no entries today —
 * the class exists, is shown, and is enforced the moment an action lands in it.
 */
const nonDelegatableActions: Record<string, NonDelegatableClass> = {
	/** Merges a branch into the trunk and pushes it. Leaves the machine. */
	land: "publishing",
	/** Same act, reached through the feature/plan surface. */
	landFeature: "publishing",
	/** Removes an agent AND its worktree — uncommitted work included. */
	remove: "deletion",
	/** Removes a feature, its plan directory, and detaches its agents. */
	deleteFeature: "deletion",
	/** Disburses a reward through a payment provider. */
	disburseReward: "spend",
};

/**
 * Actions deliberately judged delegatable, listed so the exhaustiveness test can tell "decided to be
 * safe" apart from "nobody looked at it". Adding a command without classifying it fails that test —
 * which is the point. A new hole should require someone to open it on purpose.
 */
const delegatableActions = [
	"snapshot",
	"subscribe",
	"typing",
	"prompt",
	"answer",
	"interrupt",
	"message",
	"notify",
	"create",
	"commission",
	"set-mode",
	"set-model",
	"kill",
	"restart",
	"fork",
	"continue",
] as const;

/**
 * Every action name this module has an opinion about.
 * @substrate read by the exhaustiveness test, which is the mechanism that keeps a new action from
 * defaulting into being permitted. It has no production caller by design — its job is to make the
 * classification lists auditable from outside.
 */
export function classifiedActions(): string[] {
	return [...Object.keys(nonDelegatableActions), ...delegatableActions];
}

/** The class an action belongs to, or undefined when it is delegatable. */
export function nonDelegatableClassOf(action: string): NonDelegatableClass | undefined {
	return nonDelegatableActions[action];
}

/** True when this action has been considered at all. An unclassified action is a gap, not a permission. */
function isClassified(action: string): boolean {
	return action in nonDelegatableActions || (delegatableActions as readonly string[]).includes(action);
}

/** A human argued one action out of the class. Attributable and revocable, never a default. */
export interface DelegationGrant {
	id: string;
	action: string;
	class: NonDelegatableClass;
	/** Who decided. Never "system", never an env var name on its own. */
	grantedBy: string;
	grantedAt: number;
	/** The human's own words for why. Rendered wherever the grant takes effect. */
	reason: string;
	revokedAt?: number;
	revokedBy?: string;
}

export class DelegationBoundaryError extends Error {
	constructor(
		readonly action: string,
		readonly boundaryClass: NonDelegatableClass,
	) {
		super(
			`${action} is a ${boundaryClass} action and needs a person. ${boundaryJustification[boundaryClass]} Nothing else in the fleet is affected — this one action is waiting, and everything already running keeps running.`,
		);
		this.name = "DelegationBoundaryError";
	}
}

/** Who is taking an action: a person, or the fleet acting on its own initiative. */
export type Authority = "human" | "autonomous";

/**
 * The enforcement point. Throws when the fleet tries, on its own initiative, to take an action in
 * the non-delegatable class without a live grant.
 *
 * Fails closed on every axis that matters: an unknown action taken autonomously is refused when it
 * cannot be shown to be delegatable, a revoked grant is not a grant, and a grant for a different
 * action does not carry.
 */
export function assertHumanAuthority(action: string, authority: Authority, grants: readonly DelegationGrant[] = []): void {
	if (authority === "human") return;
	if (!isClassified(action)) {
		// Nobody has decided whether this may be done autonomously, and "nobody decided" must not
		// resolve as "allowed". Refused as the most restrictive class until someone classifies it —
		// the exhaustiveness test exists so this branch stays unreachable in practice.
		throw new DelegationBoundaryError(action, "legal");
	}
	const boundaryClass = nonDelegatableClassOf(action);
	if (!boundaryClass) return;
	const granted = grants.some((grant) => grant.action === action && grant.class === boundaryClass && grant.revokedAt === undefined);
	if (!granted) throw new DelegationBoundaryError(action, boundaryClass);
}

/** The live grant covering an action, so it can be quoted where it takes effect. */
export function grantFor(action: string, grants: readonly DelegationGrant[]): DelegationGrant | undefined {
	return grants.find((grant) => grant.action === action && grant.revokedAt === undefined);
}

/** The action name a command maps to, for classification purposes. */
export function commandAction(cmd: ClientCommand): string {
	return cmd.type;
}
