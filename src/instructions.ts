import {
	type InstructionReadbackRecord,
	NodeRecordStore,
	type ObjectionRecord,
} from "./node-records.ts";

export type InstructionExecution = {
	readonly readback: InstructionReadbackRecord;
	readonly runReversible: () => Promise<void>;
	readonly mayRunIrreversible: () => Promise<boolean>;
};

function requireText(value: string, field: string): void {
	if (!value.trim()) throw new Error(`${field} required`);
}

function assertReading(readback: InstructionReadbackRecord): void {
	requireText(readback.instruction, "instruction");
	requireText(readback.authorId, "instruction author");
	requireText(readback.agentId, "reading agent");
	if (readback.reversible.length + readback.irreversible.length === 0) {
		throw new Error("a reading must name at least one instruction clause");
	}
	for (const clause of readback.reversible) {
		requireText(clause.element, "reversible clause");
		requireText(clause.reading, "reversible reading");
		requireText(clause.correctionCost, "reversible correction cost");
	}
	for (const clause of readback.irreversible) {
		requireText(clause.element, "irreversible clause");
		requireText(clause.reading, "irreversible reading");
		requireText(clause.nearestRepair, "irreversible nearest repair");
	}
	for (const ambiguity of readback.ambiguous) requireText(ambiguity, "named ambiguity");
}

async function readbackById(records: NodeRecordStore, nodeId: string, id: string): Promise<InstructionReadbackRecord> {
	const record = (await records.list(nodeId)).find((candidate) => candidate.kind === "instruction-readback" && candidate.id === id);
	if (!record || record.kind !== "instruction-readback") throw new Error("instruction reading not found");
	return record;
}

async function objectionById(records: NodeRecordStore, nodeId: string, id: string): Promise<ObjectionRecord> {
	const record = (await records.list(nodeId)).find((candidate) => candidate.kind === "objection" && candidate.id === id);
	if (!record || record.kind !== "objection") throw new Error("instruction objection not found");
	return record;
}

/**
 * Writes the reading before returning an execution capability. Reversible work goes through this
 * capability; irreversible work has no capability until `approveIrreversible` has persisted first.
 */
export async function beginInstruction(
	records: NodeRecordStore,
	readback: InstructionReadbackRecord,
	reversibleWork: () => Promise<void>,
): Promise<InstructionExecution> {
	assertReading(readback);
	await records.put(readback);
	return {
		readback,
		runReversible: reversibleWork,
		mayRunIrreversible: async () => (await readbackById(records, readback.nodeId, readback.id)).irreversibleStatus === "approved",
	};
}

/** Approving is durable before an irreversible executor can observe permission. */
export async function approveIrreversible(records: NodeRecordStore, nodeId: string, instructionId: string): Promise<InstructionReadbackRecord> {
	const readback = await readbackById(records, nodeId, instructionId);
	if (readback.irreversible.length === 0) throw new Error("instruction has no irreversible clauses to approve");
	if (readback.irreversibleStatus !== "pending") throw new Error("irreversible instruction is no longer pending");
	const approved = { ...readback, irreversibleStatus: "approved" as const };
	await records.put(approved);
	return approved;
}

/** A rejection remains on the original reading; it never rewrites what the agent understood then. */
export async function rejectIrreversible(records: NodeRecordStore, nodeId: string, instructionId: string): Promise<InstructionReadbackRecord> {
	const readback = await readbackById(records, nodeId, instructionId);
	if (readback.irreversibleStatus !== "pending") throw new Error("irreversible instruction is no longer pending");
	const rejected = { ...readback, irreversibleStatus: "rejected" as const };
	await records.put(rejected);
	return rejected;
}

/** One agent gets one pre-work objection per reading; later changes record the outcome, not a new objection. */
export async function raiseObjection(records: NodeRecordStore, objection: ObjectionRecord): Promise<ObjectionRecord> {
	requireText(objection.prediction, "a falsifiable prediction");
	const readback = await readbackById(records, objection.nodeId, objection.instructionId);
	if (readback.agentId !== objection.agentId) throw new Error("only the reading agent may object to its instruction");
	const existing = (await records.list(objection.nodeId)).find(
		(record) => record.kind === "objection" && record.instructionId === objection.instructionId && record.agentId === objection.agentId,
	);
	if (existing) throw new Error("an agent may object to an instruction only once");
	if (objection.status !== "raised") throw new Error("an objection starts raised before any overrule or outcome");
	await records.put(objection);
	return objection;
}

export async function overruleObjection(records: NodeRecordStore, nodeId: string, objectionId: string, overruledBy: string): Promise<ObjectionRecord> {
	requireText(overruledBy, "overruling actor");
	const objection = await objectionById(records, nodeId, objectionId);
	if (objection.status !== "raised") throw new Error("only a raised objection may be overruled");
	const overruled = { ...objection, status: "overruled" as const, overruledBy: overruledBy.trim() };
	await records.put(overruled);
	return overruled;
}

/** The outcome is explicitly compared with the original prediction; being overruled remains neutral evidence. */
export async function recordObjectionOutcome(
	records: NodeRecordStore,
	nodeId: string,
	objectionId: string,
	outcome: string,
	matchedPrediction: boolean,
	at: number,
): Promise<ObjectionRecord> {
	requireText(outcome, "objection outcome");
	if (!Number.isFinite(at)) throw new Error("outcome time required");
	const objection = await objectionById(records, nodeId, objectionId);
	if (objection.status !== "overruled" && objection.status !== "accepted") throw new Error("only a resolved objection may receive an outcome");
	const recorded = {
		...objection,
		status: "outcome-recorded" as const,
		outcome: outcome.trim(),
		outcomeMatchedPrediction: matchedPrediction,
		outcomeRecordedAt: at,
	};
	await records.put(recorded);
	return recorded;
}
