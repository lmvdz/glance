import { Result, Schema } from "effect";
import type { Store } from "./dal/store.ts";
import { nonDelegatableClassOf, nonDelegatableClasses, type NonDelegatableClass } from "./delegation-boundary.ts";

/**
 * Durable evidence attached to a node, as ASSOCIATED RECORDS — never as optional fields overloaded
 * onto `Node`. `Node` answers "what is this piece of work"; these answer "what do we know, who said
 * so, and when". Their lifetimes differ: a node settles, its evidence outlives it.
 *
 * Every record is defined ONCE, as a schema, and decoded whole. The earlier shape declared a
 * TypeScript interface and hand-wrote a per-kind reader beside it, which silently dropped any field
 * the reader forgot — a withdrawn rule round-tripped with no withdrawal time and no pointer to what
 * replaced it. Deriving the type from the schema makes that class of drift impossible: a field that
 * exists in the type exists in the decoder.
 */

/**
 * Product policy, not configuration. Learned rules can never settle work in these classes.
 * Re-exported from `delegation-boundary.ts` rather than restated, because two copies of a boundary
 * are two boundaries, and they drift.
 */
export { nonDelegatableClasses, type NonDelegatableClass };

const base = {
	id: Schema.String,
	nodeId: Schema.String,
	createdAt: Schema.Number,
};

/**
 * A rule is the human's exact sentence, never a serialised predicate — so it can be quoted verbatim
 * wherever it decides work. `proposedFrom` holds the prior decisions the proposal replayed, and
 * `wouldNotHaveCaught` the interruptions it would have left standing: a rule that oversells its own
 * reach is worse than no rule.
 */
const RuleSchema = Schema.Struct({
	...base,
	kind: Schema.Literal("rule"),
	sentence: Schema.String,
	authorId: Schema.String,
	scope: Schema.Literals(["node", "plan", "org"]),
	/** What this rule is allowed to settle. An empty list settles nothing — absence is never permission. */
	settles: Schema.Array(Schema.String),
	status: Schema.Literals(["active", "withdrawn", "replaced"]),
	withdrawnAt: Schema.optional(Schema.Number),
	withdrawnBy: Schema.optional(Schema.String),
	replacedById: Schema.optional(Schema.String),
	/** Ids of the real prior decisions this proposal was generated from. Never configured, always evidenced. */
	proposedFrom: Schema.Array(Schema.String),
	/** Past interruptions this rule would NOT have prevented, stated at proposal time. */
	wouldNotHaveCaught: Schema.Array(Schema.String),
	invocations: Schema.Array(
		Schema.Struct({
			at: Schema.Number,
			outcome: Schema.Literals(["settled", "not-applicable", "blocked", "outside-clear-reach"]),
			nodeId: Schema.String,
		}),
	),
});

/** A member of the immutable class. Recorded so it can be shown and argued with, never so it can be disabled. */
const DelegationBoundarySchema = Schema.Struct({
	...base,
	kind: Schema.Literal("delegation-boundary"),
	class: Schema.Literals(nonDelegatableClasses),
	/** One sentence on why no rule can cover it. */
	justification: Schema.String,
});

/**
 * What an agent understood, before it acted. Reversible elements carry the cost of correcting them;
 * irreversible ones carry their nearest repair, because "irreversible" alone tells a human nothing.
 */
const InstructionReadbackSchema = Schema.Struct({
	...base,
	kind: Schema.Literal("instruction-readback"),
	instruction: Schema.String,
	authorId: Schema.String,
	agentId: Schema.String,
	reversible: Schema.Array(Schema.Struct({ element: Schema.String, reading: Schema.String, correctionCost: Schema.String })),
	irreversible: Schema.Array(Schema.Struct({ element: Schema.String, reading: Schema.String, nearestRepair: Schema.String })),
	/** Clauses the agent could not resolve. Named as ambiguity rather than guessed at. */
	ambiguous: Schema.Array(Schema.String),
	irreversibleStatus: Schema.Literals(["pending", "approved", "rejected"]),
});

/**
 * One objection, before work, with a prediction that can be checked later. Being overruled is not a
 * fault; the record keeps the objection, the overrule, and what actually happened.
 */
const ObjectionSchema = Schema.Struct({
	...base,
	kind: Schema.Literal("objection"),
	instructionId: Schema.String,
	agentId: Schema.String,
	/** Must be falsifiable — a prediction with a checkable outcome, not stated discomfort. */
	prediction: Schema.String,
	overruledBy: Schema.optional(Schema.String),
	status: Schema.Literals(["raised", "overruled", "accepted", "outcome-recorded"]),
	outcome: Schema.optional(Schema.String),
	outcomeMatchedPrediction: Schema.optional(Schema.Boolean),
	outcomeRecordedAt: Schema.optional(Schema.Number),
});

/**
 * A plan's own measured normal. The threshold is per plan, computed from that plan's own units —
 * a global configured number is explicitly wrong, and parked work carries no number at all.
 */
const PlanMotionSchema = Schema.Struct({
	...base,
	kind: Schema.Literal("plan-motion"),
	lastMeaningfulMovementAt: Schema.Number,
	/** This plan's normal interval between movements, in ms, measured from its own history. */
	baselineMs: Schema.optional(Schema.Number),
	/** How many of its own units the baseline was measured across. */
	baselineSampleSize: Schema.Number,
	parked: Schema.Boolean,
	intentionalStill: Schema.Boolean,
	blockedCause: Schema.optional(Schema.String),
	eligibleSuccessorCount: Schema.Number,
});

/**
 * A claim with its sample size and its date. Three states and no fourth: checked, taken on an
 * agent's word, or not verifiable right now.
 */
const EvidenceSchema = Schema.Struct({
	...base,
	kind: Schema.Literal("evidence"),
	claim: Schema.String,
	verification: Schema.Literals(["checked", "agent-word", "unverifiable"]),
	/** How many observations back the claim. A claim with no sample is not a claim. */
	sampleSize: Schema.Number,
	/** Units this claim can be opened to. */
	sourceNodeIds: Schema.Array(Schema.String),
	checkedAt: Schema.optional(Schema.Number),
	staleAt: Schema.optional(Schema.Number),
	withdrawnAt: Schema.optional(Schema.Number),
});

/**
 * A decision a human actually made: what they were asked, what they chose, and how long they took.
 *
 * This is the evidence rule proposals are generated FROM. Without it a "learned" rule is a configured
 * rule wearing a costume — there is nothing to replay, nothing to show the human, and no way to check
 * that the pattern being generalised was ever real. The audit log cannot serve: it is a no-op in file
 * mode, so half the fleet would silently have no evidence and every proposal would look unfounded.
 */
const DecisionSchema = Schema.Struct({
	...base,
	kind: Schema.Literal("decision"),
	/** What the human was asked, verbatim. */
	question: Schema.String,
	/** The choices they were offered, if any. Free-text answers have none. */
	options: Schema.Array(Schema.String),
	/** What they chose, verbatim — their own words when they answered in words. */
	chose: Schema.String,
	decidedBy: Schema.String,
	askedAt: Schema.Number,
	decidedAt: Schema.Number,
	/** Why this reached a human at all. A rule proposal must not generalise across different reasons. */
	reason: Schema.Literals(["gate-class", "non-delegatable", "no-rule-applied", "asked-explicitly"]),
	/** Set when the decision belongs to the immutable class, so no proposal can ever draw on it. */
	boundaryClass: Schema.optional(Schema.Literals(nonDelegatableClasses)),
});

/** Exactly one accountable human per question; authorship that survives every render path. */
const HumanAuthoritySchema = Schema.Struct({
	...base,
	kind: Schema.Literal("human-authority"),
	humanId: Schema.String,
	role: Schema.Literals(["accountable", "instruction-author"]),
});

/** What moves to the next agent, what does not, and which of the carried evidence is already stale. */
const HandoverSchema = Schema.Struct({
	...base,
	kind: Schema.Literal("handover"),
	fromActorId: Schema.String,
	toActorId: Schema.String,
	carried: Schema.Array(Schema.String),
	/** Stated before the handover is confirmed — a human cannot consent to an unnamed omission. */
	notCarried: Schema.Array(Schema.String),
	staleEvidenceIds: Schema.Array(Schema.String),
	reverifyAgainstRef: Schema.optional(Schema.String),
});

/** A compaction declares its own cut. What it preserved is recorded too, so a summary can never pass as the record. */
const RetentionSchema = Schema.Struct({
	...base,
	kind: Schema.Literal("retention"),
	authorizedBy: Schema.String,
	compactedAt: Schema.Number,
	cut: Schema.Array(Schema.String),
	preserved: Schema.Array(Schema.String),
	fidelity: Schema.Literals(["full", "compacted"]),
});

const NodeRecordSchema = Schema.Union([
	RuleSchema,
	DelegationBoundarySchema,
	InstructionReadbackSchema,
	ObjectionSchema,
	PlanMotionSchema,
	EvidenceSchema,
	DecisionSchema,
	HumanAuthoritySchema,
	HandoverSchema,
	RetentionSchema,
]);

export type RuleRecord = typeof RuleSchema.Type;
export type DelegationBoundaryRecord = typeof DelegationBoundarySchema.Type;
export type InstructionReadbackRecord = typeof InstructionReadbackSchema.Type;
export type ObjectionRecord = typeof ObjectionSchema.Type;
export type PlanMotionRecord = typeof PlanMotionSchema.Type;
export type EvidenceRecord = typeof EvidenceSchema.Type;
export type DecisionRecord = typeof DecisionSchema.Type;
export type HumanAuthorityRecord = typeof HumanAuthoritySchema.Type;
export type HandoverRecord = typeof HandoverSchema.Type;
export type RetentionRecord = typeof RetentionSchema.Type;
export type NodeRecord = typeof NodeRecordSchema.Type;
export const nodeRecordKinds = ["rule", "delegation-boundary", "instruction-readback", "objection", "plan-motion", "evidence", "decision", "human-authority", "handover", "retention"] as const;

const decode = Schema.decodeUnknownResult(NodeRecordSchema);

/** Decode one persisted record. Anything that does not decode whole is dropped, never half-read. */
export function readNodeRecord(value: unknown): NodeRecord | undefined {
	const decoded = decode(value);
	return Result.isFailure(decoded) ? undefined : decoded.success;
}

export class NodeRecordStore {
	constructor(
		private readonly store: Store,
		private readonly log: (message: string) => void = () => {},
	) {}

	async list(nodeId: string): Promise<NodeRecord[]> {
		return this.store.listNodeRecords(nodeId);
	}

	async put(record: NodeRecord): Promise<void> {
		if (!record.id.trim() || !record.nodeId.trim() || !Number.isFinite(record.createdAt)) {
			throw new Error("node record id, node id, and creation time required");
		}
		// Refuse anything that would not survive its own round trip. Without this a record can be
		// WRITTEN and then never read back: `put` checked a handful of fields, the reader decodes the
		// whole schema, and a record missing a required field vanishes on read with no error anywhere.
		// A write that reports success and produces nothing is the worst shape this defect can take.
		if (!readNodeRecord(record)) {
			throw new Error(`a ${record.kind} record that cannot be read back is not written — check its required fields`);
		}
		// Node existence is checked FIRST so a record for a node that is not there reports that, rather
		// than whichever kind-specific rule happens to fail earlier. A misleading error is a bug that
		// costs someone an hour.
		if (!(await this.store.getNode(record.nodeId))) {
			this.log(`refusing record ${record.id}: node ${record.nodeId} is absent`);
			throw new Error("node record node not found");
		}
		if (record.kind === "objection" && !record.prediction.trim()) {
			// An objection without a falsifiable prediction cannot be scored against reality later, which
			// is the only thing that makes an overrule reviewable rather than a grudge.
			throw new Error("an objection requires a falsifiable prediction");
		}
		if (record.kind === "evidence" && (!Number.isInteger(record.sampleSize) || record.sampleSize < 1)) {
			throw new Error("an evidence claim requires a sample size of at least one");
		}
		if (record.kind === "rule") {
			// Refused at CREATION, not at invocation. A rule that names a non-delegatable action must not
			// exist to be evaluated — otherwise the boundary depends on every future call site
			// remembering to check it, and one that forgets is a hole nobody can see.
			const overreach = record.settles.map((action) => [action, nonDelegatableClassOf(action)] as const).find(([, cls]) => cls !== undefined);
			if (overreach) {
				throw new Error(`a rule cannot settle ${overreach[0]}: ${overreach[1]} decisions always reach a person, and no rule widens that`);
			}
			// A rule claims to have been proposed from real decisions. Check that they exist, or
			// "learned" is decoration a configured rule can wear: nothing to replay to the human, and
			// no way to tell a generalisation from an assertion.
			if (record.proposedFrom.length === 0) {
				throw new Error("a rule is proposed from decisions the human already made — an empty proposedFrom is a configured rule wearing a costume");
			}
			const known = new Set((await this.list(record.nodeId)).filter((other) => other.kind === "decision").map((other) => other.id));
			const missing = record.proposedFrom.filter((id) => !known.has(id));
			if (missing.length > 0) {
				throw new Error(`a rule cannot cite evidence that is not there: no decision record for ${missing.join(", ")}`);
			}
		}
		await this.store.putNodeRecord(record);
	}

	/**
	 * Fail closed on every axis. A rule settles an action only when it is active, and only when it
	 * names that action in `settles`. Absence of a matching rule is never permission — and no rule at
	 * all reaches the non-delegatable class, whatever it claims about itself.
	 */
	async mayRuleSettle(nodeId: string, action: string, actionClass?: NonDelegatableClass): Promise<boolean> {
		if (!action.trim()) return false;
		if (actionClass && nonDelegatableClasses.includes(actionClass)) return false;
		return (await this.rulesSettling(nodeId, action)).length > 0;
	}

	/** The rules that decided an action, so each can be quoted verbatim at the point it acted. */
	async rulesSettling(nodeId: string, action: string): Promise<RuleRecord[]> {
		return (await this.list(nodeId)).filter(
			(record): record is RuleRecord => record.kind === "rule" && record.status === "active" && record.settles.includes(action),
		);
	}
}
