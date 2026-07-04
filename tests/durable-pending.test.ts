/**
 * Durable pending (#lifecycle-truth concern 04): `pending[]` becomes real durable state via a debounced
 * persist trigger inside setPending() (persistNow() alone never wrote it — nothing called persist() on a
 * pending mutation before this concern, so the naive "just widen the snapshot shape" version is a no-op).
 * This drives setPending()/stop() directly against a seeded fake agent (transition-history.test.ts's
 * pattern) and asserts: (1) the debounce eventually lands pending on disk, (2) a burst of mutations within
 * the window coalesces into exactly one persist() call, (3) a graceful stop() flushes synchronously.
 */

import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SquadManager } from "../src/squad-manager.ts";
import { SubagentTracker } from "../src/subagents.ts";
import type { AgentDriver } from "../src/agent-driver.ts";
import { FileStore, type AuditEntry, type StateSnapshot, type Store } from "../src/dal/store.ts";
import type { DerivedReason } from "../src/agent-lifecycle.ts";
import type { AgentDTO, AgentStatus, PendingRequest, PersistedAgent, RpcSessionState, RunReceipt } from "../src/types.ts";
import type { FeedbackSnapshot } from "../src/feedback.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function freshStateDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "durable-pending-"));
	tmps.push(dir);
	return dir;
}

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

/** The private durable-pending surface this test drives directly. */
interface DurablePendingHost {
	agents: Map<string, AgentRecordLike>;
	setPending: (rec: AgentRecordLike, next: PendingRequest[], reason: DerivedReason) => void;
	pendingPersistTimers: Map<string, unknown>;
	settling: Set<string>;
	persist: () => Promise<void>;
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
	(mgr as unknown as DurablePendingHost).agents.set(id, rec);
	return rec;
}

/** Spies on save() call count while delegating to a real FileStore, so the debounce coalescing test
 *  doesn't need to inspect disk state — just count how many times the writer actually ran. */
class SpySaveStore implements Store {
	saveCalls = 0;
	private readonly real: FileStore;
	constructor(stateDir: string) {
		this.real = new FileStore(stateDir);
	}
	hasState(): Promise<boolean> {
		return this.real.hasState();
	}
	load(): Promise<StateSnapshot> {
		return this.real.load();
	}
	async save(snapshot: StateSnapshot): Promise<void> {
		this.saveCalls++;
		await this.real.save(snapshot);
	}
	loadFeedback(): Promise<FeedbackSnapshot> {
		return this.real.loadFeedback();
	}
	saveFeedback(snapshot: FeedbackSnapshot): Promise<void> {
		return this.real.saveFeedback(snapshot);
	}
	appendAudit(entry: AuditEntry): Promise<void> {
		return this.real.appendAudit(entry);
	}
	appendUsage(receipt: RunReceipt): Promise<void> {
		return this.real.appendUsage(receipt);
	}
}

test("setPending's debounced trigger eventually writes pending to disk", async () => {
	const stateDir = await freshStateDir();
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	const host = mgr as unknown as DurablePendingHost;
	const rec = seed(mgr, "a1", "idle");

	const pending: PendingRequest = { id: "p1", source: "ui", kind: "confirm", title: "proceed?", message: "ok?", createdAt: Date.now() };
	host.setPending(rec, [pending], "pending-add");

	await Bun.sleep(1300); // past the ~1s debounce window

	// Kill and reconstruct against the same stateDir — a fresh reader, not the writer under test.
	const reader = new FileStore(stateDir);
	const snap = await reader.load();
	const persisted = snap.agents.find((a) => a.id === "a1");
	expect(persisted?.pending?.map((p) => p.id)).toEqual(["p1"]);
	expect(persisted?.pending?.[0]?.title).toBe("proceed?");
	expect(persisted?.pending?.[0]?.message).toBe("ok?");

	await mgr.stop();
});

test("two pending mutations inside the debounce window coalesce into exactly one persist() call", async () => {
	const stateDir = await freshStateDir();
	const store = new SpySaveStore(stateDir);
	const mgr = new SquadManager({ stateDir, store });
	await mgr.start();
	const host = mgr as unknown as DurablePendingHost;
	const rec = seed(mgr, "a1", "idle");

	const pending: PendingRequest = { id: "p1", source: "ui", kind: "confirm", title: "proceed?", createdAt: Date.now() };
	host.setPending(rec, [pending], "pending-add"); // pending-add
	host.setPending(rec, [], "pending-answer"); // answered immediately after, well within the 1s window

	expect(store.saveCalls).toBe(0); // nothing flushed yet — still inside the debounce window

	await Bun.sleep(1300);

	expect(store.saveCalls).toBe(1); // both mutations coalesced into a single debounced persist

	await mgr.stop();
});

test("stop() flushes an in-flight pending-persist debounce synchronously (no ≤1s loss on graceful shutdown)", async () => {
	const stateDir = await freshStateDir();
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	const host = mgr as unknown as DurablePendingHost;
	const rec = seed(mgr, "a1", "idle");

	const pending: PendingRequest = { id: "p1", source: "ui", kind: "confirm", title: "flush me", createdAt: Date.now() };
	host.setPending(rec, [pending], "pending-add");

	expect(host.pendingPersistTimers.size).toBe(1); // debounce timer armed

	// Stop immediately — well before the 1s debounce timer would naturally fire.
	await mgr.stop();

	expect(host.pendingPersistTimers.size).toBe(0); // flushed + cleared, not leaked

	const reader = new FileStore(stateDir);
	const snap = await reader.load();
	const persisted = snap.agents.find((a) => a.id === "a1");
	expect(persisted?.pending?.map((p) => p.id)).toEqual(["p1"]);
});

test("#lifecycle-truth finding 5: a replayed pending is never written to disk, even when a persist fires while its agent is mid-settle", async () => {
	const stateDir = await freshStateDir();
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	const host = mgr as unknown as DurablePendingHost;

	const ghostRec = seed(mgr, "ghost-agent", "input");
	const ghost: PendingRequest = { id: "g1", source: "ui", kind: "confirm", title: "replayed?", createdAt: Date.now(), replayed: true };
	ghostRec.dto.pending = [ghost];
	// Simulate the agent being mid-settle (a reattach in progress) — setPending's own settling-guard would
	// suppress scheduling a NEW debounce timer for THIS agent, but it does nothing about a persist()
	// triggered by unrelated activity (a different agent's own mutation, a capability install, stop()'s
	// flush, …) while this one is still settling.
	host.settling.add("ghost-agent");

	// A live pending on a DIFFERENT, non-settling agent — persisted normally, proving the filter is
	// scoped to replayed:true entries only, not a blanket pending suppression.
	const liveRec = seed(mgr, "live-agent", "input");
	const live: PendingRequest = { id: "l1", source: "ui", kind: "confirm", title: "real question", createdAt: Date.now() };
	liveRec.dto.pending = [live];

	await host.persist(); // an unrelated persist — NOT triggered by ghost-agent's own setPending

	const reader = new FileStore(stateDir);
	const snap = await reader.load();
	const ghostPersisted = snap.agents.find((a) => a.id === "ghost-agent");
	const livePersisted = snap.agents.find((a) => a.id === "live-agent");
	expect(ghostPersisted?.pending ?? []).toEqual([]); // the replayed ghost never reached disk
	expect(livePersisted?.pending?.map((p) => p.id)).toEqual(["l1"]); // a live pending on another agent is unaffected

	host.settling.delete("ghost-agent");
	await mgr.stop();
});
