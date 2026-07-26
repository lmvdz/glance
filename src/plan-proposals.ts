/**
 * plan-proposals.ts — between a sentence and running agents there is something a person can change.
 *
 * The standing law is that humans plan and review plans; agents build. This module is where that law
 * is either honoured or quietly broken, because it is the only point at which a person sees the work
 * before it exists. A screen that offers approve-or-reject has already broken it: rejecting a
 * seven-unit decomposition because the third unit is wrong is not reviewing a plan, it is bouncing one.
 *
 * Four properties, and they are all about what the person can see and do:
 *
 * 1. **Their original words are kept verbatim**, beside everything derived from them. A person must be
 *    able to check the derivation against what they actually said, not against a paraphrase.
 * 2. **The assumptions are stated.** Getting from one sentence to seven units requires guessing, and an
 *    unstated guess is indistinguishable from a fact.
 * 3. **Consequences, not counts.** "Four agents wake, three files are touched, nothing lands without
 *    you" — not "7 tasks".
 * 4. **The shape can change.** Split, merge, reorder, drop. Approve/reject is not review.
 *
 * And one refusal: an ambiguous goal asks BEFORE spawning, never after.
 */

import { Result, Schema } from "effect";

/** A single proposed piece of work. Not a node — nothing exists yet. */
const ProposedUnitSchema = Schema.Struct({
	/** Address within the proposal, so it can be said out loud: "3.2". */
	address: Schema.String,
	title: Schema.String,
	/** Why this is a separate unit rather than part of another. */
	rationale: Schema.String,
	/** Addresses of units that must finish first. */
	after: Schema.Array(Schema.String),
	/** Paths this unit expects to touch, for the consequence sentence. Empty when not yet known. */
	touches: Schema.Array(Schema.String),
});

const AssumptionSchema = Schema.Struct({
	/** What was assumed, in plain words. */
	text: Schema.String,
	/** What the planner would have needed to know instead. Makes the assumption checkable. */
	insteadOf: Schema.String,
});

const PlanProposalSchema = Schema.Struct({
	id: Schema.String,
	/** The person's own sentence, unedited. Never paraphrased, never normalised. */
	originalWords: Schema.String,
	authorId: Schema.String,
	createdAt: Schema.Number,
	repo: Schema.String,
	assumptions: Schema.Array(AssumptionSchema),
	units: Schema.Array(ProposedUnitSchema),
	/**
	 * Set when the planner could not responsibly propose anything. Carries the question to ask. A
	 * proposal in this state has no units — it asks before spawning, never after.
	 */
	needsClarification: Schema.optional(Schema.String),
	status: Schema.Literals(["proposed", "started", "abandoned"]),
	startedAt: Schema.optional(Schema.Number),
});

export type ProposedUnit = typeof ProposedUnitSchema.Type;
export type Assumption = typeof AssumptionSchema.Type;
export type PlanProposal = typeof PlanProposalSchema.Type;

const decode = Schema.decodeUnknownResult(PlanProposalSchema);

/** Decode one persisted proposal. Anything that does not decode whole is dropped, never half-read. */
export function readPlanProposal(value: unknown): PlanProposal | undefined {
	const decoded = decode(value);
	return Result.isFailure(decoded) ? undefined : decoded.success;
}

/**
 * Which units can start immediately: those whose prerequisites are all satisfied.
 * @substrate what the consequence sentence counts, and the seam concern 03's review surface reads to
 * show what wakes on start. Tested directly because getting it wrong changes what a person is told.
 */
export function startableNow(units: readonly ProposedUnit[]): ProposedUnit[] {
	return units.filter((unit) => unit.after.length === 0);
}

/**
 * What will happen if this is started, in consequences rather than counts.
 *
 * The count version — "7 tasks queued" — tells a person nothing they can act on. The consequence
 * version tells them how much of the machine wakes up, what gets touched, and crucially what will NOT
 * happen without them. That last clause is the blast radius law: answer the anxious question before it
 * is asked.
 */
export function consequenceSentence(proposal: PlanProposal): string {
	if (proposal.needsClarification) {
		return `Nothing starts yet. ${proposal.needsClarification}`;
	}
	const first = startableNow(proposal.units);
	const waiting = proposal.units.length - first.length;
	const touches = [...new Set(proposal.units.flatMap((unit) => unit.touches))];

	const agents = first.length === 1 ? "One agent wakes" : `${first.length} agents wake`;
	const parts = [
		waiting > 0
			? `${agents} now; ${waiting === 1 ? "one more waits" : `${waiting} more wait`} on work that has to finish first.`
			: `${agents}, all at once — nothing here waits on anything else.`,
	];
	if (touches.length > 0) {
		parts.push(`${touches.length === 1 ? "One file is" : `${touches.length} files are`} touched: ${touches.slice(0, 4).join(", ")}${touches.length > 4 ? `, and ${touches.length - 4} more` : ""}.`);
	} else {
		parts.push("Which files get touched is not known yet — the units work that out as they go.");
	}
	// Never dropped, whatever else is true.
	parts.push("Nothing lands without you.");
	return parts.join(" ");
}

/** The shape-changing operations a person can perform. Approve/reject alone is not review. */
export type ReshapeOp =
	| { op: "drop"; address: string }
	| { op: "reorder"; address: string; after: readonly string[] }
	| { op: "retitle"; address: string; title: string }
	| { op: "split"; address: string; into: ReadonlyArray<{ title: string; rationale: string }> }
	| { op: "merge"; addresses: readonly string[]; title: string; rationale: string };

export class ReshapeError extends Error {}

/**
 * Apply one shape change and return the new unit list.
 *
 * Refuses to leave the plan in a state that cannot run: a drop that orphans a dependent, a reorder
 * that creates a cycle, a merge of units that do not exist. Silently repairing those would be worse
 * than refusing — the person would get a plan they did not design.
 */
export function reshape(units: readonly ProposedUnit[], op: ReshapeOp): ProposedUnit[] {
	const byAddress = new Map(units.map((unit) => [unit.address, unit]));
	const require = (address: string): ProposedUnit => {
		const unit = byAddress.get(address);
		if (!unit) throw new ReshapeError(`there is no unit ${address} in this proposal`);
		return unit;
	};

	switch (op.op) {
		case "drop": {
			require(op.address);
			const dependents = units.filter((unit) => unit.after.includes(op.address)).map((unit) => unit.address);
			if (dependents.length > 0) {
				throw new ReshapeError(`${op.address} cannot be dropped while ${dependents.join(" and ")} still wait on it — drop or reorder ${dependents.length === 1 ? "it" : "those"} first`);
			}
			return units.filter((unit) => unit.address !== op.address);
		}
		case "retitle": {
			require(op.address);
			return units.map((unit) => (unit.address === op.address ? { ...unit, title: op.title } : unit));
		}
		case "reorder": {
			require(op.address);
			for (const address of op.after) require(address);
			if (op.after.includes(op.address)) throw new ReshapeError(`${op.address} cannot wait on itself`);
			const next = units.map((unit) => (unit.address === op.address ? { ...unit, after: [...op.after] } : unit));
			const cycle = findCycle(next);
			if (cycle) throw new ReshapeError(`that would make ${cycle.join(" wait on ")} wait on ${cycle[0]} — nothing could start`);
			return next;
		}
		case "split": {
			const original = require(op.address);
			if (op.into.length < 2) throw new ReshapeError("a split produces at least two units");
			const parts = op.into.map((part, index) => ({
				address: `${op.address}.${index + 1}`,
				title: part.title,
				rationale: part.rationale,
				after: index === 0 ? [...original.after] : [`${op.address}.${index}`],
				touches: [] as string[],
			}));
			// Anything that waited on the original now waits on the last part of the split.
			const last = parts[parts.length - 1]!.address;
			return units.flatMap((unit) =>
				unit.address === op.address
					? parts
					: [{ ...unit, after: unit.after.map((address) => (address === op.address ? last : address)) }],
			);
		}
		case "merge": {
			if (op.addresses.length < 2) throw new ReshapeError("a merge needs at least two units");
			const merged = op.addresses.map(require);
			const address = merged[0]!.address;
			const removed = new Set(op.addresses.slice(1));
			const after = [...new Set(merged.flatMap((unit) => unit.after).filter((dep) => !op.addresses.includes(dep)))];
			const touches = [...new Set(merged.flatMap((unit) => unit.touches))];
			return units.flatMap((unit) => {
				if (removed.has(unit.address)) return [];
				if (unit.address === address) return [{ address, title: op.title, rationale: op.rationale, after, touches }];
				return [{ ...unit, after: [...new Set(unit.after.map((dep) => (removed.has(dep) ? address : dep)))] }];
			});
		}
	}
}

/** The first dependency cycle found, as a list of addresses, or undefined. */
function findCycle(units: readonly ProposedUnit[]): string[] | undefined {
	const byAddress = new Map(units.map((unit) => [unit.address, unit]));
	const state = new Map<string, "visiting" | "done">();
	const stack: string[] = [];
	const walk = (address: string): string[] | undefined => {
		if (state.get(address) === "done") return undefined;
		if (state.get(address) === "visiting") return [...stack.slice(stack.indexOf(address)), address];
		state.set(address, "visiting");
		stack.push(address);
		for (const dep of byAddress.get(address)?.after ?? []) {
			const found = walk(dep);
			if (found) return found;
		}
		stack.pop();
		state.set(address, "done");
		return undefined;
	};
	for (const unit of units) {
		const found = walk(unit.address);
		if (found) return found;
	}
	return undefined;
}
