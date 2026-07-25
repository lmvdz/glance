import type { Store } from "./dal/store.ts";

/** Product policy. Rules can never settle work in these classes. */
export const nonDelegatableClasses = ["credentials", "spend", "deletion", "publishing", "legal"] as const;
export type NonDelegatableClass = (typeof nonDelegatableClasses)[number];

export interface NodeRecordBase {
	id: string;
	nodeId: string;
	createdAt: number;
}

export interface RuleRecord extends NodeRecordBase {
	kind: "rule";
	sentence: string;
	authorId: string;
	scope: "node" | "plan" | "org";
	status: "active" | "withdrawn" | "replaced";
	withdrawnAt?: number;
	replacedById?: string;
	invocations: Array<{ at: number; outcome: "settled" | "not-applicable" | "blocked"; nodeId: string }>;
}

export interface DelegationBoundaryRecord extends NodeRecordBase {
	kind: "delegation-boundary";
	class: NonDelegatableClass;
}

export interface InstructionReadbackRecord extends NodeRecordBase {
	kind: "instruction-readback";
	instruction: string;
	authorId: string;
	agentId: string;
	reversible: string[];
	irreversible: string[];
	irreversibleStatus: "pending" | "approved" | "rejected";
}

export interface ObjectionRecord extends NodeRecordBase {
	kind: "objection";
	instructionId: string;
	agentId: string;
	prediction: string;
	status: "raised" | "overruled" | "accepted" | "outcome-recorded";
	outcome?: string;
}

export interface PlanMotionRecord extends NodeRecordBase {
	kind: "plan-motion";
	lastMeaningfulMovementAt: number;
	parked: boolean;
	intentionalStill: boolean;
	blockedCause?: string;
	eligibleSuccessorCount: number;
}

export interface EvidenceRecord extends NodeRecordBase {
	kind: "evidence";
	claim: string;
	verification: "checked" | "agent-word" | "unverifiable";
	checkedAt?: number;
	staleAt?: number;
}

export interface HumanAuthorityRecord extends NodeRecordBase {
	kind: "human-authority";
	humanId: string;
	role: "accountable" | "instruction-author";
}

export interface HandoverRecord extends NodeRecordBase {
	kind: "handover";
	fromActorId: string;
	toActorId: string;
	carried: string[];
	staleEvidenceIds: string[];
}

export interface RetentionRecord extends NodeRecordBase {
	kind: "retention";
	authorizedBy: string;
	compactedAt: number;
	cut: string[];
}

export type NodeRecord = RuleRecord | DelegationBoundaryRecord | InstructionReadbackRecord | ObjectionRecord | PlanMotionRecord | EvidenceRecord | HumanAuthorityRecord | HandoverRecord | RetentionRecord;

function validRecord(record: NodeRecord): boolean {
	return Boolean(record.id.trim() && record.nodeId.trim()) && Number.isFinite(record.createdAt);
}

/**
 * Durable associated records. Their lifetime and meaning stay separate from Node;
 * a missing record is unknown, never permission.
 */
export class NodeRecordStore {
	constructor(private readonly store: Store) {}

	async list(nodeId: string): Promise<NodeRecord[]> {
		return this.store.listNodeRecords(nodeId);
	}

	async put(record: NodeRecord): Promise<void> {
		if (!validRecord(record)) throw new Error("node record id, node id, and creation time required");
		if (!(await this.store.getNode(record.nodeId))) {
			console.error(`[NodeRecordStore] refusing record ${record.id}: node ${record.nodeId} is absent`);
			throw new Error("node record node not found");
		}
		await this.store.putNodeRecord(record);
	}

	/** Fail closed: no matching active rule is never permission. */
	async mayRuleSettle(nodeId: string, actionClass?: NonDelegatableClass): Promise<boolean> {
		if (actionClass && nonDelegatableClasses.includes(actionClass)) return false;
		return (await this.list(nodeId)).some((record): record is RuleRecord => record.kind === "rule" && record.status === "active");
	}
}
