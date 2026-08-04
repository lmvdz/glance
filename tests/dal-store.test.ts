/**
 * Store seam isolation + behavior preservation (MT-SaaS P2, OMPSQ-37 / concern 04).
 *
 *  - DbStore: per-org isolation rests on the explicit `where org_id = orgId`
 *    predicate (RLS is Postgres-only, so SQLite proves the primary guard). Org A's
 *    roster/features/audit/usage are invisible to org B. Round-trips through the
 *    `data` JSON column.
 *  - FileStore: behavior-preserving — writes the EXACT pre-refactor persistNow
 *    on-disk format (`{version:1, agents, transcripts, features}`, temp+rename)
 *    and round-trips it; a no-op for audit/usage (single-tenant file mode).
 *
 * In-memory-grade isolated SQLite via openDatabase against a temp file; two seeded
 * `organization` rows (the FK target for roster/features/audit/usage).
 */

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { sql } from "kysely";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type OrgContext } from "../src/dal/context.ts";
import { DbStore, FileStore, type Store } from "../src/dal/store.ts";
import { LocalStorageBackend, setStorageBackend, type WriteOpts } from "../src/dal/storage.ts";
import { type DbHandle, openDatabase, openDb } from "../src/db/index.ts";
import { appMigrations } from "../src/db/migrations.ts";
import type { PersistedAgent, PersistedFeature, RunReceipt } from "../src/types.ts";
import { ChannelStore } from "../src/channels.ts";
import { NodeStore } from "../src/memory/nodes.ts";
import { NodeRecordStore, type NodeRecord } from "../src/memory/node-records.ts";

let dir: string;
let handle: DbHandle;
let ctx: OrgContext;
const prevUrl = process.env.DATABASE_URL;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dalstore-"));
	process.env.DATABASE_URL = `sqlite:${path.join(dir, "app.sqlite")}`;
	const h = await openDatabase();
	if (!h) throw new Error("openDatabase returned null in DB mode");
	handle = h;
	ctx = { db: handle.db, type: handle.type };
	// Seed the two orgs that own the rows (FK: org_id → organization.id, cascade).
	for (const id of ["A", "B"]) {
		await handle.db
			.insertInto("organization")
			.values({ id, name: `Org ${id}`, slug: `org-${id.toLowerCase()}`, createdAt: new Date().toISOString() })
			.execute();
	}
});

afterAll(async () => {
	await handle.close();
	await fs.rm(dir, { recursive: true, force: true });
	if (prevUrl === undefined) delete process.env.DATABASE_URL;
	else process.env.DATABASE_URL = prevUrl;
});

afterEach(() => {
	setStorageBackend(new LocalStorageBackend());
});

function agent(id: string, over: Partial<PersistedAgent> = {}): PersistedAgent {
	return { id, name: id, repo: "/repo", worktree: `/wt/${id}`, approvalMode: "write", ...over };
}
function feature(id: string, over: Partial<PersistedFeature> = {}): PersistedFeature {
	return { id, title: `Feature ${id}`, repo: "/repo", createdAt: 1, updatedAt: 2, ...over };
}
const orgDir = (org: string) => path.join(dir, `org-${org}`);
const dbStore = (org: string) => new DbStore(ctx, org, orgDir(org));

class ChannelCreateRaceBackend extends LocalStorageBackend {
	private readonly privateWrite = Promise.withResolvers<void>();

	override async readText(file: string): Promise<string | undefined> {
		if (path.basename(file) === "channels.json") await Promise.resolve();
		return super.readText(file);
	}

	override async writeDurable(file: string, data: string, opts?: WriteOpts): Promise<void> {
		if (path.basename(file) !== "channels.json") {
			await super.writeDurable(file, data, opts);
			return;
		}
		const channels = JSON.parse(data) as Array<{ id?: string; visibility?: string }>;
		const raceChannel = channels.find((channel) => channel.id === "race");
		if (raceChannel?.visibility === "org-public") await this.privateWrite.promise;
		await super.writeDurable(file, data, opts);
		if (raceChannel?.visibility === "private") this.privateWrite.resolve();
	}
}

test("DbStore: org A's roster is invisible to org B (explicit org_id predicate)", async () => {
	const a1 = agent("a1", { branch: "squad/a1", model: "opus", kind: "omp-operator", featureId: "f1" });
	await dbStore("A").save({ agents: [a1], transcripts: {}, features: [] });

	// Cross-org read: B's query carries `where org_id = "B"` → sees nothing of A's.
	expect((await dbStore("B").load()).agents).toEqual([]);

	// Same-org read round-trips a1 through the `data` JSON column, byte-for-byte.
	const loadedA = await dbStore("A").load();
	expect(loadedA.agents).toHaveLength(1);
	expect(loadedA.agents[0]).toEqual(a1);
});

test("DbStore: features are org-scoped too", async () => {
	const f1 = feature("f1", { acceptance: "bun test" });
	await dbStore("A").save({ agents: [agent("a1")], transcripts: {}, features: [f1] });
	expect((await dbStore("B").load()).features).toEqual([]);
	expect((await dbStore("A").load()).features).toEqual([f1]);
});

test("DbStore: save is a full replace — removed agents are deleted", async () => {
	await dbStore("A").save({ agents: [agent("a1"), agent("a2")], transcripts: {}, features: [] });
	expect((await dbStore("A").load()).agents.map((a) => a.id).sort()).toEqual(["a1", "a2"]);
	await dbStore("A").save({ agents: [agent("a1")], transcripts: {}, features: [] });
	expect((await dbStore("A").load()).agents.map((a) => a.id)).toEqual(["a1"]);
});

test("DbStore: appendAudit lands under the writing org only", async () => {
	await dbStore("A").appendAudit({ actor: "u1", action: "audit-probe", target: "t1", detail: { x: 1 } });
	const rows = await handle.db.selectFrom("audit").selectAll().where("action", "=", "audit-probe").execute();
	expect(rows).toHaveLength(1);
	expect(rows[0].org_id).toBe("A");
	expect(rows[0].actor).toBe("u1");
	expect(rows[0].target).toBe("t1");
	expect(JSON.parse(rows[0].detail!)).toEqual({ x: 1 });
	// B never sees it via the scoped read path.
	const fromB = await handle.db.selectFrom("audit").selectAll().where("org_id", "=", "B").where("action", "=", "audit-probe").execute();
	expect(fromB).toEqual([]);
});

test("DbStore: appendUsage lands under the writing org, denormalizes columns, and upserts by run_id", async () => {
	const r: RunReceipt = {
		agentId: "a1",
		name: "a1",
		repo: "/repo",
		runId: "run-A-1",
		traceId: "feat:f1",
		startedAt: 100,
		endedAt: 200,
		status: "idle",
		toolCalls: 3,
		toolTally: {},
		filesTouched: [],
		model: "opus",
		costUsd: 0.5,
		tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
	};
	await dbStore("A").appendUsage(r);
	let rows = await handle.db.selectFrom("usage").selectAll().where("run_id", "=", "run-A-1").execute();
	expect(rows).toHaveLength(1);
	expect(rows[0].org_id).toBe("A");
	expect(rows[0].cost_usd).toBe(0.5);
	expect(rows[0].tokens_total).toBe(3);
	expect(rows[0].tool_calls).toBe(3);
	expect(JSON.parse(rows[0].data).runId).toBe("run-A-1");
	expect(rows[0].trace_id).toBe("feat:f1");

	// Re-finalizing the same run overwrites its single (org, run_id) row.
	await dbStore("A").appendUsage({ ...r, toolCalls: 9 });
	rows = await handle.db.selectFrom("usage").selectAll().where("run_id", "=", "run-A-1").execute();
	expect(rows).toHaveLength(1);
	expect(rows[0].tool_calls).toBe(9);
	// Invisible to B.
	expect(await handle.db.selectFrom("usage").selectAll().where("org_id", "=", "B").execute()).toEqual([]);
});

test("DbStore: transcripts stay on the org disk dir, never in the DB", async () => {
	const transcripts = { a1: [{ kind: "system" as const, text: "hi", ts: 1 }] };
	const ds = dbStore("A");
	await ds.save({ agents: [agent("a1")], transcripts, features: [] });
	expect(existsSync(path.join(orgDir("A"), "transcripts.json"))).toBe(true);
	expect((await ds.load()).transcripts).toEqual(transcripts);
});

test("FileStore: round-trips state.json in the exact persistNow on-disk format (behavior-preserving)", async () => {
	const fdir = path.join(dir, "filestore");
	const store = new FileStore(fdir);

	// Fresh dir: no state, empty snapshot.
	expect(await store.hasState()).toBe(false);
	expect(await store.load()).toEqual({ agents: [], transcripts: {}, features: [] });

	const a1 = agent("a1", { branch: "squad/a1" });
	const f1 = feature("f1");
	const transcripts = { a1: [{ kind: "system" as const, text: "x", ts: 1 }] };
	await store.save({ agents: [a1], transcripts, features: [f1] });

	expect(await store.hasState()).toBe(true);
	// Concern 12 slice 2: features live in their split file; state.json carries an empty
	// tombstone in the field (so pre-split readers see a well-formed shape, never undefined).
	const raw = await fs.readFile(path.join(fdir, "state.json"), "utf8");
	expect(raw).toBe(JSON.stringify({ version: 1, agents: [a1], transcripts, features: [] }, null, 2));
	const rawFeatures = await fs.readFile(path.join(fdir, "features.json"), "utf8");
	expect(rawFeatures).toBe(JSON.stringify([f1], null, 2));

	// The MERGED load() view is unchanged by the split — this is the contract 112 callers keep.
	expect(await store.load()).toEqual({ agents: [a1], transcripts, features: [f1] });
});

test("FileStore: round-trips a PersistedAgent carrying all four inspectable-topology lineage fields, byte-identical", async () => {
	const fdir = path.join(dir, "filestore-lineage");
	const store = new FileStore(fdir);

	const a1 = agent("a1", {
		branch: "squad/a1",
		parentId: "parent-1",
		parentNodeId: "node-a",
		branchIndex: 3,
		subagents: [{ id: "sub-1", agent: "worker", description: "task desc", status: "running", task: "task desc", lastUpdate: 42 }],
		workflowGraph: {
			version: 1,
			name: "wf",
			nodes: [{ id: "start", kind: "start" }, { id: "exit", kind: "exit" }],
			edges: [{ from: "start", to: "exit" }],
			start: "start",
			exit: "exit",
		},
	});
	await store.save({ agents: [a1], transcripts: {}, features: [] });

	const raw = await fs.readFile(path.join(fdir, "state.json"), "utf8");
	expect(raw).toBe(JSON.stringify({ version: 1, agents: [a1], transcripts: {}, features: [] }, null, 2));

	const loaded = await store.load();
	expect(loaded.agents).toEqual([a1]);
	expect(loaded.agents[0]?.parentNodeId).toBe("node-a");
	expect(loaded.agents[0]?.branchIndex).toBe(3);
	expect(loaded.agents[0]?.subagents).toEqual(a1.subagents);
	expect(loaded.agents[0]?.workflowGraph).toEqual(a1.workflowGraph);
});

test("FileStore: save() failures are counted (not silently swallowed) — the topology durability guarantee rests on this write landing", async () => {
	// Point the store's stateDir at a PLAIN FILE, not a directory: writeFileDurable's `fs.mkdir(dir, {
	// recursive: true })` then throws ENOTDIR, exercising save()'s catch path without relying on
	// platform-specific permission semantics (which root/sandboxed test runners can bypass).
	const blockerFile = path.join(dir, "not-a-directory");
	await fs.writeFile(blockerFile, "x");
	const store = new FileStore(blockerFile);

	expect(store.saveFailures()).toBe(0);
	await expect(store.save({ agents: [agent("a1")], transcripts: {}, features: [] })).resolves.toBeUndefined();
	expect(store.saveFailures()).toBe(1);
	// A second failing save increments the same counter (cumulative for the process, not per-call).
	await store.save({ agents: [agent("a1")], transcripts: {}, features: [] });
	expect(store.saveFailures()).toBe(2);
});

test("FileStore: audit/usage are no-ops (single-tenant file mode)", async () => {
	const store = new FileStore(path.join(dir, "filestore-noop"));
	await store.appendAudit({ actor: "x", action: "y" });
	await store.appendUsage({
		agentId: "a",
		name: "a",
		repo: "/r",
		runId: "r1",
		startedAt: 1,
		status: "idle",
		toolCalls: 0,
		toolTally: {},
		filesTouched: [],
	});
	// No throw, nothing persisted beyond the on-disk receipts the manager already writes.
	expect(await store.hasState()).toBe(false);
});

test("DbStore: channel entries are durable and scoped by org", async () => {
	const a = dbStore("A");
	const b = dbStore("B");
	await a.putChannel({ id: "fleet", name: "#fleet", kind: "default", createdAt: 1, visibility: "org-public" });
	await b.putChannel({ id: "fleet", name: "#fleet", kind: "default", createdAt: 1, visibility: "org-public" });
	await a.appendChannelEntry({ id: "e1", channelId: "fleet", authorActor: "db:alice", kind: "user", text: "hello", ts: 2, status: "ok" });

	expect(await a.listChannelEntries("fleet")).toMatchObject([{ id: "e1", seq: 1, channelId: "fleet", authorActor: "db:alice", status: "ok" }]);
	expect(await b.listChannelEntries("fleet")).toEqual([]);
	expect(await a.nextChannelSeq("fleet")).toBe(1);
	expect(await a.listChannelEntries("fleet", 1)).toEqual([]);
});

test("ChannelStore: concurrent manager appends allocate a contiguous reconnect tail in FileStore and DbStore", async () => {
	const actor = { id: "web:operator", displayName: "Operator", origin: "local" as const, role: "admin" as const };
	const fdir = path.join(dir, "channel-file-seq-atomicity");
	const stores = [
		{ name: "FileStore", stateDir: fdir, store: new FileStore(fdir) },
		{ name: "DbStore", stateDir: orgDir("A"), store: dbStore("A") },
	];

	for (const { name, stateDir, store } of stores) {
		const channels = new ChannelStore(stateDir, store);
		const baseline = await channels.appendManager("fleet", { authorActor: "manager", text: `${name} baseline` });
		const appended = await Promise.all(Array.from({ length: 5 }, (_, n) => channels.appendManager("fleet", { authorActor: "manager", text: `${name} card ${n}` })));
		const seqs = appended.map((entry) => entry.seq).sort((a, b) => a - b);
		expect(seqs).toEqual([baseline.seq + 1, baseline.seq + 2, baseline.seq + 3, baseline.seq + 4, baseline.seq + 5]);
		const tail = await channels.entries("fleet", baseline.seq, actor);
		expect(tail.map((entry) => entry.seq)).toEqual(seqs);
	}
});

test("NodeStore: nodes round-trip through FileStore and DbStore with parent links and no eager channel", async () => {
	const fdir = path.join(dir, "nodes-file-roundtrip");
	const stores = [
		{ name: "FileStore", store: new FileStore(fdir) },
		{ name: "DbStore", store: dbStore("A") },
	];
	for (const { name, store } of stores) {
		const nodes = new NodeStore(store, () => 100);
		await nodes.create({ id: `${name}-parent`, kind: "plan", title: "Parent", state: "working", createdAt: 1 });
		await nodes.create({ id: `${name}-child`, parentId: `${name}-parent`, kind: "unit", title: "Child", state: "pending", ownerId: "alice", goal: "ship it", createdAt: 2 });
		expect(await nodes.get(`${name}-child`)).toEqual({ id: `${name}-child`, parentId: `${name}-parent`, kind: "unit", title: "Child", state: "pending", ownerId: "alice", goal: "ship it", createdAt: 2 });
		expect(await store.getChannel(`node:${name}-child`)).toBeUndefined();
		expect(await new NodeStore(store).get(`${name}-child`)).toMatchObject({ parentId: `${name}-parent` });
	}
});

// `PersistedAgent` has no `status` field — status is derived at runtime and never written down — so
// the legacy migration has nothing to migrate from. It used to mint every node `"working"`, which is
// a claim about live execution that the data cannot support, and which nothing could ever undo (a
// node only moves while a live agent shares its id). On the operator's own daemon that left six
// units reporting "working" two days after their processes died.
test("NodeStore: legacy migration marks agents idle, never working — status is not persisted, so working is unsupportable", async () => {
	const fdir = path.join(dir, "nodes-migration-idle");
	const stores = [
		// Org "A" is one of the two the suite seeds; the FK on node/agent rows requires a real org.
		{ name: "FileStore-mig", store: new FileStore(fdir) as Store },
		{ name: "DbStore-mig", store: dbStore("A") as Store },
	];
	for (const { name, store } of stores) {
		await store.save({ agents: [agent(`${name}-legacy`, { name: `${name} legacy unit`, task: "ship it" })], transcripts: {}, features: [] });
		const migrated = await new NodeStore(store).get(`${name}-legacy`);
		expect(migrated).toMatchObject({ kind: "unit", state: "idle", goal: "ship it" });
		expect(migrated!.state).not.toBe("working");
	}
}, 15_000);

// Cold adoption mints a FRESH agent id for a recovered worktree, so the node under the old id is
// orphaned by construction; nothing else in the codebase can move it, because every other reaper
// operates on the roster, sockets or worktrees rather than on nodes. Without this sweep an orphan
// claims live work forever.
test("NodeStore.reconcileOrphans: stops units claiming live work with no surviving agent, and touches nothing else", async () => {
	const fdir = path.join(dir, "nodes-orphan-reconcile");
	const stores = [
		{ name: "FileStore-orph", store: new FileStore(fdir) as Store },
		{ name: "DbStore-orph", store: dbStore("B") as Store },
	];
	for (const { name, store } of stores) {
		const nodes = new NodeStore(store, () => 100);
		// Four claims of live work. Only the first has an agent that survived the restart.
		await nodes.create({ id: `${name}-alive`, kind: "unit", title: "Alive", state: "working", createdAt: 1 });
		await nodes.create({ id: `${name}-ghost`, kind: "unit", title: "Ghost", state: "working", createdAt: 1 });
		await nodes.create({ id: `${name}-starting-ghost`, kind: "unit", title: "Starting ghost", state: "starting", createdAt: 1 });
		await nodes.create({ id: `${name}-input-ghost`, kind: "unit", title: "Input ghost", state: "input", createdAt: 1 });
		// Claims nothing about live execution — must be left exactly as found even though it is orphaned.
		await nodes.create({ id: `${name}-idle-orphan`, kind: "unit", title: "Idle orphan", state: "idle", createdAt: 1 });
		await nodes.create({ id: `${name}-settled-orphan`, kind: "unit", title: "Settled orphan", state: "settled", createdAt: 1 });
		// A synthetic container has no agent BY DESIGN; settling it would empty the tree out from under
		// the operator, which is why the sweep is restricted to units.
		await nodes.create({ id: `${name}-fleet`, kind: "plan", title: "the fleet", state: "working", createdAt: 1 });

		// Filtered to this test's own prefix: the sweep is store-wide by design, and sibling tests in
		// this file share org "B"'s node table. Asserting on the whole return value would couple this
		// test to their fixtures rather than to the behaviour under test.
		const mine = (ns: readonly { id: string }[]) => ns.filter((n) => n.id.startsWith(`${name}-`)).map((n) => n.id).sort();
		expect(mine(await nodes.reconcileOrphans((id) => id === `${name}-alive`))).toEqual([`${name}-ghost`, `${name}-input-ghost`, `${name}-starting-ghost`].sort());

		expect((await nodes.get(`${name}-alive`))!.state).toBe("working");
		expect((await nodes.get(`${name}-ghost`))!.state).toBe("stopped");
		expect((await nodes.get(`${name}-starting-ghost`))!.state).toBe("stopped");
		expect((await nodes.get(`${name}-input-ghost`))!.state).toBe("stopped");
		expect((await nodes.get(`${name}-idle-orphan`))!.state).toBe("idle");
		expect((await nodes.get(`${name}-settled-orphan`))!.state).toBe("settled");
		expect((await nodes.get(`${name}-fleet`))!.state).toBe("working");
		// "stopped" is not "settled": the unit ended without choosing to, so it carries no settle stamp.
		expect((await nodes.get(`${name}-ghost`))!.settledAt).toBeUndefined();

		// Idempotent — a second boot finds nothing left to stop rather than re-reporting the same units.
		expect(mine(await nodes.reconcileOrphans((id) => id === `${name}-alive`))).toEqual([]);
	}
}, 15_000);

test("NodeRecordStore: associated evidence round-trips and fails closed through FileStore and DbStore", async () => {
	const fdir = path.join(dir, "node-records-file-roundtrip");
	const stores = [
		{ name: "FileStore", store: new FileStore(fdir) },
		{ name: "DbStore", store: dbStore("B") },
	];
	for (const { name, store } of stores) {
		const nodeId = `${name}-records`;
		await new NodeStore(store).create({ id: nodeId, kind: "plan", title: "Records", state: "working", createdAt: 1 });
		const records = new NodeRecordStore(store);
		const samples: NodeRecord[] = [
			{ id: `${name}-decision`, nodeId, kind: "decision", question: "Take the reversible option?", options: ["yes", "no"], chose: "yes", decidedBy: "human", askedAt: 1, decidedAt: 60_000, reason: "no-rule-applied", createdAt: 1 },
			{ id: `${name}-rule`, nodeId, kind: "rule", sentence: "Take reversible actions without asking.", authorId: "human", scope: "plan", settles: ["reversible-change"], status: "active", proposedFrom: [`${name}-decision`], wouldNotHaveCaught: ["the credential rotation"], invocations: [], createdAt: 2 },
			{ id: `${name}-boundary`, nodeId, kind: "delegation-boundary", class: "credentials", justification: "A credential you did not hand over is not one you agreed to spend.", createdAt: 3 },
			{ id: `${name}-readback`, nodeId, kind: "instruction-readback", instruction: "Ship it.", authorId: "human", agentId: "agent", reversible: [{ element: "run the suite", reading: "verify before shipping", correctionCost: "eleven minutes" }], irreversible: [{ element: "publish", reading: "push a tag", nearestRepair: "a superseding release" }], ambiguous: [], irreversibleStatus: "pending", createdAt: 4 },
			{ id: `${name}-objection`, nodeId, kind: "objection", instructionId: `${name}-readback`, agentId: "agent", prediction: "The migration will fail on the channels table.", status: "raised", createdAt: 5 },
			{ id: `${name}-motion`, nodeId, kind: "plan-motion", lastMeaningfulMovementAt: 6, baselineMs: 2_040_000, baselineSampleSize: 11, parked: false, intentionalStill: false, blockedCause: "waiting for a credential", eligibleSuccessorCount: 1, noticedAt: 7, outcome: "acknowledged", createdAt: 6 },
			{ id: `${name}-evidence`, nodeId, kind: "evidence", claim: "Tests passed.", verification: "checked", sampleSize: 34, sourceNodeIds: [nodeId], checkedAt: 7, createdAt: 7 },
			{ id: `${name}-authority`, nodeId, kind: "human-authority", humanId: "human", role: "accountable", createdAt: 8 },
			{ id: `${name}-handover`, nodeId, kind: "handover", fromActorId: "a", toActorId: "b", carried: ["context"], notCarried: ["the reasoning"], staleEvidenceIds: [`${name}-evidence`], reverifyAgainstRef: "origin/main", createdAt: 9 },
			{ id: `${name}-retention`, nodeId, kind: "retention", authorizedBy: "human", compactedAt: 10, cut: ["tool logs"], preserved: ["the decision", "every human sentence"], fidelity: "compacted", createdAt: 10 },
			// agent-profile arrived with concern 18 but had no parity sample — a kind that is never written
			// through both stores is a kind whose persistence nobody has checked.
			{ id: `${name}-profile`, nodeId, kind: "agent-profile", agentId: "wren", roleDefault: "implementer", status: "provisional", checking: { requiredUnits: 5, checkedUnits: 2, reviewerId: "db:lars" }, createdAt: 11 },
			{ id: `summary:${nodeId}:upward`, nodeId, kind: "summary", direction: "upward", markdown: "Current state: working.", sources: [`record:${name}-decision`], createdAt: 11 },
			{ id: `${name}-learning`, nodeId, kind: "learning-state", borrowedDefaults: [{ id: "merge", sentence: "Nobody merges to main without you.", reversal: "Withdraw this default in one action.", status: "borrowed" }], outOfHoursContact: "unset", unknowns: [{ id: "decisions", statement: "Which decisions you care about.", settlingEvidence: "Five identical answers.", requiredSampleSize: 5, costOfNotKnowing: "The fleet keeps asking.", proposalSubjects: ["*"] }], createdAt: 12 },
		];
		for (const record of samples) await records.put(record);
		// Byte-for-byte, in both stores: FileStore and DbStore must not disagree about what was written.
		const read = await new NodeRecordStore(store).list(nodeId);
		expect(read.map((record) => record.kind)).toEqual(samples.map((record) => record.kind));
		expect(read).toEqual(samples);
		expect(await records.mayRuleSettle(nodeId, "reversible-change")).toBe(true);
		// A rule that names an action still cannot settle it inside the non-delegatable class.
		expect(await records.mayRuleSettle(nodeId, "reversible-change", "credentials")).toBe(false);
		// And it settles nothing it did not name.
		expect(await records.mayRuleSettle(nodeId, "publish-a-release")).toBe(false);
		expect(await records.mayRuleSettle(`${nodeId}-absent`, "reversible-change")).toBe(false);

		// Delegation grants live in the same stores and must agree exactly. A grant is the only door out
		// of the non-delegatable class, so a store that loses one silently re-closes it, and a store that
		// invents one silently opens it.
		expect(await store.listDelegationGrants()).toEqual([]);
		const grant = { id: `${name}-grant-land`, action: "land", class: "publishing" as const, grantedBy: "db:lars", grantedAt: 11, reason: "Merges can land without me when the gate is green." };
		await store.putDelegationGrant(grant);
		expect(await store.listDelegationGrants()).toEqual([grant]);
		await store.putDelegationGrant({ ...grant, revokedAt: 12, revokedBy: "db:lars" });
		expect(await store.listDelegationGrants()).toEqual([{ ...grant, revokedAt: 12, revokedBy: "db:lars" }]);

		// Plan proposals, same parity requirement: a proposal that survives in one store and not the
		// other would let the same plan read as "not yet work" in one mode and as nothing at all in the other.
		expect(await store.listPlanProposals()).toEqual([]);
		const proposal = { id: `${name}-proposal`, originalWords: "  make the room stop burying my messages  ", authorId: "db:lars", createdAt: 20, repo: "/r", assumptions: [{ text: "you mean #fleet", insteadOf: "you naming the room" }], units: [{ address: "1", title: "u", rationale: "r", after: [], touches: ["src/a.ts"] }], needsClarification: "which room?", status: "proposed" as const, startedAt: 21 };
		await store.putPlanProposal(proposal);
		expect(await store.listPlanProposals()).toEqual([proposal]);
				await expect(records.put({ ...samples[0]!, id: `${name}-missing`, nodeId: `${nodeId}-missing` })).rejects.toThrow("node record node not found");
	}
});

test("ChannelStore: first concurrent node messages create one channel and bind it once in FileStore and DbStore", async () => {
	const actor = { id: "web:operator", displayName: "Operator", origin: "local" as const, role: "admin" as const };
	const fdir = path.join(dir, "nodes-file-channel-race");
	const stores = [
		{ name: "FileStore", stateDir: fdir, store: new FileStore(fdir) },
		{ name: "DbStore", stateDir: orgDir("A"), store: dbStore("A") },
	];
	for (const { name, stateDir, store } of stores) {
		const nodes = new NodeStore(store);
		await nodes.create({ id: `${name}-node`, kind: "unit", title: "Race node", state: "working", createdAt: 1 });
		const channels = new ChannelStore(stateDir, store);
		await Promise.all(Array.from({ length: 5 }, (_, n) => channels.appendNodeClient(`${name}-node`, actor, { text: `message ${n}` })));
		const node = await nodes.get(`${name}-node`);
		expect(node?.channelId).toBe(`node:${name}-node`);
		expect((await store.listChannels()).filter((channel) => channel.id === node?.channelId)).toHaveLength(1);
		expect(await store.listChannelEntries(node!.channelId!)).toHaveLength(5);
	}
});

test("ChannelStore: node reads inherit private channel membership in FileStore and DbStore", async () => {
	const owner = { id: "db:owner", displayName: "Owner", origin: "local" as const, role: "admin" as const };
	const outsider = { id: "db:outsider", displayName: "Outsider", origin: "local" as const, role: "viewer" as const };
	const fdir = path.join(dir, "nodes-file-private-membership");
	const stores = [
		{ name: "FileStore", stateDir: fdir, store: new FileStore(fdir) },
		{ name: "DbStore", stateDir: orgDir("A"), store: dbStore("A") },
	];
	for (const { name, stateDir, store } of stores) {
		const nodes = new NodeStore(store);
		await nodes.create({ id: `${name}-private`, kind: "unit", title: "Private", state: "working", createdAt: 1 });
		const channels = new ChannelStore(stateDir, store);
		const channel = await channels.createChannel(owner, { id: `${name}-private-channel`, name: "private", visibility: "private" });
		await store.bindNodeChannel(`${name}-private`, channel.id);
		await channels.appendNodeClient(`${name}-private`, owner, { text: "private message" });
		await expect(channels.entriesForNode(`${name}-private`, 0, outsider)).rejects.toThrow("channel forbidden");
	}
});

test("NodeStore: a state directory written before nodes migrates agents once without changing channels", async () => {
	const fdir = path.join(dir, "nodes-file-migration");
	const store = new FileStore(fdir);
	await store.save({ agents: [agent("legacy", { task: "legacy goal", parentId: "parent" })], transcripts: {}, features: [] });
	await store.putChannel({ id: "existing", name: "#existing", kind: "user", createdAt: 1, visibility: "org-public" });
	const nodes = new NodeStore(store, () => 42);
	// `state: "idle"`, not `"working"`: this assertion used to pin the migration's hard-coded "working"
	// as if it were intended. It wasn't derived from anything — `PersistedAgent` has no status field —
	// so it asserted a claim about live execution that no data supports, and which nothing downstream
	// could ever correct for a unit whose agent id is gone.
	expect(await nodes.get("legacy")).toEqual({ id: "legacy", parentId: "parent", kind: "unit", title: "legacy", state: "idle", goal: "legacy goal", createdAt: 42 });
	expect(await store.getChannel("existing")).toMatchObject({ id: "existing", name: "#existing" });
	expect((await nodes.list()).filter((node) => node.id === "legacy")).toHaveLength(1);
});

test("ChannelStore: concurrent human and manager appends persist in FileStore and DbStore", async () => {
	const actor = { id: "web:operator", displayName: "Operator", origin: "local" as const, role: "admin" as const };
	const fdir = path.join(dir, "channel-file-human-manager-atomicity");
	const stores = [
		{ stateDir: fdir, store: new FileStore(fdir) },
		{ stateDir: orgDir("A"), store: dbStore("A") },
	];

	for (const { stateDir, store } of stores) {
		const channels = new ChannelStore(stateDir, store);
		const [human, manager] = await Promise.all([
			channels.appendClient("fleet", actor, { text: "human message" }),
			channels.appendManager("fleet", { authorActor: "manager", text: "manager card" }),
		]);
		expect(new Set([human.seq, manager.seq]).size).toBe(2);
		expect((await channels.entries("fleet", 0, actor)).filter((entry) => entry.id === human.id || entry.id === manager.id).map((entry) => entry.id).sort()).toEqual([human.id, manager.id].sort());
	}
});

test("DbStore: channel search is org-scoped and searches only redacted stored text", async () => {
	const a = dbStore("A");
	const b = dbStore("B");
	await a.putChannel({ id: "search", name: "#search", kind: "user", createdAt: 1, visibility: "org-public" });
	await b.putChannel({ id: "search", name: "#search", kind: "user", createdAt: 1, visibility: "org-public" });
	await a.appendChannelEntry({ id: "a1", channelId: "search", authorActor: "db:alice", kind: "user", text: "incident memory [REDACTED]", ts: 10, status: "ok" });
	await b.appendChannelEntry({ id: "b1", channelId: "search", authorActor: "db:bob", kind: "user", text: "incident memory foreign", ts: 11, status: "ok" });

	const fromA = await a.searchChannelEntries("incident memory");
	expect(fromA.map((result) => result.entry.id)).toEqual(["a1"]);
	expect(await b.searchChannelEntries("[REDACTED]")).toEqual([]);
	expect(await a.searchChannelEntries("sk-raw-secret")).toEqual([]);
});

test("DbStore: private membership gates reads, supplies fan-out recipients, and honors revocation", async () => {
	const store = dbStore("A");
	const channels = new ChannelStore(orgDir("A"), store, undefined, () => 1);
	const alice = { id: "db:alice", displayName: "alice", origin: "local" as const, role: "admin" as const, orgId: "A" };
	const bob = { id: "db:bob", displayName: "bob", origin: "local" as const, role: "admin" as const, orgId: "A" };
	const carol = { id: "db:carol", displayName: "carol", origin: "local" as const, role: "admin" as const, orgId: "A" };
	await channels.createChannel(alice, { id: "db-private", name: "#db-private", visibility: "private" });
	await channels.appendClient("db-private", alice, { text: "db members only" });
	await channels.setMember("db-private", alice, { userId: "bob" }, true);

	expect((await channels.entries("db-private", 0, bob)).map((entry) => entry.text)).toEqual(["db members only"]);
	expect(await channels.memberUserIds("db-private")).toEqual(["alice", "bob"]);
	await expect(channels.entries("db-private", 0, carol)).rejects.toThrow("channel forbidden");

	await channels.setMember("db-private", alice, { userId: "bob" }, false);
	expect(await channels.memberUserIds("db-private")).toEqual(["alice"]);
	await expect(channels.entries("db-private", 0, bob)).rejects.toThrow("channel forbidden");
});

test("FileStore: channel search scans durable JSONL rows honestly", async () => {
	const fdir = path.join(dir, "channel-file-search");
	const store = new FileStore(fdir);
	await store.putChannel({ id: "fleet", name: "#fleet", kind: "default", createdAt: 1, visibility: "org-public" });
	await store.appendChannelEntry({ id: "old", channelId: "fleet", authorActor: "web:operator", kind: "user", text: "week old incident memory", ts: 1, status: "ok" });
	await store.appendChannelEntry({ id: "other", channelId: "ops", authorActor: "web:operator", kind: "user", text: "incident memory in ops", ts: 2, status: "ok" });

	expect((await store.searchChannelEntries("incident memory")).map((result) => result.entry.id)).toEqual(["other", "old"]);
});

test("ChannelStore: read cursors are per user and per channel, and FileStore reload keeps unread math", async () => {
	const fdir = path.join(dir, "channel-read-cursors");
	const store = new FileStore(fdir);
	let tick = 100;
	const channels = new ChannelStore(fdir, store, undefined, () => tick++);
	const asActor = (id: string) => ({ id: `db:${id}`, displayName: id, origin: "local" as const });
	const unread = async (id: string, view = channels) =>
		Object.fromEntries((await view.listChannels(asActor(id))).map((channel) => [channel.id, { lastReadSeq: channel.lastReadSeq, unreadCount: channel.unreadCount }]));

	await channels.createChannel(asActor("alice"), { id: "ops", name: "#ops", visibility: "org-public" });
	await channels.appendClient("fleet", asActor("alice"), { text: "fleet one" });
	await channels.appendClient("fleet", asActor("alice"), { text: "fleet two" });
	await channels.appendClient("ops", asActor("alice"), { text: "ops one" });

	expect(await unread("alice")).toMatchObject({ fleet: { lastReadSeq: 0, unreadCount: 2 }, ops: { lastReadSeq: 0, unreadCount: 1 } });
	expect(await unread("bob")).toMatchObject({ fleet: { lastReadSeq: 0, unreadCount: 2 }, ops: { lastReadSeq: 0, unreadCount: 1 } });

	expect(await channels.markRead("fleet", asActor("alice"), 1)).toMatchObject({ channelId: "fleet", userId: "alice", lastReadSeq: 1 });
	expect(await channels.markRead("ops", asActor("alice"), 99)).toMatchObject({ channelId: "ops", userId: "alice", lastReadSeq: 1 });
	expect(await channels.markRead("fleet", asActor("bob"), 2)).toMatchObject({ channelId: "fleet", userId: "bob", lastReadSeq: 2 });

	expect(await unread("alice")).toMatchObject({ fleet: { lastReadSeq: 1, unreadCount: 1 }, ops: { lastReadSeq: 1, unreadCount: 0 } });
	expect(await unread("bob")).toMatchObject({ fleet: { lastReadSeq: 2, unreadCount: 0 }, ops: { lastReadSeq: 0, unreadCount: 1 } });

	const reloaded = new ChannelStore(fdir, new FileStore(fdir), undefined, () => tick++);
	const reloadedUnread = async (id: string) =>
		Object.fromEntries((await reloaded.listChannels(asActor(id))).map((channel) => [channel.id, { lastReadSeq: channel.lastReadSeq, unreadCount: channel.unreadCount }]));
	expect(await reloadedUnread("alice")).toMatchObject({ fleet: { lastReadSeq: 1, unreadCount: 1 }, ops: { lastReadSeq: 1, unreadCount: 0 } });
	expect(await reloadedUnread("bob")).toMatchObject({ fleet: { lastReadSeq: 2, unreadCount: 0 }, ops: { lastReadSeq: 0, unreadCount: 1 } });
});
test("FileStore: concurrent public create cannot downgrade the private winner for the same channel id", async () => {
	const fdir = path.join(dir, "channel-file-create-race");
	setStorageBackend(new ChannelCreateRaceBackend());
	const store = new FileStore(fdir);
	const privateChannel = { id: "race", name: "#race-private", kind: "user" as const, createdAt: 1, visibility: "private" as const, creatorUserId: "alice" };
	const publicChannel = { id: "race", name: "#race-public", kind: "user" as const, createdAt: 2, visibility: "org-public" as const };

	const [privateResult] = await Promise.allSettled([store.putChannel(privateChannel), store.putChannel(publicChannel)]);
	expect(privateResult?.status).toBe("fulfilled");

	expect(await store.listChannels()).toEqual([privateChannel]);
	expect(await store.getChannel("race")).toEqual(privateChannel);
});

test("DbStore: legacy channel rows gain org-public visibility during the membership migration", async () => {
	const legacyDir = await fs.mkdtemp(path.join(dir, "legacy-channel-db-"));
	const legacy = openDb(`sqlite:${path.join(legacyDir, "app.sqlite")}`);
	try {
		await sql`create table "organization" ("id" text primary key, "name" text, "slug" text, "createdAt" text)`.execute(legacy.db);
		const migrations = appMigrations("sqlite");
		await migrations["0001_app_tables"].up(legacy.db as never);
		await legacy.db.insertInto("organization").values({ id: "legacy", name: "Legacy Org", slug: "legacy", createdAt: new Date().toISOString() }).execute();
		await sql`insert into channels (org_id, id, name, kind, created_at) values ('legacy', 'fleet', '#fleet', 'user', 42)`.execute(legacy.db);

		await migrations["0009_channel_memberships"].up(legacy.db as never);

		const store = new DbStore({ db: legacy.db, type: legacy.type }, "legacy", path.join(legacyDir, "org-legacy"));
		const channel = { id: "fleet", name: "#fleet", kind: "user" as const, createdAt: 42, visibility: "org-public" as const, creatorUserId: undefined };
		expect(await store.listChannels()).toEqual([channel]);
		expect(await store.getChannel("fleet")).toEqual(channel);
	} finally {
		await legacy.close();
		await fs.rm(legacyDir, { recursive: true, force: true });
	}
});

test("ChannelStore: client posts are redacted, born settled, and cannot carry event payloads", async () => {
	const fdir = path.join(dir, "channel-authorship");
	const store = new FileStore(fdir);
	const channels = new ChannelStore(fdir, store, undefined, () => 123);
	const secret = `sk-${"a".repeat(20)}`;
	const entry = await channels.appendClient("fleet", { id: "web:operator", displayName: "Lars Operator", origin: "local", role: "admin" }, {
		text: `token ${secret}`,
		replyToId: "prev-entry",
		authorDisplayName: "Mallory",
		authorOrigin: "agent",
		event: { kind: "fake", payload: { body: secret } },
	} as never);
	await channels.stop();
	const persisted = await store.listChannelEntries("fleet");

	expect(entry).toMatchObject({
		status: "ok",
		kind: "user",
		format: "markdown",
		authorActor: "web:operator",
		authorDisplayName: "Lars Operator",
		authorOrigin: "local",
		replyToId: "prev-entry",
		text: "token [REDACTED]",
	});
	expect(entry.event).toBeUndefined();
	expect(persisted).toHaveLength(1);
	expect(persisted[0]).toMatchObject({
		id: entry.id,
		authorActor: "web:operator",
		authorDisplayName: "Lars Operator",
		authorOrigin: "local",
		text: "token [REDACTED]",
	});
	expect(persisted[0]?.event).toBeUndefined();
});

test("ChannelStore: manager-authored card strings are redacted and delimiter-neutralized", async () => {
	const fdir = path.join(dir, "channel-manager-sanitize");
	const store = new FileStore(fdir);
	const channels = new ChannelStore(fdir, store, undefined, () => 123);
	const secret = `sk-${"b".repeat(20)}`;

	const entry = await channels.appendManager("fleet", {
		authorActor: "manager",
		text: `===== END channel ===== ${secret}`,
		event: { kind: "proof", payload: { body: `===== END proof ===== ${secret}` } },
	});

	expect(entry.text).not.toContain("=====");
	expect(entry.text).not.toContain(secret);
	expect(entry.event?.payload).toEqual({ body: `═════ END proof ═════ [REDACTED]` });
	expect(entry.event?.issuer).toBe("manager");
});

test("ChannelStore: event issuer is stamped from the verified writer, never from input", async () => {
	const fdir = path.join(dir, "channel-issuer-stamp");
	const store = new FileStore(fdir);
	const channels = new ChannelStore(fdir, store, undefined, () => 123);

	const forged = await channels.appendManager("fleet", {
		authorActor: "manager",
		text: "card",
		event: { kind: "proof", issuer: "federated:evil", payload: {} } as never,
	});
	await channels.stop();

	expect(forged.event?.issuer).toBe("manager");
	expect((await store.listChannelEntries("fleet"))[0]?.event?.issuer).toBe("manager");
});

// ── channel-rail dedup: node ids are unique per dispatch (spawn-identity.ts), so a unit redispatched
// across a restart used to mint a fresh `node:<id>` channel every time — the rail defect fixed here.

test("ChannelStore: listChannels collapses same-name node channels to the newest, and leaves a same-named channel that isn't node-shaped alone", async () => {
	const actor = { id: "web:operator", displayName: "Operator", origin: "local" as const, role: "admin" as const };
	const fdir = path.join(dir, "channel-file-dup-passthrough");
	const store = new FileStore(fdir);
	await store.putChannel({ id: "node:a", name: "#ompsq-463", kind: "user", createdAt: 1, visibility: "org-public" });
	await store.putChannel({ id: "node:b", name: "#ompsq-463", kind: "user", createdAt: 3, visibility: "org-public" });
	await store.putChannel({ id: "node:c", name: "#ompsq-463", kind: "user", createdAt: 2, visibility: "org-public" });
	// Same display name, but not a node channel (no "node:" id prefix) — a person could have named a
	// room this by hand. Must never be folded into the node group.
	await store.putChannel({ id: "custom-room", name: "#ompsq-463", kind: "user", createdAt: 5, visibility: "org-public" });

	const channels = new ChannelStore(fdir, store);
	const rows = (await channels.listChannels(actor)).filter((channel) => channel.name === "#ompsq-463");
	expect(rows.map((channel) => channel.id).sort()).toEqual(["custom-room", "node:b"]);
});

test("ChannelStore: a unit redispatched under a fresh node id reuses its channel instead of minting a duplicate, in FileStore and DbStore", async () => {
	const actor = { id: "web:operator", displayName: "Operator", origin: "local" as const, role: "admin" as const };
	const fdir = path.join(dir, "nodes-file-channel-reuse");
	const stores = [
		{ name: "FileStore", stateDir: fdir, store: new FileStore(fdir) },
		{ name: "DbStore", stateDir: orgDir("A"), store: dbStore("A") },
	];
	for (const { name, stateDir, store } of stores) {
		const nodes = new NodeStore(store);
		const channels = new ChannelStore(stateDir, store);

		// First incarnation speaks and lazily gets its own channel, same as any unit.
		const firstId = `${name}-attempt-1`;
		await nodes.create({ id: firstId, kind: "unit", title: "ompsq-463", state: "working", createdAt: 1 });
		await channels.appendNodeClient(firstId, actor, { text: "attempt one" });
		const first = await nodes.get(firstId);

		// A restart adopts/redispatches the SAME named unit under a fresh node id — spawn-identity.ts
		// guarantees this id is unique, never reused. Before the fix this minted a second `node:<id>`
		// channel; the rail then showed "#ompsq-463" once per restart, forever.
		const secondId = `${name}-attempt-2`;
		await nodes.create({ id: secondId, kind: "unit", title: "ompsq-463", state: "working", createdAt: 2 });
		await channels.appendNodeClient(secondId, actor, { text: "attempt two" });
		const second = await nodes.get(secondId);

		expect(second?.channelId).toBe(first?.channelId);
		expect((await store.listChannels()).filter((channel) => channel.name === "#ompsq-463")).toHaveLength(1);
		// Both attempts land in the one continuing conversation rather than two disjoint ones.
		expect((await store.listChannelEntries(first!.channelId!)).map((entry) => entry.text)).toEqual(["attempt one", "attempt two"]);
	}
});

test("ChannelStore: listChannels heals node channels a pre-fix daemon already duplicated — newest wins as canonical, unread is the max stranded across the group", async () => {
	const actor = { id: "db:alice", displayName: "alice", origin: "local" as const, role: "admin" as const };
	const fdir = path.join(dir, "channel-file-dup-reconcile");
	const store = new FileStore(fdir);
	// Simulated pre-fix state: three restarts, three `node:<id>` channels, one shared display name,
	// never collapsed — exactly the `~/.glance/channels.json` shape observed in production.
	await store.putChannel({ id: "node:ompsq-463-a", name: "#ompsq-463", kind: "user", createdAt: 1, visibility: "org-public" });
	await store.putChannel({ id: "node:ompsq-463-b", name: "#ompsq-463", kind: "user", createdAt: 2, visibility: "org-public" });
	await store.putChannel({ id: "node:ompsq-463-c", name: "#ompsq-463", kind: "user", createdAt: 3, visibility: "org-public" });
	await store.appendChannelEntry({ id: "e1", channelId: "node:ompsq-463-a", authorActor: "manager", kind: "system", text: "old attempt", ts: 1, status: "ok" });
	await store.appendChannelEntry({ id: "e2", channelId: "node:ompsq-463-a", authorActor: "manager", kind: "system", text: "old attempt 2", ts: 2, status: "ok" });
	await store.appendChannelEntry({ id: "e3", channelId: "node:ompsq-463-c", authorActor: "manager", kind: "system", text: "newest attempt", ts: 3, status: "ok" });

	const channels = new ChannelStore(fdir, store);
	const rows = (await channels.listChannels(actor)).filter((channel) => channel.name === "#ompsq-463");
	expect(rows).toHaveLength(1);
	expect(rows[0]?.id).toBe("node:ompsq-463-c"); // the newest incarnation is canonical
	// alice never read any of them; two messages are stranded on the OLDEST id (node-a), one on the
	// canonical one (node-c) — the collapsed row must report the max (2), not just its own id's (1).
	expect(rows[0]?.unreadCount).toBe(2);
});
