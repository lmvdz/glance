import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileStore } from "../src/dal/store.ts";
import {
	approveIrreversible,
	beginInstruction,
	overruleObjection,
	raiseObjection,
	recordObjectionOutcome,
} from "../src/instructions.ts";
import { NodeRecordStore, type InstructionReadbackRecord, type ObjectionRecord } from "../src/node-records.ts";

async function fixture(): Promise<{ dir: string; records: NodeRecordStore }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "instructions-"));
	const store = new FileStore(dir);
	await store.putNode({ id: "n1", kind: "unit", title: "Release work", state: "working", createdAt: 1, channelId: null });
	return { dir, records: new NodeRecordStore(store) };
}

function reading(overrides: Partial<InstructionReadbackRecord> = {}): InstructionReadbackRecord {
	return {
		kind: "instruction-readback",
		id: "reading-1",
		nodeId: "n1",
		createdAt: 10,
		instruction: "Refactor the retry logic and publish a release.",
		authorId: "lars",
		agentId: "wren",
		reversible: [{ element: "Refactor retry logic", reading: "Keep the current retry budget.", correctionCost: "Eleven minutes to rerun the suite." }],
		irreversible: [{ element: "Publish a release", reading: "Create a public version tag.", nearestRepair: "Publish a superseding release; the tag remains visible." }],
		ambiguous: ["The instruction does not say whether changing jitter is in scope."],
		irreversibleStatus: "pending",
		...overrides,
	};
}

function objection(overrides: Partial<ObjectionRecord> = {}): ObjectionRecord {
	return {
		kind: "objection",
		id: "objection-1",
		nodeId: "n1",
		createdAt: 11,
		instructionId: "reading-1",
		agentId: "wren",
		prediction: "Publishing this release will fail the production migration within ten minutes.",
		status: "raised",
		...overrides,
	};
}

test("a reading is durable before reversible work starts and irreversible work stays pending", async () => {
	const { dir, records } = await fixture();
	const events: string[] = [];
	const instruction = await beginInstruction(records, reading(), async () => {
		events.push((await records.list("n1")).find((record) => record.id === "reading-1")?.kind ?? "missing");
		events.push("reversible-ran");
	});

	expect(await instruction.mayRunIrreversible()).toBe(false);
	await instruction.runReversible();
	expect(events).toEqual(["instruction-readback", "reversible-ran"]);

	await approveIrreversible(records, "n1", "reading-1");
	expect(await instruction.mayRunIrreversible()).toBe(true);
	await fs.rm(dir, { recursive: true, force: true });
});

test("an agent may object once, then an overrule and its checked outcome remain on the original record", async () => {
	const { dir, records } = await fixture();
	await beginInstruction(records, reading(), async () => {});
	await raiseObjection(records, objection());
	await expect(raiseObjection(records, objection({ id: "objection-2" }))).rejects.toThrow(/only once/);

	await overruleObjection(records, "n1", "objection-1", "lars");
	const outcome = await recordObjectionOutcome(records, "n1", "objection-1", "The migration failed after seven minutes.", true, 20);
	expect(outcome).toEqual({
		...objection(),
		status: "outcome-recorded",
		overruledBy: "lars",
		outcome: "The migration failed after seven minutes.",
		outcomeMatchedPrediction: true,
		outcomeRecordedAt: 20,
	});
	await fs.rm(dir, { recursive: true, force: true });
});

test("a readback without a clause is refused instead of becoming an empty permission", async () => {
	const { dir, records } = await fixture();
	await expect(beginInstruction(records, reading({ reversible: [], irreversible: [] }), async () => {})).rejects.toThrow(/at least one instruction clause/);
	await fs.rm(dir, { recursive: true, force: true });
});
