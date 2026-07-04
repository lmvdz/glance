/**
 * Settle gate (replay-phantom-transition fix): the agent-host replays up to 4000 ring frames on
 * reconnect, synchronously re-emitting event/ui frames from inside `agent.start()` before it resolves.
 * Without suppression each replayed frame would pump a phantom transition into the (concern 02: persisted)
 * history on every daemon restart. This drives `attachExisting` against a scripted driver that replays a
 * large burst of frames — including one landing one macrotask after `start()` resolves, inside
 * `drainOneTick`'s window — and asserts zero transition-log entries are recorded during that window and
 * exactly one synthetic "reattach" entry lands once settling closes.
 */

import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { PersistedAgent, RpcSessionState } from "../src/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

const REPLAY_FRAME_COUNT = 60;

class ReplayDriver extends EventEmitter implements AgentDriver {
	ready = false;
	alive = false;

	get isReady(): boolean {
		return this.ready;
	}
	get isAlive(): boolean {
		return this.alive;
	}

	async start(): Promise<void> {
		// Models agent-host's synchronous ring replay: a burst of event frames plus a blocking UI
		// request, all emitted before start()'s promise resolves.
		for (let i = 0; i < REPLAY_FRAME_COUNT; i++) {
			this.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
		}
		this.emit("ui", { method: "confirm", id: "replay-confirm", title: "confirm?", message: "replayed?" });
		// A straggler frame scheduled one macrotask out — lands inside drainOneTick's window, not inside
		// this synchronous burst, exercising the reason drainOneTick exists instead of a bare microtask flush.
		setImmediate(() => this.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "straggler" } }));
		this.ready = true;
		this.alive = true;
	}
	async stop(): Promise<void> {
		this.alive = false;
		this.ready = false;
	}
	async prompt(): Promise<void> {}
	async abort(): Promise<unknown> {
		return undefined;
	}
	async getState(): Promise<RpcSessionState> {
		return {} as RpcSessionState;
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

interface DriverFactoryHost {
	makeDriver: (p: PersistedAgent) => AgentDriver;
}

interface TransitionLogEntry {
	from: string;
	to: string;
	reason: string;
	at: number;
	denied?: boolean;
}

interface AttachHost {
	attachExisting: (p: PersistedAgent, transcript?: unknown[]) => Promise<void>;
	transitionLog: { recent: () => TransitionLogEntry[] };
}

test("attachExisting suppresses replay-driven transitions and records exactly one reattach entry", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "settle-gate-state-"));
	tmps.push(stateDir);

	// ReplayDriver never emits concern 2's "replayComplete" marker — keep the timeout-fallback wait fast.
	const mgr = new SquadManager({ stateDir, replaySettleTimeoutMs: 20 });
	await mgr.start();
	const driver = new ReplayDriver();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => driver;

	const persisted: PersistedAgent = {
		id: "settle-gate-agent",
		name: "chat",
		repo: "(none)",
		worktree: "(none)",
		approvalMode: "yolo",
	};

	await (mgr as unknown as AttachHost).attachExisting(persisted, []);

	const log = (mgr as unknown as AttachHost).transitionLog.recent();
	const reattachEntries = log.filter((e) => e.reason === "reattach");
	const nonReattachEntries = log.filter((e) => e.reason !== "reattach");

	expect(nonReattachEntries).toEqual([]); // every replay-driven frame recorded nothing
	expect(reattachEntries.length).toBe(1); // exactly one synthetic entry once settling closed
	expect(reattachEntries[0]?.denied).toBeUndefined();
	expect(reattachEntries[0]?.to).toBe("input"); // derive() reflects the still-open replayed confirm — a successful reattach, not swallowed as a raw same-value write

	// The replayed blocking confirm is still tracked as a live, answerable pending request (replay is
	// truth — see DESIGN.md's warm-reattach decision) even though its transition was never recorded.
	expect(mgr.getAgent(persisted.id)?.pending.some((p) => p.id === "replay-confirm")).toBe(true);

	await mgr.stop();
});

/** A driver whose start() rejects — models a host that died between the hostAlive() probe and connect,
 *  or an RPC handshake failure (the TOCTOU class attachExisting's settle window must survive). */
class FailingStartDriver extends EventEmitter implements AgentDriver {
	ready = false;
	alive = false;

	get isReady(): boolean {
		return this.ready;
	}
	get isAlive(): boolean {
		return this.alive;
	}
	async start(): Promise<void> {
		throw new Error("handshake failed");
	}
	async stop(): Promise<void> {
		this.alive = false;
		this.ready = false;
	}
	async prompt(): Promise<void> {}
	async abort(): Promise<unknown> {
		return undefined;
	}
	async getState(): Promise<RpcSessionState> {
		return {} as RpcSessionState;
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

interface SettleGateHost extends AttachHost {
	settling: Set<string>;
	agents: Map<string, { dto: { pending: unknown[]; status: string; error?: string }; agent: AgentDriver }>;
	maybeAutoSupervise: (rec: unknown, req: { id: string; source: "ui" | "tool"; kind: string; title: string; createdAt: number }) => void;
}

test("attachExisting clears the settle gate even when start() rejects, so the ledger and auto-supervise resume", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "settle-gate-fail-state-"));
	tmps.push(stateDir);

	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	const driver = new FailingStartDriver();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => driver;

	const persisted: PersistedAgent = {
		id: "settle-gate-fail-agent",
		name: "chat",
		repo: "(none)",
		worktree: "(none)",
		approvalMode: "yolo",
	};

	await expect((mgr as unknown as AttachHost).attachExisting(persisted, [])).rejects.toThrow("handshake failed");

	const host = mgr as unknown as SettleGateHost;
	// The settle window must close on the failure path too — otherwise this id stays in `settling`
	// forever, permanently disabling maybeAutoSupervise and silencing transition()'s ledger for it.
	expect(host.settling.has(persisted.id)).toBe(false);

	const log = host.transitionLog.recent();
	const reattachEntries = log.filter((e) => e.reason === "reattach");
	expect(reattachEntries.length).toBe(1); // the ledger still recorded the reattach

	// #lifecycle-truth finding 1: a failed reattach must land as "error", not a healthy-looking "idle" —
	// pre-fix, the `finally` block derived a non-terminal status (pending=[], streaming=false ⇒ "idle")
	// and the thrown rejection was swallowed by every caller's `.catch(log)`, so a dead-driver agent
	// looked exactly like a real idle one on the dashboard.
	expect(reattachEntries[0]?.to).toBe("error");
	expect(reattachEntries[0]?.cause?.error).toContain("handshake failed");

	const rec = host.agents.get(persisted.id);
	expect(rec).toBeDefined();
	expect(rec?.dto.status).toBe("error");
	expect(rec?.dto.error).toContain("handshake failed");

	// With the gate cleared, a freshly-added pending request must be eligible for auto-supervise again
	// (pre-fix, `settling.has` alone gated it and this id would be stuck suppressed forever).
	host.maybeAutoSupervise(rec, { id: "post-failure-confirm", source: "ui", kind: "confirm", title: "confirm?", createdAt: Date.now() });
	expect(mgr.getTranscript(persisted.id).some((t) => JSON.stringify(t).includes("post-failure-confirm"))).toBe(true);

	await mgr.stop();
});

/** Models a ring replay that spans several socket ticks (unlike ReplayDriver's single synchronous
 *  burst) — a handful of frames land on separate macrotasks AFTER start() has already resolved, then the
 *  concern-2 "replayComplete" marker fires last, exactly mirroring agent-host.ts's real ordering (the
 *  marker is written to the socket only after every ring line, so a client processes it strictly after
 *  everything that preceded it, however many reads the delivery spanned). This is the multi-tick case a
 *  bare `drainOneTick` heuristic cannot handle correctly — the settle gate must stay open across every
 *  chunk until the marker (or the timeout fallback) arrives. */
class ChunkedReplayDriver extends EventEmitter implements AgentDriver {
	ready = false;
	alive = false;
	get isReady(): boolean {
		return this.ready;
	}
	get isAlive(): boolean {
		return this.alive;
	}
	async start(): Promise<void> {
		this.ready = true;
		this.alive = true;
		// Fire-and-forget: start() resolves immediately (mirrors RpcAgent.waitReady() resolving on the
		// FIRST "ready" frame, well before later ring-replay chunks — and the trailing marker — have been
		// fully delivered), while the chunked replay keeps landing on later ticks.
		void (async () => {
			for (let i = 0; i < 4; i++) {
				await new Promise((r) => setTimeout(r, 5));
				this.emit("ui", { method: "confirm", id: `chunk-confirm-${i}`, title: `confirm ${i}?`, message: "replayed?" });
			}
			this.emit("replayComplete");
		})();
	}
	async stop(): Promise<void> {
		this.alive = false;
		this.ready = false;
	}
	async prompt(): Promise<void> {}
	async abort(): Promise<unknown> {
		return undefined;
	}
	async getState(): Promise<RpcSessionState> {
		return {} as RpcSessionState;
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

test("attachExisting's settle gate stays open across a multi-tick chunked replay, closing on the replayComplete marker (not a fixed tick)", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "settle-gate-chunked-state-"));
	tmps.push(stateDir);

	// A generous timeout ceiling — the assertion below on wall-clock elapsed proves the marker (fired
	// after ~20ms of chunks), not this fallback, is what actually closed the gate.
	const mgr = new SquadManager({ stateDir, replaySettleTimeoutMs: 5000 });
	await mgr.start();
	const driver = new ChunkedReplayDriver();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => driver;

	const persisted: PersistedAgent = {
		id: "settle-gate-chunked-agent",
		name: "chat",
		repo: "(none)",
		worktree: "(none)",
		approvalMode: "yolo",
	};

	const startedAt = Date.now();
	await (mgr as unknown as AttachHost).attachExisting(persisted, []);
	const elapsedMs = Date.now() - startedAt;

	// Settled on the marker, not the 5s fallback timeout.
	expect(elapsedMs).toBeLessThan(1000);

	const log = (mgr as unknown as AttachHost).transitionLog.recent();
	const reattachEntries = log.filter((e) => e.reason === "reattach");
	const nonReattachEntries = log.filter((e) => e.reason !== "reattach");
	expect(nonReattachEntries).toEqual([]); // every chunk, across every tick, recorded nothing
	expect(reattachEntries.length).toBe(1); // exactly one synthetic entry once the marker closed settling

	// All four chunked pendings — delivered across separate ticks, some after start() had already
	// resolved — were captured and tagged replayed:true, proving the gate stayed open for all of them.
	const pending = mgr.getAgent(persisted.id)?.pending ?? [];
	expect(pending.length).toBe(4);
	expect(pending.every((p) => p.replayed)).toBe(true);

	await mgr.stop();
});
