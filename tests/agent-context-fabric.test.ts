/**
 * Agent context fabric — scope spine, read-only fabric, advisory peer messages, and opportunities.
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RbacDenied } from "../src/auth.ts";
import { agentActor, scopeFor } from "../src/agent-scope.ts";
import { buildFabricSnapshot, type FabricScoutFact } from "../src/fabric.ts";
import { Opportunity, opportunityClusters } from "../src/opportunity.ts";
import { appendReceipt } from "../src/receipts.ts";
import { writeDigest } from "../src/digest.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SubagentTracker } from "../src/subagents.ts";
import type { AgentDTO, IssueRef, PersistedAgent, PersistedFeature, TranscriptEntry } from "../src/types.ts";

const cleanups: Array<() => Promise<void>> = [];
const savedPeerBudget = process.env.OMP_SQUAD_PEERMSG_BUDGET;
const savedOpportunity = process.env.OMP_SQUAD_OPPORTUNITY;
const savedOpportunityMin = process.env.OMP_SQUAD_OPPORTUNITY_MIN;

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	if (savedPeerBudget === undefined) delete process.env.OMP_SQUAD_PEERMSG_BUDGET;
	else process.env.OMP_SQUAD_PEERMSG_BUDGET = savedPeerBudget;
	if (savedOpportunity === undefined) delete process.env.OMP_SQUAD_OPPORTUNITY;
	else process.env.OMP_SQUAD_OPPORTUNITY = savedOpportunity;
	if (savedOpportunityMin === undefined) delete process.env.OMP_SQUAD_OPPORTUNITY_MIN;
	else process.env.OMP_SQUAD_OPPORTUNITY_MIN = savedOpportunityMin;
});

interface TestDriver {
	prompt(message: string): Promise<void>;
	abort(): Promise<void>;
	stop(): Promise<void>;
	detach?(): void;
	respondHostTool(callId: string, text: string, isError?: boolean): void;
}

interface TestRecord {
	dto: AgentDTO;
	agent: TestDriver;
	options: PersistedAgent;
	transcript: TranscriptEntry[];
	assistantBuf: string;
	streaming: boolean;
	subs: SubagentTracker;
}

interface HostToolHarness {
	onHostTool(rec: TestRecord, call: { id: string; toolName: string; arguments: unknown }): void;
}

const tmpDir = async (prefix: string): Promise<string> => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	return dir;
};

function dto(id: string, over: Partial<AgentDTO> = {}): AgentDTO {
	return {
		id,
		name: id,
		status: "idle",
		kind: "omp-operator",
		repo: "/repo",
		worktree: `/wt/${id}`,
		approvalMode: "write",
		pending: [],
		lastActivity: 0,
		messageCount: 0,
		...over,
	};
}

function record(agent: AgentDTO, replies: Array<{ callId: string; text: string; isError?: boolean }> = []): TestRecord {
	return {
		dto: agent,
		agent: {
			async prompt() {},
			async abort() {},
			async stop() {},
			detach() {},
			respondHostTool(callId, text, isError) {
				replies.push({ callId, text, isError });
			},
		},
		options: { id: agent.id, name: agent.name, repo: agent.repo, worktree: agent.worktree, approvalMode: agent.approvalMode },
		transcript: [],
		assistantBuf: "",
		streaming: false,
		subs: new SubagentTracker(),
	};
}

function addRecord(mgr: SquadManager, rec: TestRecord): void {
	// Test seam: SquadManager.AgentRecord is intentionally private, but these fields are the runtime shape used by applyCommand/onHostTool.
	(mgr.agents as unknown as Map<string, TestRecord>).set(rec.dto.id, rec);
}

test("scopeFor gives agent-origin actors self, feature peers, parents, and children only", () => {
	const roster = [dto("parent"), dto("a", { parentId: "parent", featureId: "f" }), dto("peer", { featureId: "f" }), dto("child", { parentId: "a" }), dto("other", { featureId: "g" })];
	expect([...scopeFor(agentActor("a"), roster)].sort()).toEqual(["a", "child", "parent", "peer"]);
	expect([...scopeFor({ id: "web:viewer", origin: "local", role: "viewer" }, roster)].sort()).toEqual(["a", "child", "other", "parent", "peer"]);
});

test("agent-origin actors can only send scoped advisory messages", async () => {
	process.env.OMP_SQUAD_PEERMSG_BUDGET = "1";
	const dir = await tmpDir("acf-msg-");
	const mgr = new SquadManager({ stateDir: dir });
	const sender = record(dto("a", { featureId: "f" }));
	const target = record(dto("peer", { featureId: "f" }));
	const other = record(dto("other", { featureId: "g" }));
	addRecord(mgr, sender);
	addRecord(mgr, target);
	addRecord(mgr, other);

	await expect(mgr.applyCommand({ type: "prompt", id: "peer", message: "steer" }, { id: "a", origin: "agent", role: "admin" })).rejects.toThrow(RbacDenied);
	await mgr.applyCommand({ type: "message", to: "peer", text: "hello from peer" }, agentActor("a"));
	expect(target.transcript.at(-1)?.kind).toBe("system");
	expect(target.transcript.at(-1)?.text).toContain("BEGIN peer message from a (untrusted data)");
	expect(target.dto.status).toBe("idle");
	await expect(mgr.applyCommand({ type: "message", to: "peer", text: "again" }, agentActor("a"))).rejects.toThrow("budget");
	await expect(mgr.applyCommand({ type: "message", to: "other", text: "nope" }, agentActor("a"))).rejects.toThrow(RbacDenied);
});

test("reserved squad_message host tool routes through applyCommand without creating a pending host approval", async () => {
	const dir = await tmpDir("acf-host-");
	const mgr = new SquadManager({ stateDir: dir });
	const replies: Array<{ callId: string; text: string; isError?: boolean }> = [];
	const sender = record(dto("a", { featureId: "f" }), replies);
	const target = record(dto("peer", { featureId: "f" }));
	addRecord(mgr, sender);
	addRecord(mgr, target);

	const delivered = Promise.withResolvers<void>();
	sender.agent.respondHostTool = (callId, text, isError) => {
		replies.push({ callId, text, isError });
		delivered.resolve();
	};
	(mgr as unknown as HostToolHarness).onHostTool(sender, { id: "call-1", toolName: "squad_message", arguments: { to: "peer", text: "heads up" } });
	await delivered.promise;

	expect(sender.dto.pending).toEqual([]);
	expect(replies).toEqual([{ callId: "call-1", text: "delivered advisory message to peer", isError: undefined }]);
	expect(target.transcript.at(-1)?.text).toContain("heads up");
});

test("squad_record_decision captures a source:agent decision onto the feature, idempotently, and skips when no feature is attached", async () => {
	const savedFlag = process.env.OMP_SQUAD_DECISION_CAPTURE;
	process.env.OMP_SQUAD_DECISION_CAPTURE = "1"; // dispatch is flag-gated
	cleanups.push(async () => { if (savedFlag === undefined) delete process.env.OMP_SQUAD_DECISION_CAPTURE; else process.env.OMP_SQUAD_DECISION_CAPTURE = savedFlag; });
	const dir = await tmpDir("acf-record-");
	const mgr = new SquadManager({ stateDir: dir });
	// Seed the agent's feature into the (private) featureStore — the write target for captured decisions.
	(mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore.set(
		"f",
		{ id: "f", repo: "/repo", title: "feat-f", archived: false, decisions: [] } as unknown as PersistedFeature,
	);
	const replies: Array<{ callId: string; text: string; isError?: boolean }> = [];
	const rec = record(dto("a", { featureId: "f" }), replies);
	addRecord(mgr, rec);
	const harness = mgr as unknown as HostToolHarness;
	const featureStore = (mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore;

	const done1 = Promise.withResolvers<void>();
	rec.agent.respondHostTool = (callId, text, isError) => { replies.push({ callId, text, isError }); done1.resolve(); };
	harness.onHostTool(rec, { id: "c1", toolName: "squad_record_decision", arguments: { text: "Use RRF over a second ranker  " } });
	await done1.promise;

	const decisions = featureStore.get("f")?.decisions ?? [];
	expect(decisions.length).toBe(1);
	expect(decisions[0]).toMatchObject({ text: "Use RRF over a second ranker", source: "agent", sourceRef: { agentId: "a" } });
	expect(typeof decisions[0]!.id).toBe("string");
	expect(replies.at(-1)?.isError).toBeUndefined();

	// Idempotent: a normalized-text match (extra whitespace / case) is a no-op, not a duplicate.
	const done2 = Promise.withResolvers<void>();
	rec.agent.respondHostTool = (callId, text, isError) => { replies.push({ callId, text, isError }); done2.resolve(); };
	harness.onHostTool(rec, { id: "c2", toolName: "squad_record_decision", arguments: { text: "use rrf over a second ranker" } });
	await done2.promise;
	expect((featureStore.get("f")?.decisions ?? []).length).toBe(1);
	expect(replies.at(-1)?.text).toContain("already recorded");

	// No feature attached → error reply, no write, no crash.
	const adhoc = record(dto("z"));
	addRecord(mgr, adhoc);
	const done3 = Promise.withResolvers<void>();
	adhoc.agent.respondHostTool = (callId, text, isError) => { replies.push({ callId, text, isError }); done3.resolve(); };
	harness.onHostTool(adhoc, { id: "c3", toolName: "squad_record_decision", arguments: { text: "orphan decision" } });
	await done3.promise;
	expect(replies.at(-1)?.isError).toBe(true);
	expect(replies.at(-1)?.text).toContain("no feature");

	// Flag off ⇒ dispatch is disabled (no write), consistent with advertisement gating.
	process.env.OMP_SQUAD_DECISION_CAPTURE = "0";
	const done4 = Promise.withResolvers<void>();
	rec.agent.respondHostTool = (callId, text, isError) => { replies.push({ callId, text, isError }); done4.resolve(); };
	harness.onHostTool(rec, { id: "c4", toolName: "squad_record_decision", arguments: { text: "a brand new decision while disabled" } });
	await done4.promise;
	expect(replies.at(-1)?.isError).toBe(true);
	expect(replies.at(-1)?.text).toContain("disabled");
	expect((featureStore.get("f")?.decisions ?? []).length).toBe(1); // unchanged
	process.env.OMP_SQUAD_DECISION_CAPTURE = "1";
});

test("fabric snapshot is scoped and returns distilled facts with receipt provenance", async () => {
	const dir = await tmpDir("acf-fabric-");
	const agents = [dto("a", { featureId: "f" }), dto("peer", { featureId: "f" }), dto("other", { featureId: "g" })];
	await writeDigest(dir, "a", "## digest a");
	await writeDigest(dir, "other", "## digest other");
	await appendReceipt(dir, { agentId: "a", name: "a", repo: "/repo", runId: "run-a", startedAt: 900, endedAt: 950, status: "idle", toolCalls: 1, toolTally: {}, filesTouched: ["src/a.ts"] });
	await appendReceipt(dir, { agentId: "peer", name: "peer", repo: "/repo", runId: "run-p", startedAt: 800, endedAt: 850, status: "idle", toolCalls: 1, toolTally: {}, filesTouched: ["src/a.ts", "src/p.ts"] });
	await appendReceipt(dir, { agentId: "other", name: "other", repo: "/repo", runId: "run-o", startedAt: 700, endedAt: 750, status: "idle", toolCalls: 1, toolTally: {}, filesTouched: ["src/secret.ts"] });
	await fs.writeFile(path.join(dir, "scout-seen.json"), JSON.stringify({ a: { title: "Fix shared bug", issueId: "i-a", filedAt: 1, agent: "a", runId: "run-a" }, o: { title: "Leaky other", issueId: "i-o", filedAt: 2, agent: "other", runId: "run-o" } }));

	const snapshot = await buildFabricSnapshot({
		actor: agentActor("a"),
		agents,
		stateDir: dir,
		repos: ["/repo"],
		includeLeases: false,
		now: () => 1000,
		listIssues: async () => [
			{ id: "i-a", name: "[scout] do-not-auto-land: Fix shared bug" },
			{ id: "i-o", name: "[scout] do-not-auto-land: Leaky other" },
		],
	});

	expect(snapshot.scope.sort()).toEqual(["a", "peer"]);
	expect(snapshot.digests.map((d) => d.source.agentId)).toEqual(["a"]);
	expect(snapshot.hotAreas.map((h) => h.file)).not.toContain("src/secret.ts");
	expect(snapshot.hotAreas[0].touchedBy.map((s) => s.runId).sort()).toEqual(["run-a", "run-p"]);
	expect(snapshot.scout.map((s) => s.issue.id)).toEqual(["i-a"]);
});

test("(Knowledge-view incident) a human actor's fabric snapshot surfaces digests/receipts/hot-areas for agents no longer in the live roster", async () => {
	// The live-repro shape: hundreds of digest/receipt files accumulate on disk over a daemon's
	// life, but `scopeFor` handed a human actor the CURRENT live roster's ids as its "no
	// restriction" proxy — so once an agent's run ended and it was pruned from the roster (the
	// common case: a daemon with 0 agents running right now), its digest/receipt became invisible
	// FOREVER even though the files sit right there under stateDir. Roster here has ZERO agents —
	// the exact "nothing currently running" shape the operator hit.
	const dir = await tmpDir("acf-historical-");
	await writeDigest(dir, "ghost-1", "## digest from a completed, since-removed agent");
	await writeDigest(dir, "ghost-2", "## another completed agent's digest");
	await appendReceipt(dir, { agentId: "ghost-1", name: "ghost-1", repo: "/repo", runId: "run-g1", startedAt: 100, endedAt: 150, status: "stopped", toolCalls: 2, toolTally: {}, filesTouched: ["src/ghost.ts"] });

	const humanActor = { id: "web:admin", origin: "local" as const, role: "admin" as const };
	const snapshot = await buildFabricSnapshot({ actor: humanActor, agents: [], stateDir: dir, now: () => 1000 });

	// `scope` (the live-roster view) is honestly empty — nothing is running — but that must not
	// mean the whole knowledge base reads as empty: the historical facts are still on disk.
	expect(snapshot.scope).toEqual([]);
	expect(snapshot.digests.map((d) => d.source.agentId).sort()).toEqual(["ghost-1", "ghost-2"]);
	// The digest's repo is recovered from its own receipt (no roster AgentDTO exists for it).
	expect(snapshot.digests.find((d) => d.source.agentId === "ghost-1")?.source.repo).toBe("/repo");
	expect(snapshot.hotAreas.map((h) => h.file)).toContain("src/ghost.ts");
});

test("(Knowledge-view incident) an agent-origin actor's scope is unaffected by the human unrestricted-read fix — still only its own subtree", async () => {
	const dir = await tmpDir("acf-historical-agent-");
	await writeDigest(dir, "a", "## a's own digest");
	await writeDigest(dir, "ghost-off-roster", "## a digest belonging to nobody in a's scope");
	const agents = [dto("a")];

	const snapshot = await buildFabricSnapshot({ actor: agentActor("a"), agents, stateDir: dir, now: () => 1000 });

	expect(snapshot.digests.map((d) => d.source.agentId)).toEqual(["a"]);
});

test("fabric decisions are repo-scoped even when the caller omits `repos` (no cross-repo leak)", async () => {
	const dir = await tmpDir("acf-dec-");
	const agents = [dto("a", { repo: "/repo-a" }), dto("other", { repo: "/repo-other" })];
	const feature = (id: string, repo: string, text: string) =>
		({ id, repo, title: `feat-${id}`, archived: false, decisions: [{ text }] }) as unknown as PersistedFeature;

	const snapshot = await buildFabricSnapshot({
		actor: agentActor("a"),
		agents,
		stateDir: dir,
		// `repos` intentionally omitted — exactly how /api/fabric invokes it with no ?repo. The decision
		// filter must fall back to the actor's scoped repos, not leak every feature's decisions.
		features: [feature("f1", "/repo-a", "IN-SCOPE decision"), feature("f2", "/repo-other", "OUT-OF-SCOPE decision")],
	});

	expect(snapshot.scope.sort()).toEqual(["a"]); // agent scope is correct (the leak is not here)
	expect(snapshot.decisions.map((d) => d.source.repo)).toEqual(["/repo-a"]);
	expect(snapshot.decisions.some((d) => d.text.includes("OUT-OF-SCOPE"))).toBe(false);
});

test("(concern 05) fabric snapshot surfaces a recurring-failure annotation, repo-scoped", async () => {
	const dir = await tmpDir("acf-failure-");
	const { recordFailureAnnotation } = await import("../src/failure-memory.ts");
	recordFailureAnnotation(dir, { fingerprint: "land-failing:squad/a1", repo: "/repo", branch: "squad/a1", rootCause: "flaky retry backoff", at: 500 });
	recordFailureAnnotation(dir, { fingerprint: "land-failing:squad/other-repo", repo: "/other-repo", branch: "squad/other-repo", rootCause: "unrelated", at: 500 });

	const agents = [dto("a", { featureId: "f" })];
	const snapshot = await buildFabricSnapshot({ actor: agentActor("a"), agents, stateDir: dir, repos: ["/repo"], includeLeases: false, now: () => 1000, listIssues: async () => [] });

	expect(snapshot.failures).toHaveLength(1); // the other-repo annotation is excluded — repo-scoped, never an unscoped global leak
	expect(snapshot.failures[0]).toEqual({ type: "failure", source: { repo: "/repo" }, fingerprint: "land-failing:squad/a1", branch: "squad/a1", rootCause: "flaky retry backoff", at: 500 });
});

function scoutFact(id: string, title: string, agentId: string, runId: string, filedAt: number): FabricScoutFact {
	return { type: "scout", title, filedAt, source: { agentId, runId, issueId: id }, issue: { id, name: `[scout] do-not-auto-land: ${title}` } };
}

test("opportunity loop files one deduped do-not-auto-land issue for a recurring scout cluster", async () => {
	process.env.OMP_SQUAD_OPPORTUNITY = "1";
	process.env.OMP_SQUAD_OPPORTUNITY_MIN = "3";
	const dir = await tmpDir("acf-opp-");
	const facts = [
		scoutFact("i1", "Add retry to RPC reconnect", "a", "r1", 3),
		scoutFact("i2", "Add retry to RPC reconnect", "b", "r2", 2),
		scoutFact("i3", "Add retry to RPC reconnect", "c", "r3", 1),
	];
	expect(opportunityClusters(facts, [], 3).length).toBe(1);

	const filed: Array<{ title: string; body: string }> = [];
	const opp = new Opportunity({
		listIssues: async () => facts.map((f) => f.issue),
		fileIssue: async (title, body) => {
			filed.push({ title, body });
			return { id: "opp-1", name: title } satisfies IssueRef;
		},
		scoutFacts: async () => facts,
		hotAreas: async () => [],
		stateDir: dir,
		now: () => 10,
		log: () => {},
	});
	await opp.tick();
	await opp.tick();
	expect(filed.length).toBe(1);
	expect(filed[0].title.startsWith("[opportunity] do-not-auto-land:")).toBe(true);
	expect(filed[0].body).toContain("i1");
});
