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

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type OrgContext } from "../src/dal/context.ts";
import { DbStore, FileStore } from "../src/dal/store.ts";
import { type DbHandle, openDatabase } from "../src/db/index.ts";
import type { PersistedAgent, PersistedFeature, RunReceipt } from "../src/types.ts";
import { ChannelStore } from "../src/channels.ts";

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

function agent(id: string, over: Partial<PersistedAgent> = {}): PersistedAgent {
	return { id, name: id, repo: "/repo", worktree: `/wt/${id}`, approvalMode: "write", ...over };
}
function feature(id: string, over: Partial<PersistedFeature> = {}): PersistedFeature {
	return { id, title: `Feature ${id}`, repo: "/repo", createdAt: 1, updatedAt: 2, ...over };
}
const orgDir = (org: string) => path.join(dir, `org-${org}`);
const dbStore = (org: string) => new DbStore(ctx, org, orgDir(org));

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
	// Byte-for-byte identical to the pre-refactor persistNow write.
	const raw = await fs.readFile(path.join(fdir, "state.json"), "utf8");
	expect(raw).toBe(JSON.stringify({ version: 1, agents: [a1], transcripts, features: [f1] }, null, 2));

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
	await a.putChannel({ id: "fleet", name: "#fleet", kind: "default", createdAt: 1 });
	await b.putChannel({ id: "fleet", name: "#fleet", kind: "default", createdAt: 1 });
	await a.appendChannelEntry({ id: "e1", seq: 1, channelId: "fleet", authorActor: "db:alice", kind: "user", text: "hello", ts: 2, status: "ok" });

	expect(await a.listChannelEntries("fleet")).toMatchObject([{ id: "e1", seq: 1, channelId: "fleet", authorActor: "db:alice", status: "ok" }]);
	expect(await b.listChannelEntries("fleet")).toEqual([]);
	expect(await a.nextChannelSeq("fleet")).toBe(1);
	expect(await a.listChannelEntries("fleet", 1)).toEqual([]);
});

test("ChannelStore: client posts are redacted, born settled, and cannot carry event payloads", async () => {
	const fdir = path.join(dir, "channel-authorship");
	const store = new FileStore(fdir);
	const channels = new ChannelStore(fdir, store, undefined, () => 123);
	const entry = await channels.appendClient("fleet", { id: "web:operator", role: "admin" }, { text: `token sk-${"a".repeat(20)}`, event: { kind: "fake", payload: {} } } as never);
	await channels.stop();

	expect(entry.status).toBe("ok");
	expect(entry.status).not.toBe("running");
	expect(entry.event).toBeUndefined();
	expect(entry.text).not.toContain(`sk-${"a".repeat(20)}`);
	expect(await store.listChannelEntries("fleet")).toHaveLength(1);
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
});
