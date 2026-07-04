/**
 * Persisted transition history (#lifecycle-truth concern 02): drives concern 01's guarded
 * transition()/setPending() through a seeded fake agent, then asserts the ring/spool/redaction/
 * endpoint contract this concern adds on top:
 *   (a) transitions.jsonl gets the expected lines after a flush wait
 *   (b) a fresh SquadManager pointed at the same stateDir hydrates the ring on construction
 *   (c) a cause string / pending title-message containing a fake secret comes back redacted
 *   (d) transitionHistory() (the manager call GET /api/agents/:id/transitions serves) is
 *       ring-only by default (no file I/O) and merges in file + priorId lineage with full:true
 */

import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SquadManager } from "../src/squad-manager.ts";
import { SubagentTracker } from "../src/subagents.ts";
import type { AgentDriver } from "../src/agent-driver.ts";
import type { DerivedReason, TransitionReason } from "../src/agent-lifecycle.ts";
import type { AgentDTO, AgentStatus, PendingRequest, PersistedAgent, RpcSessionState, TransitionEntry } from "../src/types.ts";

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

class NoopDriver extends EventEmitter implements AgentDriver {
	readonly isReady = true;
	readonly isAlive = true;
	start(): Promise<void> {
		return Promise.resolve();
	}
	stop(): Promise<void> {
		return Promise.resolve();
	}
	prompt(): Promise<void> {
		return Promise.resolve();
	}
	abort(): Promise<unknown> {
		return Promise.resolve();
	}
	getState(): Promise<RpcSessionState> {
		return Promise.reject(new Error("getState is never called in these tests"));
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

interface AgentRecordLike {
	dto: AgentDTO;
	agent: AgentDriver;
	options: PersistedAgent;
	transcript: unknown[];
	assistantBuf: string;
	thinkingBuf: string;
	streaming: boolean;
	subs: SubagentTracker;
	toolEntries: Map<string, unknown>;
}

/** The private lifecycle surface this test drives directly (concern 01's transition()/setPending(),
 *  concern 02's persisted transitionLog + transitionHistory()). */
interface LifecycleHost {
	agents: Map<string, AgentRecordLike>;
	transition: (rec: AgentRecordLike, to: AgentStatus, reason: TransitionReason, cause?: Record<string, unknown>) => void;
	setPending: (rec: AgentRecordLike, next: PendingRequest[], reason: DerivedReason, cause?: Record<string, unknown>, opts?: { callerOwnsStatus?: boolean }) => void;
	transitionLog: { recent: (limit?: number) => TransitionEntry[]; hydrateAll: () => Promise<TransitionEntry[]> };
	transitionHistory: (id: string, opts?: { full?: boolean }) => Promise<TransitionEntry[]>;
}

function seed(mgr: SquadManager, id: string, status: AgentStatus = "idle"): AgentRecordLike {
	const dto: AgentDTO = {
		id,
		name: id,
		status,
		kind: "omp-operator",
		repo: "/r",
		worktree: "/r",
		branch: `squad/${id}`,
		approvalMode: "yolo",
		pending: [],
		lastActivity: 0,
		messageCount: 0,
	};
	const options: PersistedAgent = { id, name: id, repo: "/r", worktree: "/r", approvalMode: "yolo" };
	const rec: AgentRecordLike = { dto, agent: new NoopDriver(), options, transcript: [], assistantBuf: "", thinkingBuf: "", streaming: false, subs: new SubagentTracker(), toolEntries: new Map() };
	(mgr as unknown as LifecycleHost).agents.set(id, rec);
	return rec;
}

async function freshStateDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "transition-history-"));
	tmps.push(dir);
	return dir;
}

test("transition()/setPending() spool to transitions.jsonl, and a fresh manager hydrates the ring", async () => {
	const stateDir = await freshStateDir();
	const mgr1 = new SquadManager({ stateDir });
	const host1 = mgr1 as unknown as LifecycleHost;
	const rec = seed(mgr1, "a1", "idle");

	host1.transition(rec, "working", "task-start");
	host1.setPending(rec, [{ id: "p1", source: "ui", kind: "confirm", title: "proceed?", message: "ok?", createdAt: Date.now() }], "pending-add");

	await Bun.sleep(30); // spool is fire-and-forget

	const ring = host1.transitionLog.recent().filter((e) => e.agentId === "a1");
	expect(ring.map((e) => e.reason)).toEqual(["task-start", "pending-add"]);
	expect(ring.every((e) => e.denied === undefined)).toBe(true);

	const file = path.join(stateDir, "transitions.jsonl");
	const lines = (await fs.readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as TransitionEntry);
	expect(lines.filter((e) => e.agentId === "a1").map((e) => e.reason)).toEqual(["task-start", "pending-add"]);

	// A fresh manager pointed at the same stateDir hydrates its ring from the file in the constructor.
	const mgr2 = new SquadManager({ stateDir });
	const host2 = mgr2 as unknown as LifecycleHost;
	const ring2 = host2.transitionLog.recent().filter((e) => e.agentId === "a1");
	expect(ring2.map((e) => e.reason)).toEqual(["task-start", "pending-add"]);
});

test("a distinct-state denied transition is spooled with denied:true, never silently dropped", async () => {
	const stateDir = await freshStateDir();
	const mgr = new SquadManager({ stateDir });
	const host = mgr as unknown as LifecycleHost;
	const rec = seed(mgr, "a1", "idle");

	// "pending-answer" is a DERIVED reason (Class D): illegal to leave "stopped"/"error". Force the agent
	// into "stopped" first via an explicit reason, then attempt a derived-reason transition away from it.
	host.transition(rec, "stopped", "kill");
	host.transition(rec, "working", "pending-answer" as TransitionReason);

	await Bun.sleep(20);
	const ring = host.transitionLog.recent().filter((e) => e.agentId === "a1");
	const denied = ring.find((e) => e.reason === "pending-answer");
	expect(denied?.denied).toBe(true);
	expect(rec.dto.status).toBe("stopped"); // the denied attempt never applied
});

test("cause strings and pending title/message are redacted before they touch the ring or disk", async () => {
	const stateDir = await freshStateDir();
	const mgr = new SquadManager({ stateDir });
	const host = mgr as unknown as LifecycleHost;
	const rec = seed(mgr, "a1", "idle");

	const secret = "sk-abcdefghijklmnopqrstuvwxyz012345";
	host.transition(rec, "error", "fail", { error: `boom: ${secret}` });
	host.setPending(rec, [{ id: "p1", source: "ui", kind: "confirm", title: `leaked ${secret}`, message: `also ${secret}`, createdAt: Date.now() }], "pending-add", undefined, { callerOwnsStatus: true });

	await Bun.sleep(30);

	// In-memory: cause.error redacted, and dto.pending's title/message redacted before storage.
	const ring = host.transitionLog.recent().filter((e) => e.agentId === "a1");
	const failEntry = ring.find((e) => e.reason === "fail");
	expect(failEntry?.cause?.error).not.toContain(secret);
	expect(failEntry?.cause?.error).toContain("[REDACTED]");
	expect(rec.dto.pending[0]?.title).not.toContain(secret);
	expect(rec.dto.pending[0]?.message).not.toContain(secret);
	expect(rec.dto.error).not.toContain(secret); // transition() assigns cause.error onto dto.error too

	// On disk: same redaction guarantee (append()'s existing chokepoint reopened for this new surface).
	const file = path.join(stateDir, "transitions.jsonl");
	const raw = await fs.readFile(file, "utf8");
	expect(raw).not.toContain(secret);
});

test("transitionHistory() is ring-only by default (no file I/O) and merges the file with full:true", async () => {
	const stateDir = await freshStateDir();
	const mgr = new SquadManager({ stateDir });
	const host = mgr as unknown as LifecycleHost;
	const rec = seed(mgr, "a1", "idle");

	host.transition(rec, "working", "task-start");
	host.transition(rec, "idle", "connect-ok");
	await Bun.sleep(30);

	let hydrateAllCalls = 0;
	const realHydrateAll = host.transitionLog.hydrateAll.bind(host.transitionLog);
	host.transitionLog.hydrateAll = () => {
		hydrateAllCalls++;
		return realHydrateAll();
	};

	const ringOnly = await host.transitionHistory("a1");
	expect(hydrateAllCalls).toBe(0); // default path never touches disk
	expect(ringOnly.map((e) => e.reason)).toEqual(["task-start", "connect-ok"]);

	const full = await host.transitionHistory("a1", { full: true });
	expect(hydrateAllCalls).toBe(1);
	expect(full.map((e) => e.reason)).toEqual(["task-start", "connect-ok"]); // same content, deduped against the ring
});

test("transitionHistory({full:true}) follows cause.priorId lineage across a cold-adopt id change", async () => {
	const stateDir = await freshStateDir();
	const mgr = new SquadManager({ stateDir });
	const host = mgr as unknown as LifecycleHost;

	const oldRec = seed(mgr, "old-1", "idle");
	host.transition(oldRec, "working", "task-start");
	host.transition(oldRec, "error", "fail", { error: "crashed" });

	const newRec = seed(mgr, "new-1", "starting");
	host.transition(newRec, "starting", "adopted", { priorId: "old-1" });
	host.transition(newRec, "idle", "connect-ok");

	await Bun.sleep(30);

	const full = await host.transitionHistory("new-1", { full: true });
	expect(full.map((e) => `${e.agentId}:${e.reason}`)).toEqual(["old-1:task-start", "old-1:fail", "new-1:adopted", "new-1:connect-ok"]);

	// The non-full (ring-only, no lineage) path stays scoped to the requested id only.
	const ringOnly = await host.transitionHistory("new-1");
	expect(ringOnly.map((e) => e.agentId)).toEqual(["new-1", "new-1"]);
});
