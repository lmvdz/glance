/**
 * Concern 01 (inspectable-topology): persist() chain-dedup. A burst of N concurrent persist()-triggering
 * calls must produce at most 2 store.save() invocations (the in-flight write, plus one queued write that
 * starts after it) — never one store.save() per caller (the pre-fix always-chain behavior) — while every
 * caller's awaited promise still resolves only once a write that snapshots state AFTER their call has
 * completed (persistNow() reads live agent state at write time, not at enqueue time).
 */

import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { emptyFeedbackSnapshot } from "../src/feedback.ts";
import type { AuditEntry, Store, StateSnapshot } from "../src/dal/store.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SubagentTracker } from "../src/subagents.ts";
import type { AgentDTO, FeedbackSnapshot, PersistedAgent, RpcSessionState, RunReceipt } from "../src/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

/** Counts save() invocations and snapshots each call's argument; an artificial delay keeps a write
 *  "in flight" long enough for concurrent persist() calls fired in the same tick to actually race it. */
class CountingStore implements Store {
	calls: StateSnapshot[] = [];
	constructor(private readonly delayMs = 30) {}
	async hasState(): Promise<boolean> {
		return false;
	}
	async load(): Promise<StateSnapshot> {
		return { agents: [], transcripts: {}, features: [] };
	}
	async save(snapshot: StateSnapshot): Promise<void> {
		this.calls.push(snapshot);
		await new Promise((r) => setTimeout(r, this.delayMs));
	}
	async loadFeedback(): Promise<FeedbackSnapshot> {
		return emptyFeedbackSnapshot();
	}
	async saveFeedback(): Promise<void> {}
	async appendAudit(_entry: AuditEntry): Promise<void> {}
	async appendUsage(_receipt: RunReceipt): Promise<void> {}
}

class NoopDriver extends EventEmitter implements AgentDriver {
	readonly isReady = true;
	readonly isAlive = true;
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async prompt(): Promise<void> {}
	async abort(): Promise<unknown> {
		return undefined;
	}
	async getState(): Promise<RpcSessionState> {
		return { todoPhases: [], isStreaming: false } as RpcSessionState;
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

interface FakeAgentRecord {
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

interface PersistHost {
	agents: Map<string, FakeAgentRecord>;
	persist(): Promise<void>;
}

function stubAgent(id: string): FakeAgentRecord {
	const dto: AgentDTO = { id, name: id, status: "idle", repo: "(none)", worktree: "(none)", approvalMode: "yolo", pending: [], lastActivity: Date.now(), messageCount: 0, kind: "omp-operator" };
	const options: PersistedAgent = { id, name: id, repo: "(none)", worktree: "(none)", approvalMode: "yolo" };
	return { dto, agent: new NoopDriver(), options, transcript: [], assistantBuf: "", thinkingBuf: "", streaming: false, subs: new SubagentTracker(), toolEntries: new Map() };
}

async function makeMgr(store: CountingStore): Promise<PersistHost> {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "persist-dedup-"));
	tmps.push(stateDir);
	const mgr = new SquadManager({ stateDir, store, skipGlobalJanitors: true });
	return mgr as unknown as PersistHost;
}

test("N concurrent persist() calls collapse to at most 2 store.save() invocations", async () => {
	const store = new CountingStore();
	const host = await makeMgr(store);

	const N = 6;
	await Promise.all(Array.from({ length: N }, () => host.persist()));

	expect(store.calls.length).toBeLessThanOrEqual(2);
	expect(store.calls.length).toBeGreaterThanOrEqual(1);
});

test("a caller joining a queued write resolves to a snapshot containing state added after the in-flight write started", async () => {
	const store = new CountingStore();
	const host = await makeMgr(store);

	const first = host.persist(); // writeInFlight becomes true; its snapshot is captured NOW (empty roster)
	host.agents.set("late-agent", stubAgent("late-agent")); // mutate roster while the first write is in flight
	const second = host.persist(); // must queue behind `first`, not start a third store.save()

	await Promise.all([first, second]);

	expect(store.calls.length).toBe(2);
	expect(store.calls[0]?.agents.some((a) => a.id === "late-agent")).toBe(false); // captured before the mutation
	expect(store.calls[1]?.agents.some((a) => a.id === "late-agent")).toBe(true); // the queued write durably contains it
});

test("a third caller while a write is already queued joins that same queued write (still only 2 saves)", async () => {
	const store = new CountingStore();
	const host = await makeMgr(store);

	const first = host.persist();
	const second = host.persist(); // queues
	const third = host.persist(); // must join `second`'s queued promise, not queue a third write

	await Promise.all([first, second, third]);

	expect(store.calls.length).toBe(2);
});
