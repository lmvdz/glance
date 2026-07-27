/**
 * Concern 02 — VoiceCallCoordinator: thread-aware start with pinned identity, journal-driven decision
 * projection end-to-end, distinct honest states for socket loss / broker exit / port reuse, and
 * resolution authorization (allowed / denied / bridge outage / arbiter rejection).
 *
 * Uses a real Bun.serve WebSocket server as the fake bridge (same wire protocol as
 * `tests/voice-call-bridge-client.test.ts`) and an in-memory `BrokerClient` fake — no real oh-my-pi,
 * no real broker process, but a genuine socket and a genuine journal file on disk.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BridgeConnectFn, BridgeSocketLike } from "../src/voice-call-bridge-client.ts";
import type { VoiceCallRetention } from "../src/voice-call-binding.ts";
import type { EmitCardInput, BrokerCallCreated, BrokerCallView, BrokerClient } from "../src/voice-call-manager.ts";
import { httpBrokerClient, resolveEffectiveSessionRoot, VoiceCallCoordinator } from "../src/voice-call-manager.ts";

function tmpDir(prefix: string): string {
	return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function startFakeBridge(sessionId: string, port = 0, recordingMode?: "full" | "tails" | "off") {
	const sockets = new Set<{ send(data: string): void }>();
	let decisions = new Map<string, { label: string }>();
	const server = Bun.serve({
		port,
		hostname: "127.0.0.1",
		fetch(req, srv) {
			if (srv.upgrade(req)) return undefined;
			return new Response("ws only", { status: 426 });
		},
		websocket: {
			open(ws) {
				sockets.add(ws as unknown as { send(data: string): void });
				ws.send(JSON.stringify({ v: 1, sessionId, seq: 0, type: "hello", canResolve: true, ...(recordingMode ? { recordingMode } : {}) }));
			},
			message(ws, message) {
				const frame = JSON.parse(typeof message === "string" ? message : message.toString()) as Record<string, unknown>;
				if (frame.type !== "control" || typeof frame.requestId !== "string") return;
				const requestId = frame.requestId;
				if (frame.action === "resolveDecision") {
					const decision = decisions.get(frame.decisionId as string);
					if (!decision || decision.label !== frame.label) {
						ws.send(JSON.stringify({ v: 1, sessionId, seq: 2, type: "controlAck", requestId, ok: false, reason: decision ? "label-mismatch" : "not-found" }));
						return;
					}
					ws.send(JSON.stringify({ v: 1, sessionId, seq: 2, type: "controlAck", requestId, ok: true, decision: { id: frame.decisionId, state: "answered" } }));
				}
			},
			close(ws) {
				sockets.delete(ws as unknown as { send(data: string): void });
			},
		},
	});
	return {
		port: server.port,
		url: `ws://127.0.0.1:${server.port}`,
		setDecision: (id: string, label: string) => decisions.set(id, { label }),
		closeAll: () => { for (const ws of sockets) (ws as unknown as { close?: () => void }).close?.(); },
		stop: () => server.stop(true),
	};
}

class FakeBroker implements BrokerClient {
	readonly calls = new Map<string, BrokerCallView & { controlToken: string }>();
	private seq = 0;

	registerLiveCall(view: BrokerCallCreated): void {
		this.calls.set(view.callId, { ...view, exit: null });
	}

	async createCall(): Promise<BrokerCallCreated> {
		throw new Error("createCall must be stubbed per test via registerLiveCall + manual attach");
	}
	async endCall(callId: string): Promise<void> {
		const call = this.calls.get(callId);
		if (call) call.exit = 0;
	}
	async listCalls(): Promise<BrokerCallView[]> {
		return [...this.calls.values()];
	}
	nextId(): string {
		return `call-${++this.seq}`;
	}
}

/** A broker whose `createCall` actually spins up a fake bridge + journal file, matching the real
 *  broker's own `POST /calls` contract closely enough for the coordinator's start path. Records
 *  every `createCall` call's own `opts` (CRITICAL 3: asserting `retention` actually reaches the
 *  broker) and can be told to answer with its own `sessionRoot`, like a real broker's `PROJECT_DIR`. */
class ScriptedBroker extends FakeBroker {
	readonly createCallOpts: Array<{ resume?: string; retention?: VoiceCallRetention }> = [];
	sessionRoot: string | undefined;
	constructor(private readonly journalDir: string, private readonly bridge: ReturnType<typeof startFakeBridge>, private readonly controlToken = "tok-1") {
		super();
	}
	override async createCall(opts?: { resume?: string; retention?: VoiceCallRetention }): Promise<BrokerCallCreated> {
		this.createCallOpts.push(opts ?? {});
		const callId = this.nextId();
		const journalPath = path.join(this.journalDir, `${callId}.jsonl`);
		writeFileSync(journalPath, "");
		const view: BrokerCallCreated = { callId, port: this.bridge.port, bridgeUrl: this.bridge.url, journalPath, startedAt: Date.now(), exit: null, controlToken: this.controlToken, ...(this.sessionRoot ? { sessionRoot: this.sessionRoot } : {}) };
		this.registerLiveCall(view);
		return view;
	}
}

function journalLine(seq: number, sessionId: string, record: unknown): string {
	return `${JSON.stringify({ seq, at: Date.now(), sessionId, record })}\n`;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
});

/** Polls `predicate` instead of a fixed sleep — the coordinator's own polling intervals are real
 *  timers, and a fixed-duration wait is exactly the kind of flaky test this avoids under load. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000, stepMs = 15): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, stepMs));
	}
	if (!predicate()) throw new Error("waitFor: condition never became true within timeout");
}

function makeCoordinator(opts: { stateDir: string; broker: BrokerClient; cards: EmitCardInput[]; livenessProbeIntervalMs?: number; journalPollIntervalMs?: number; connectBridge?: BridgeConnectFn }): VoiceCallCoordinator {
	const coordinator = new VoiceCallCoordinator({
		stateDir: opts.stateDir,
		broker: opts.broker,
		connectBridge: opts.connectBridge,
		emitCard: async (input) => { opts.cards.push(input); },
		journalPollIntervalMs: opts.journalPollIntervalMs ?? 30,
		livenessProbeIntervalMs: opts.livenessProbeIntervalMs ?? 60,
	});
	// Registered here (not just the explicit `coordinator.stop()` calls each test makes on its own
	// happy path) so a failed assertion mid-test still tears down every real timer/socket this
	// coordinator owns — `stop()` is idempotent, so this is a harmless no-op on the tests' own calls.
	cleanups.push(() => coordinator.stop());
	return coordinator;
}

describe("startCall: thread-aware start with pinned identity", () => {
	test("persists connecting → live and announces both states as voice-call cards", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-abc");
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards });

		const result = await coordinator.startCall("room-1", { ownerActorId: "operator" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.state).toBe("live");
			expect(result.value.sessionId).toBe("live-abc");
			expect((result.value as Record<string, unknown>).controlToken).toBeUndefined();
		}
		expect(cards.map((c) => c.kind)).toEqual(["voice-call", "voice-call"]);
		expect((cards[1]!.payload as { face: { state: string } }).face.state).toBe("live");
		coordinator.stop();
	});

	test("refuses a second start on the same channel while one is active", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-abc");
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards });
		await coordinator.startCall("room-1", { ownerActorId: "operator" });
		const second = await coordinator.startCall("room-1", { ownerActorId: "operator" });
		expect(second.ok).toBe(false);
		coordinator.stop();
	});

	test("bridge-connect failure tears down the tailer startCall already started (CRITICAL 2 known leak path)", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		class NoAnswerBroker extends FakeBroker {
			override async createCall(): Promise<BrokerCallCreated> {
				const callId = this.nextId();
				const journalPath = path.join(journalDir, `${callId}.jsonl`);
				writeFileSync(journalPath, "");
				const view: BrokerCallCreated = { callId, port: 1, bridgeUrl: "ws://127.0.0.1:1", journalPath, startedAt: Date.now(), exit: null, controlToken: "tok-1" };
				this.registerLiveCall(view);
				return view;
			}
		}
		const broker = new NoAnswerBroker();
		const cards: EmitCardInput[] = [];
		// A `connectBridge` whose socket fires `onerror` right after the client attaches its handlers —
		// the broker answered (a real process/port), but the bridge itself never comes up. Fast and
		// deterministic, unlike waiting out the real 10s hello timeout.
		const connectBridge = (): BridgeSocketLike => {
			const socket = { send() {}, close() {}, onopen: null as (() => void) | null, onmessage: null as ((ev: { data: string }) => void) | null, onclose: null as (() => void) | null, onerror: null as ((ev: unknown) => void) | null };
			queueMicrotask(() => socket.onerror?.(new Error("connection refused")));
			return socket as unknown as BridgeSocketLike;
		};
		const coordinator = makeCoordinator({ stateDir, broker, cards, journalPollIntervalMs: 20, connectBridge });
		const result = await coordinator.startCall("room-1", { ownerActorId: "operator" });
		expect(result.ok).toBe(false);
		expect(coordinator.state("room-1")!.state).toBe("ended");
		expect(coordinator.state("room-1")!.terminalReason).toBe("start-failed");
		expect(coordinator.hasActiveRuntime("room-1")).toBe(false);
	});
});

describe("journal-driven decision projection end-to-end", () => {
	test("a decision minted in the journal projects into decisions() and mints a voice-decision card", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-abc");
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards });
		const started = await coordinator.startCall("room-1", { ownerActorId: "operator" });
		expect(started.ok).toBe(true);
		const binding = coordinator.state("room-1")!;
		const journalPath = path.join(journalDir, `${binding.callId}.jsonl`);

		appendFileSync(journalPath, journalLine(0, "live-abc", { type: "decision", decision: { id: "d1", prompt: "Which name?", options: [{ index: 0, label: "Keep it", consequence: "no-op" }], requiresConfirmation: false, state: "open", createdAt: 1, updatedAt: 1 } }));
		await waitFor(() => coordinator.decisions("room-1").length > 0);

		expect(coordinator.decisions("room-1").map((d) => d.id)).toEqual(["d1"]);
		expect(cards.some((c) => c.kind === "voice-decision")).toBe(true);
		coordinator.stop();
	});

	test("a terminal journal record ends the binding with terminalReason 'terminal'", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-abc");
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards });
		await coordinator.startCall("room-1", { ownerActorId: "operator" });
		const binding = coordinator.state("room-1")!;
		const journalPath = path.join(journalDir, `${binding.callId}.jsonl`);
		appendFileSync(journalPath, journalLine(0, "live-abc", { type: "terminal", error: "provider disconnected" }));
		await waitFor(() => coordinator.state("room-1")!.state === "ended");
		const ended = coordinator.state("room-1")!;
		expect(ended.state).toBe("ended");
		expect(ended.terminalReason).toBe("terminal");
		expect(ended.terminalError).toBe("provider disconnected");
		expect(coordinator.hasActiveRuntime("room-1")).toBe(false);
		coordinator.stop();
	});
});

describe("artifact journal records snapshot into ArtifactSnapshotStore", () => {
	test("a ready artifact record is snapshotted using the binding's session root", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		const sessionRoot = tmpDir("voice-mgr-session-");
		writeFileSync(path.join(sessionRoot, "report.md"), "# findings");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); rmSync(sessionRoot, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-abc");
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards });
		await coordinator.startCall("room-1", { ownerActorId: "operator", sessionRoot });
		const binding = coordinator.state("room-1")!;
		const journalPath = path.join(journalDir, `${binding.callId}.jsonl`);
		appendFileSync(journalPath, journalLine(0, "live-abc", { type: "artifact", artifact: { path: "report.md", status: "ready" } }));
		await waitFor(() => coordinator.listArtifacts("room-1").length > 0);
		const artifact = coordinator.listArtifacts("room-1")[0]!;
		expect(artifact.status).toBe("ready");
		expect(artifact.contentHash).toBeTruthy();
		coordinator.stop();
	});
});

describe("distinct honest states", () => {
	test("socket loss → degraded, then broker corroborates exit → ended broker-exit", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-abc");
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards, livenessProbeIntervalMs: 40 });
		await coordinator.startCall("room-1", { ownerActorId: "operator" });
		// Kill the bridge PROCESS entirely (not just one socket) — a reconnect attempt must fail, or
		// the liveness probe would happily reconnect the still-live fake server and never observe the
		// broker-corroborated exit this test is asserting. This mirrors reality: the bridge lives
		// inside the OMP process, so a dead process means no bridge to reconnect to, ever.
		bridge.stop();
		await waitFor(() => coordinator.state("room-1")!.state === "degraded");

		const binding = coordinator.state("room-1")!;
		await broker.endCall(binding.callId!); // broker now reports exit !== null
		await waitFor(() => coordinator.state("room-1")!.state === "ended");
		const ended = coordinator.state("room-1")!;
		expect(ended.state).toBe("ended");
		expect(ended.terminalReason).toBe("broker-exit");
		// The known leak this path used to have (CRITICAL 2): `probeLiveness`'s broker-exit branch
		// stopped the liveness probe but never the tailer, which kept polling the journal forever.
		expect(coordinator.hasActiveRuntime("room-1")).toBe(false);
		coordinator.stop();
	});

	test("port reuse: a reconnect that answers with a DIFFERENT session id is refused, never adopted", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const bridgeA = startFakeBridge("session-A");
		const broker = new ScriptedBroker(journalDir, bridgeA);
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards, livenessProbeIntervalMs: 40 });
		await coordinator.startCall("room-1", { ownerActorId: "operator" });
		expect(coordinator.state("room-1")!.sessionId).toBe("session-A");
		const port = bridgeA.port;
		bridgeA.stop();
		await waitFor(() => coordinator.state("room-1")!.state === "degraded");

		// A DIFFERENT session now answers on the SAME port (bound explicitly to the port bridgeA just
		// released) — the honest "port reuse" scenario this test exists to prove the daemon refuses.
		let bridgeB: ReturnType<typeof startFakeBridge> | undefined;
		for (let attempt = 0; attempt < 10 && !bridgeB; attempt++) {
			try {
				bridgeB = startFakeBridge("session-B", port);
			} catch {
				await new Promise((r) => setTimeout(r, 30));
			}
		}
		expect(bridgeB).toBeTruthy();
		cleanups.push(() => bridgeB?.stop());

		await waitFor(() => coordinator.state("room-1")!.state === "ended");
		const ended = coordinator.state("room-1")!;
		expect(ended.terminalReason).toBe("port-reused");
		expect(ended.sessionId).toBe("session-A"); // the OLD pinned identity, never overwritten
		// The known leak this path used to have (CRITICAL 2): `connectAndPin`'s port-reused rejection
		// never stopped the tailer that `startCall` had already started for this channel.
		expect(coordinator.hasActiveRuntime("room-1")).toBe(false);
		coordinator.stop();
	});

	test("journal-end: the journal file vanishing once live ends the binding, distinct from a terminal record", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-abc");
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards, journalPollIntervalMs: 20 });
		await coordinator.startCall("room-1", { ownerActorId: "operator" });
		const binding = coordinator.state("room-1")!;
		expect(binding.state).toBe("live");
		const journalPath = path.join(journalDir, `${binding.callId}.jsonl`);
		rmSync(journalPath); // the process's own call directory disappeared, no terminal record ever came
		await waitFor(() => coordinator.state("room-1")!.state === "ended");
		const ended = coordinator.state("room-1")!;
		expect(ended.terminalReason).toBe("journal-end");
		expect(coordinator.hasActiveRuntime("room-1")).toBe(false);
		coordinator.stop();
	});

	test("onJournalMissing tears down a leaked tailer even when the binding was already marked ended by another path", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-abc");
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards, journalPollIntervalMs: 15 });
		await coordinator.startCall("room-1", { ownerActorId: "operator" });
		const binding = coordinator.state("room-1")!;
		const journalPath = path.join(journalDir, `${binding.callId}.jsonl`);
		expect(coordinator.hasActiveRuntime("room-1")).toBe(true); // the tailer is running

		// Mark the BINDING ended directly, bypassing `endBinding`/`teardownRuntime` entirely — simulating
		// some path that decided the call is over without going through the ONE method that owns full
		// runtime cleanup. The tailer this channel started is still alive and still polling, by
		// construction: this is the exact leaked-tailer shape the old `onJournalMissing` early return
		// could never clean up (it bailed the instant `binding.state === "ended"`, before ever touching
		// the runtime).
		coordinator.bindings.markEnded("room-1", "operator-ended");
		expect(coordinator.hasActiveRuntime("room-1")).toBe(true); // still leaked, by construction

		// The journal file now disappears — `onJournalMissing` must tear the tailer down even though the
		// binding already reads "ended".
		rmSync(journalPath);
		await waitFor(() => !coordinator.hasActiveRuntime("room-1"));
		coordinator.stop();
	});

	test("a missing journal file during the brief connecting window is normal — never journal-end", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		// A broker that answers but never actually creates the journal file (simulating the real
		// window between the broker's response and OMP's own first journal write).
		const bridge = startFakeBridge("live-abc");
		cleanups.push(bridge.stop);
		class NoJournalFileBroker extends ScriptedBroker {
			override async createCall() {
				const view = await super.createCall();
				rmSync(view.journalPath); // undo the eager empty-file write — nothing exists yet
				return view;
			}
		}
		const broker = new NoJournalFileBroker(journalDir, bridge);
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards, journalPollIntervalMs: 20 });
		await coordinator.startCall("room-1", { ownerActorId: "operator" });
		await new Promise((r) => setTimeout(r, 100)); // several missing polls tick by
		expect(coordinator.state("room-1")!.state).toBe("live"); // never demoted to ended
		coordinator.stop();
	});

	test("stale binding: rehydrateOnBoot ends a live-looking binding the broker has never heard of", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const broker = new FakeBroker(); // knows nothing about any call
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards });
		// Simulate a prior process's binding, persisted as "live" with no surviving runtime state.
		coordinator.bindings.beginConnecting("room-1", { ownerActorId: "operator", sessionRoot: "/tmp", retention: "full" });
		coordinator.bindings.attachBroker("room-1", { callId: "call-ghost", port: 1, bridgeUrl: "ws://127.0.0.1:1", journalPath: path.join(journalDir, "ghost.jsonl"), controlToken: "t" });
		coordinator.bindings.pinSession("room-1", "session-ghost");

		await coordinator.rehydrateOnBoot();
		const ended = coordinator.state("room-1")!;
		expect(ended.state).toBe("ended");
		expect(ended.terminalReason).toBe("stale-binding");
		coordinator.stop();
	});

	test("rehydrateOnBoot: broker says the process is still alive — resumes tailing, starts honestly degraded, then reconnects to live", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		// The SAME session identity the prior process's binding pinned — the bridge that survives the
		// daemon restart is the OMP process itself, which never went away; only the daemon did.
		const bridge = startFakeBridge("live-abc");
		cleanups.push(bridge.stop);
		const journalPath = path.join(journalDir, "call-ghost.jsonl");
		writeFileSync(journalPath, "");
		const view: BrokerCallCreated = { callId: "call-ghost", port: bridge.port, bridgeUrl: bridge.url, journalPath, startedAt: Date.now(), exit: null, controlToken: "tok-1" };
		const broker = new FakeBroker();
		broker.registerLiveCall(view);
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards, livenessProbeIntervalMs: 30, journalPollIntervalMs: 20 });
		// Simulate a prior process's binding, persisted as "live" with no surviving runtime state.
		coordinator.bindings.beginConnecting("room-1", { ownerActorId: "operator", sessionRoot: "/tmp", retention: "full" });
		coordinator.bindings.attachBroker("room-1", view);
		coordinator.bindings.pinSession("room-1", "live-abc");

		await coordinator.rehydrateOnBoot();
		// Immediately after rehydrate: honest — the broker corroborates the PROCESS, but there is no
		// live socket yet, so this must never claim "live" before actually reconnecting.
		expect(coordinator.state("room-1")!.state).toBe("degraded");
		expect(coordinator.state("room-1")!.terminalReason).toBeUndefined();

		// The liveness probe's very first (immediate, un-awaited) tick reconnects the bridge against the
		// SAME pinned session — proving rehydrate wired up BOTH the liveness probe and the pinned-session
		// check, not just one of them.
		await waitFor(() => coordinator.state("room-1")!.state === "live");

		// And the resumed tailer is genuinely live, not a decoration — a NEW journal record projects.
		appendFileSync(journalPath, journalLine(0, "live-abc", { type: "decision", decision: { id: "d1", prompt: "Which name?", options: [{ index: 0, label: "Keep it", consequence: "no-op" }], requiresConfirmation: false, state: "open", createdAt: 1, updatedAt: 1 } }));
		await waitFor(() => coordinator.decisions("room-1").length > 0);
		coordinator.stop();
	});
});

describe("resolveDecision authorization", () => {
	async function liveCoordinatorWithDecision(): Promise<{ coordinator: VoiceCallCoordinator; teardown: () => void }> {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		const bridge = startFakeBridge("live-abc");
		bridge.setDecision("d1", "Keep it");
		const broker = new ScriptedBroker(journalDir, bridge);
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards });
		await coordinator.startCall("room-1", { ownerActorId: "operator" });
		return {
			coordinator,
			teardown: () => {
				coordinator.stop();
				bridge.stop();
				rmSync(stateDir, { recursive: true, force: true });
				rmSync(journalDir, { recursive: true, force: true });
			},
		};
	}

	test("allowed member with a real option label: relayed and ok", async () => {
		const { coordinator, teardown } = await liveCoordinatorWithDecision();
		const result = await coordinator.resolveDecision("room-1", true, { decisionId: "d1", optionIndex: 0, label: "Keep it" });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.ok).toBe(true);
		teardown();
	});

	test("denied member: refused before any bridge frame is sent", async () => {
		const { coordinator, teardown } = await liveCoordinatorWithDecision();
		const result = await coordinator.resolveDecision("room-1", false, { decisionId: "d1", optionIndex: 0, label: "Keep it" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("forbidden");
		teardown();
	});

	test("arbiter rejection: a mismatched label is relayed and rejected by the fake arbiter", async () => {
		const { coordinator, teardown } = await liveCoordinatorWithDecision();
		const result = await coordinator.resolveDecision("room-1", true, { decisionId: "d1", optionIndex: 0, label: "A label the agent never showed" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.ok).toBe(false);
			expect(result.value.reason).toBe("label-mismatch");
		}
		teardown();
	});

	test("bridge outage: a degraded binding refuses the relay with a distinct honest reason", async () => {
		const { coordinator, teardown } = await liveCoordinatorWithDecision();
		// Force degraded without a broker-corroborated exit — simulate the window between socket
		// loss and the liveness probe's next tick.
		coordinator.bindings.markDegraded("room-1");
		const result = await coordinator.resolveDecision("room-1", true, { decisionId: "d1", optionIndex: 0, label: "Keep it" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("bridge-unavailable");
		teardown();
	});
});

describe("endCall", () => {
	test("operator end marks the binding ended with the honest operator-ended reason", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-abc");
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards });
		await coordinator.startCall("room-1", { ownerActorId: "operator" });
		const result = await coordinator.endCall("room-1", true);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.state).toBe("ended");
			expect(result.value.terminalReason).toBe("operator-ended");
		}
		expect(coordinator.hasActiveRuntime("room-1")).toBe(false);
		coordinator.stop();
	});

	test("a channel can host a SECOND call after the first one ends — start → live → endCall → start again → live (CRITICAL 1 repro)", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const bridge1 = startFakeBridge("live-1");
		cleanups.push(bridge1.stop);
		const broker = new ScriptedBroker(journalDir, bridge1);
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards });

		const first = await coordinator.startCall("room-1", { ownerActorId: "operator" });
		expect(first.ok).toBe(true);
		expect(coordinator.state("room-1")!.state).toBe("live");

		const ended = await coordinator.endCall("room-1", true);
		expect(ended.ok).toBe(true);
		expect(coordinator.state("room-1")!.state).toBe("ended");
		expect(coordinator.hasActiveRuntime("room-1")).toBe(false);

		// A SECOND call on the SAME channel, against a fresh bridge connection. Before the fix,
		// `runtime()` reused the first call's `ChannelRuntime` object — still `ended: true` from the
		// teardown above — so `connectAndPin`'s stale-guard would close this brand-new bridge the
		// instant its `hello` arrived, and the binding would stick at "connecting" forever even though
		// `startCall` itself returns `ok: true`.
		const second = await coordinator.startCall("room-1", { ownerActorId: "operator" });
		expect(second.ok).toBe(true);
		await waitFor(() => coordinator.state("room-1")!.state === "live");
		expect(coordinator.state("room-1")!.state).toBe("live"); // not stuck at "connecting"
		coordinator.stop();
	});

	test("ending the call expires any still-open decision — no answerable-looking prompt survives a dead call", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-abc");
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards });
		await coordinator.startCall("room-1", { ownerActorId: "operator" });
		const binding = coordinator.state("room-1")!;
		const journalPath = path.join(journalDir, `${binding.callId}.jsonl`);
		appendFileSync(journalPath, journalLine(0, "live-abc", { type: "decision", decision: { id: "d1", prompt: "Which name?", options: [{ index: 0, label: "Keep it", consequence: "no-op" }], requiresConfirmation: false, state: "open", createdAt: 1, updatedAt: 1 } }));
		await waitFor(() => coordinator.decisions("room-1").length > 0);
		expect(coordinator.decisions("room-1")[0]!.state).toBe("open");

		await coordinator.endCall("room-1", true);
		const decision = coordinator.decisions("room-1")[0]!;
		expect(decision.state).toBe("expired");
		// The follow-up "expired" timeline card fired too — mint, then the end-of-call expiry.
		const decisionCards = cards.filter((c) => c.kind === "voice-decision");
		expect(decisionCards.map((c) => (c.payload as { face: { decisionState: string } }).face.decisionState)).toEqual(["open", "expired"]);
		coordinator.stop();
	});
});

describe("CRITICAL 3 — retention delivered end-to-end, sessionRoot reconciliation", () => {
	test("the binding's retention reaches the broker's createCall as `retention`", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-abc");
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards });
		await coordinator.startCall("room-1", { ownerActorId: "operator", retention: "tails" });
		expect(broker.createCallOpts).toEqual([{ resume: undefined, retention: "tails" }]);
		coordinator.stop();
	});

	test("the daemon-side default retention ('full') reaches the broker too, not just an explicit choice", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-abc");
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards });
		await coordinator.startCall("room-1", { ownerActorId: "operator" }); // no retention specified
		expect(broker.createCallOpts[0]!.retention).toBe("full");
		coordinator.stop();
	});

	test("a recordingMode that agrees with the binding's retention leaves no mismatch", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-abc", 0, "full");
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards });
		await coordinator.startCall("room-1", { ownerActorId: "operator", retention: "full" });
		expect(coordinator.state("room-1")!.retentionMismatch).toBeUndefined();
		coordinator.stop();
	});

	test("a recordingMode that disagrees with the binding's retention surfaces honestly on the binding and the live card", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		// The room asked for "full" but the session reports "tails" — a broker that ignored (or
		// mis-mapped) the request, or a stale build. Never a silent accept.
		const bridge = startFakeBridge("live-abc", 0, "tails");
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards });
		await coordinator.startCall("room-1", { ownerActorId: "operator", retention: "full" });
		const binding = coordinator.state("room-1")!;
		expect(binding.retentionMismatch).toEqual({ expected: "full", reported: "tails" });

		const liveCards = cards.filter((c) => c.kind === "voice-call" && (c.payload as { face: { state: string } }).face.state === "live");
		expect(liveCards.length).toBeGreaterThan(0);
		const detail = (liveCards[liveCards.length - 1]!.payload as { face: { detail?: string } }).face.detail;
		expect(detail).toBe('Recording mode mismatch: the room asked for "full", the session reports "tails".');
		coordinator.stop();
	});

	test("an absent recordingMode (an older bridge build) is never treated as a mismatch", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-abc"); // no recordingMode in its hello frame at all
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards });
		await coordinator.startCall("room-1", { ownerActorId: "operator", retention: "off" });
		expect(coordinator.state("room-1")!.retentionMismatch).toBeUndefined();
		coordinator.stop();
	});

	test("sessionRoot: the broker's own answer is preferred over the daemon's default guess", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		const brokerRoot = tmpDir("voice-mgr-broker-root-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); rmSync(brokerRoot, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-abc");
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		broker.sessionRoot = brokerRoot;
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards });
		await coordinator.startCall("room-1", { ownerActorId: "operator" }); // no client override at all
		expect(coordinator.state("room-1")!.sessionRoot).toBe(brokerRoot);
		coordinator.stop();
	});

	test("sessionRoot: a client override outside the broker's root is dropped in favor of the broker's root", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		const brokerRoot = tmpDir("voice-mgr-broker-root-");
		const outsideRoot = tmpDir("voice-mgr-outside-root-"); // exists, absolute, but NOT beneath brokerRoot
		cleanups.push(() => {
			rmSync(stateDir, { recursive: true, force: true });
			rmSync(journalDir, { recursive: true, force: true });
			rmSync(brokerRoot, { recursive: true, force: true });
			rmSync(outsideRoot, { recursive: true, force: true });
		});
		const bridge = startFakeBridge("live-abc");
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		broker.sessionRoot = brokerRoot;
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards });
		await coordinator.startCall("room-1", { ownerActorId: "operator", sessionRoot: outsideRoot });
		expect(coordinator.state("room-1")!.sessionRoot).toBe(brokerRoot); // the override never wins
		coordinator.stop();
	});

	test("sessionRoot: a client override contained WITHIN the broker's root is accepted", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		const brokerRoot = tmpDir("voice-mgr-broker-root-");
		const insideRoot = path.join(brokerRoot, "nested");
		mkdirSync(insideRoot);
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); rmSync(brokerRoot, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-abc");
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		broker.sessionRoot = brokerRoot;
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards });
		await coordinator.startCall("room-1", { ownerActorId: "operator", sessionRoot: insideRoot });
		expect(coordinator.state("room-1")!.sessionRoot).toBe(insideRoot);
		coordinator.stop();
	});
});

describe("resolveEffectiveSessionRoot (pure reconciliation logic)", () => {
	const noopLog = () => {};

	test("no override at all → the broker's root", async () => {
		expect(await resolveEffectiveSessionRoot(undefined, "/some/broker/root", noopLog)).toBe("/some/broker/root");
	});

	test("no override, no broker root → process.cwd()", async () => {
		expect(await resolveEffectiveSessionRoot(undefined, undefined, noopLog)).toBe(process.cwd());
	});

	test("a non-absolute override is dropped", async () => {
		expect(await resolveEffectiveSessionRoot("relative/path", "/some/broker/root", noopLog)).toBe("/some/broker/root");
	});

	test("an absolute override that does not exist is dropped, even with no broker root to check containment against", async () => {
		expect(await resolveEffectiveSessionRoot("/definitely/does/not/exist/xyz", undefined, noopLog)).toBe(process.cwd());
	});

	test("an absolute, existing override with NO broker root to check containment against is accepted", async () => {
		const dir = tmpDir("voice-mgr-resolve-root-");
		try {
			expect(await resolveEffectiveSessionRoot(dir, undefined, noopLog)).toBe(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an override contained within the broker's root is accepted", async () => {
		const root = tmpDir("voice-mgr-resolve-root-");
		const nested = path.join(root, "nested");
		mkdirSync(nested);
		try {
			expect(await resolveEffectiveSessionRoot(nested, root, noopLog)).toBe(nested);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("an override OUTSIDE the broker's root is dropped in favor of the broker's root", async () => {
		const root = tmpDir("voice-mgr-resolve-root-");
		const outside = tmpDir("voice-mgr-resolve-outside-");
		try {
			expect(await resolveEffectiveSessionRoot(outside, root, noopLog)).toBe(root);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("httpBrokerClient: the wire request the real broker actually receives", () => {
	test("createCall's `retention` option becomes the POST body's `recording` field", async () => {
		let receivedBody: unknown;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				receivedBody = await req.json();
				return new Response(JSON.stringify({ callId: "c1", port: 1, bridgeUrl: "ws://127.0.0.1:1", journalPath: "/tmp/x.jsonl", startedAt: Date.now(), exit: null, controlToken: "tok" }), { headers: { "content-type": "application/json" } });
			},
		});
		try {
			const client = httpBrokerClient(`http://127.0.0.1:${server.port}`);
			await client.createCall({ resume: "sess-1", retention: "tails" });
			expect(receivedBody).toEqual({ resume: "sess-1", recording: "tails" });
		} finally {
			server.stop(true);
		}
	});

	test("no retention specified ⇒ the body's `recording` field is undefined, matching the broker's own optional-field contract", async () => {
		let receivedBody: unknown;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				receivedBody = await req.json();
				return new Response(JSON.stringify({ callId: "c1", port: 1, bridgeUrl: "ws://127.0.0.1:1", journalPath: "/tmp/x.jsonl", startedAt: Date.now(), exit: null, controlToken: "tok" }), { headers: { "content-type": "application/json" } });
			},
		});
		try {
			const client = httpBrokerClient(`http://127.0.0.1:${server.port}`);
			await client.createCall();
			expect((receivedBody as Record<string, unknown>).recording).toBeUndefined();
		} finally {
			server.stop(true);
		}
	});
});
