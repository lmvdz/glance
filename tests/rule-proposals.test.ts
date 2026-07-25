import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileStore } from "../src/dal/store.ts";
import { NodeRecordStore, type DecisionRecord, type NodeRecord } from "../src/node-records.ts";
import { MIN_SAMPLE, proposeRules } from "../src/rule-proposals.ts";

/** Minimal live driver: the manager wires real event listeners onto it, so it must be an emitter. */
class ControlDriver extends EventEmitter {
	readonly isReady = true;
	readonly isAlive = true;
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async prompt(): Promise<void> {}
	async abort(): Promise<unknown> { return undefined; }
	async getState(): Promise<unknown> { return { todoPhases: [], isStreaming: false }; }
	respondUi(): void {}
	respondHostTool(): void {}
}

function decision(over: Partial<DecisionRecord> & { id: string }): DecisionRecord {
	return {
		kind: "decision",
		nodeId: "n1",
		createdAt: 1,
		question: "Take the reversible option?",
		options: ["yes", "no"],
		chose: "yes",
		decidedBy: "db:lars",
		askedAt: 0,
		decidedAt: 120_000,
		reason: "no-rule-applied",
		...over,
	};
}

const fourYeses: NodeRecord[] = [1, 2, 3, 4].map((n) => decision({ id: `d${n}`, decidedAt: n * 120_000 }));

test("a repeated decision becomes a proposal that replays its own evidence", () => {
	const [proposal] = proposeRules(fourYeses);
	expect(proposal).toBeDefined();
	expect(proposal!.evidence).toHaveLength(4);
	// The actual prior decisions, not a count of them — the human is shown what they said.
	expect(proposal!.evidence.map((d) => d.id)).toEqual(["d1", "d2", "d3", "d4"]);
	expect(proposal!.consistentChoice).toBe("yes");
	expect(proposal!.sentence).toContain("4 times you were asked");
	expect(proposal!.sentence).toContain("Take the reversible option?");
	expect(proposal!.sentence).toContain("Should the fleet stop asking?");
});

test("below the sample floor there is no proposal — three is a coincidence", () => {
	expect(proposeRules(fourYeses.slice(0, MIN_SAMPLE - 1))).toEqual([]);
	expect(proposeRules(fourYeses)).toHaveLength(1);
});

test("an inconsistent answer kills the proposal outright — a majority is not a rule", () => {
	// The minority answer is exactly the case a majority-derived rule would get wrong, silently.
	const mixed = [...fourYeses.slice(0, 3), decision({ id: "d4", chose: "no", decidedAt: 480_000 })];
	expect(proposeRules(mixed)).toEqual([]);
});

test("decisions are not generalised across different questions or different reasons", () => {
	const differentQuestions = [
		decision({ id: "a1", decidedAt: 1 }),
		decision({ id: "a2", decidedAt: 2 }),
		decision({ id: "b1", question: "Retry the flaky test?", decidedAt: 3 }),
		decision({ id: "b2", question: "Retry the flaky test?", decidedAt: 4 }),
	];
	expect(proposeRules(differentQuestions)).toEqual([]);

	// Same question, but they reached a human for different reasons. Four yeses to "why am I being
	// asked" is not one pattern.
	const differentReasons = [
		decision({ id: "c1", reason: "no-rule-applied", decidedAt: 1 }),
		decision({ id: "c2", reason: "no-rule-applied", decidedAt: 2 }),
		decision({ id: "c3", reason: "gate-class", decidedAt: 3 }),
		decision({ id: "c4", reason: "gate-class", decidedAt: 4 }),
	];
	expect(proposeRules(differentReasons)).toEqual([]);
});

test("a proposal states what it would NOT have caught, and names it", () => {
	const withOthers: NodeRecord[] = [
		...fourYeses,
		decision({ id: "cred", question: "Rotate the production credential?", chose: "yes", reason: "non-delegatable", boundaryClass: "credentials", decidedAt: 600_000 }),
	];
	const [proposal] = proposeRules(withOthers);
	expect(proposal!.wouldNotHaveCaught.map((d) => d.id)).toContain("cred");
	// Named in the human's sentence, not merely counted — this is the clause that keeps the human
	// calibrated about what the rule actually buys.
	expect(proposal!.sentence).toContain("Rotate the production credential?");
	expect(proposal!.sentence).toContain("those still reach you");
});

test("when nothing else interrupted, the proposal says so rather than leaving it implied", () => {
	const [proposal] = proposeRules(fourYeses);
	expect(proposal!.wouldNotHaveCaught).toEqual([]);
	expect(proposal!.sentence).toContain("Nothing else interrupted you in this window");
});

test("decisions inside the non-delegatable class never generate a proposal", () => {
	// Four identical credential approvals are still four credential approvals. Offering a rule here
	// would be offering something that cannot be accepted, and the offer itself teaches the wrong
	// thing about where the boundary is.
	const credentials = [1, 2, 3, 4].map((n) =>
		decision({ id: `cred${n}`, question: "Rotate the production credential?", reason: "non-delegatable", boundaryClass: "credentials", decidedAt: n * 1000 }),
	);
	expect(proposeRules(credentials)).toEqual([]);

	// And where the CHOICE names a boundary action, even without a class marked on the record.
	const publishing = [1, 2, 3, 4].map((n) => decision({ id: `pub${n}`, question: "Ship it?", chose: "land", decidedAt: n * 1000 }));
	expect(proposeRules(publishing)).toEqual([]);
});

test("a proposal reports how long the human actually took to answer", () => {
	const slow = [1, 2, 3, 4].map((n) => decision({ id: `s${n}`, askedAt: n * 1_000_000, decidedAt: n * 1_000_000 + 180_000 }));
	const [proposal] = proposeRules(slow);
	expect(proposal!.sentence).toContain("3 minutes");
});

test("the floor cannot be lowered below the minimum, only raised", () => {
	// A caller asking for a two-decision sample does not get one — the floor is a property of what
	// counts as evidence, not a knob.
	expect(proposeRules(fourYeses.slice(0, 2), { sampleFloor: 2 })).toEqual([]);
	expect(proposeRules(fourYeses, { sampleFloor: 10 })).toEqual([]);
	expect(proposeRules(fourYeses, { sampleFloor: 4 })).toHaveLength(1);
});

test("proposals are ordered by how much evidence stands behind them", () => {
	const many = [
		...[1, 2, 3, 4].map((n) => decision({ id: `few${n}`, question: "Retry the flaky test?", decidedAt: n })),
		...[1, 2, 3, 4, 5, 6].map((n) => decision({ id: `lots${n}`, question: "Take the reversible option?", decidedAt: n })),
	];
	const proposals = proposeRules(many);
	expect(proposals).toHaveLength(2);
	expect(proposals[0]!.evidence).toHaveLength(6);
	expect(proposals[1]!.evidence).toHaveLength(4);
});

test("end to end: a proposal's evidence is exactly what a rule may then cite", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rule-proposal-"));
	const store = new FileStore(dir);
	await store.putNode({ id: "n1", kind: "unit", title: "unit", state: "working", createdAt: 1, channelId: null });
	const records = new NodeRecordStore(store);
	for (const record of fourYeses) await records.put(record);

	const [proposal] = proposeRules(await records.list("n1"));
	expect(proposal).toBeDefined();

	// The human accepts, in their own words. The rule cites exactly the evidence it was proposed from,
	// and the store accepts it because that evidence is really there.
	await records.put({
		kind: "rule",
		id: "r1",
		nodeId: "n1",
		createdAt: 500,
		sentence: "If it can be undone in under a minute, just do it and tell me afterwards.",
		authorId: "db:lars",
		scope: "org",
		settles: ["reversible-change"],
		status: "active",
		proposedFrom: proposal!.evidence.map((d) => d.id),
		wouldNotHaveCaught: proposal!.wouldNotHaveCaught.map((d) => d.question),
		invocations: [],
	});
	const [rule] = await records.rulesSettling("n1", "reversible-change");
	expect(rule?.sentence).toBe("If it can be undone in under a minute, just do it and tell me afterwards.");
	expect(rule?.proposedFrom).toEqual(["d1", "d2", "d3", "d4"]);

	// And a rule citing evidence that does not exist is refused — this is what stops a configured rule
	// from claiming it was learned.
	await expect(
		records.put({ kind: "rule", id: "r2", nodeId: "n1", createdAt: 501, sentence: "Trust me.", authorId: "db:lars", scope: "org", settles: ["anything"], status: "active", proposedFrom: ["never-happened"], wouldNotHaveCaught: [], invocations: [] }),
	).rejects.toThrow(/cannot cite evidence that is not there/);
	await expect(
		records.put({ kind: "rule", id: "r3", nodeId: "n1", createdAt: 502, sentence: "Trust me.", authorId: "db:lars", scope: "org", settles: ["anything"], status: "active", proposedFrom: [], wouldNotHaveCaught: [], invocations: [] }),
	).rejects.toThrow(/configured rule wearing a costume/);
	await fs.rm(dir, { recursive: true, force: true });
});

test("answering a gate-class pending leaves a decision record; a routine approval does not", async () => {
	const { SquadManager } = await import("../src/squad-manager.ts");
	const { LOCAL_ACTOR } = await import("../src/federation.ts");
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "decision-record-state-"));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "decision-record-wt-"));
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "decision-record-repo-"));
	for (const args of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"], ["config", "commit.gpgsign", "false"]]) {
		await Bun.spawn(["git", ...args], { cwd: repo, stdout: "ignore", stderr: "ignore" }).exited;
	}
	await fs.writeFile(path.join(repo, "README.md"), "x\n");
	for (const args of [["add", "."], ["commit", "-qm", "init"]]) {
		await Bun.spawn(["git", ...args], { cwd: repo, stdout: "ignore", stderr: "ignore" }).exited;
	}

	const mgr = new SquadManager({ stateDir, worktreeBase });
	await mgr.start();
	const host = mgr as unknown as { makeDriver: () => unknown; agents: Map<string, unknown>; onUi: (rec: unknown, req: unknown) => void };
	host.makeDriver = () => new ControlDriver();
	const dto = await mgr.create({ name: "decider", repo, approvalMode: "yolo", autoRoute: false });
	const rec = host.agents.get(dto.id);

	// A routine tool approval is noise, not a decision — it must not become evidence a rule can cite.
	host.onUi(rec, { method: "confirm", id: "acpui_1", title: "Allow tool: bash", message: "Command: bun test" });
	await mgr.applyCommand({ type: "answer", id: dto.id, requestId: "acpui_1", value: "yes" }, LOCAL_ACTOR);

	// A gate-class question is exactly the kind a rule might one day settle.
	host.onUi(rec, { method: "confirm", id: "gate_1", title: "Take the reversible option?", message: "revert or retry?" });
	await mgr.applyCommand({ type: "answer", id: dto.id, requestId: "gate_1", value: "yes" }, LOCAL_ACTOR);
	await Bun.sleep(60);

	const records = new NodeRecordStore(new FileStore(stateDir));
	const decisions = (await records.list(dto.id)).filter((record) => record.kind === "decision");
	expect(decisions).toHaveLength(1);
	expect(decisions[0]).toMatchObject({ question: "Take the reversible option?", chose: "yes", decidedBy: LOCAL_ACTOR.id, reason: "gate-class" });

	await mgr.stop();
	for (const dir of [stateDir, worktreeBase, repo]) await fs.rm(dir, { recursive: true, force: true });
});
