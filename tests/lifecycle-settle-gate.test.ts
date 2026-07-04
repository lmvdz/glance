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
	transitionLog: TransitionLogEntry[];
}

test("attachExisting suppresses replay-driven transitions and records exactly one reattach entry", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "settle-gate-state-"));
	tmps.push(stateDir);

	const mgr = new SquadManager({ stateDir });
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

	const log = (mgr as unknown as AttachHost).transitionLog;
	const reattachEntries = log.filter((e) => e.reason === "reattach");
	const nonReattachEntries = log.filter((e) => e.reason !== "reattach");

	expect(nonReattachEntries).toEqual([]); // every replay-driven frame recorded nothing
	expect(reattachEntries.length).toBe(1); // exactly one synthetic entry once settling closed
	expect(reattachEntries[0]?.denied).toBeUndefined();

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
	agents: Map<string, { dto: { pending: unknown[] }; agent: AgentDriver }>;
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

	const log = host.transitionLog;
	expect(log.filter((e) => e.reason === "reattach").length).toBe(1); // the ledger still recorded the reattach

	// With the gate cleared, a freshly-added pending request must be eligible for auto-supervise again
	// (pre-fix, `settling.has` alone gated it and this id would be stuck suppressed forever).
	const rec = host.agents.get(persisted.id);
	expect(rec).toBeDefined();
	host.maybeAutoSupervise(rec, { id: "post-failure-confirm", source: "ui", kind: "confirm", title: "confirm?", createdAt: Date.now() });
	expect(mgr.getTranscript(persisted.id).some((t) => JSON.stringify(t).includes("post-failure-confirm"))).toBe(true);

	await mgr.stop();
});
