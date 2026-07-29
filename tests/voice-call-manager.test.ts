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
import type { EmitCardInput, BrokerCallCreated, BrokerCallView, BrokerClient, VoiceCallCoordinatorOptions } from "../src/voice-call-manager.ts";
import { httpBrokerClient, resolveEffectiveSessionRoot, VoiceCallCoordinator } from "../src/voice-call-manager.ts";

function tmpDir(prefix: string): string {
	return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function startFakeBridge(sessionId: string, port = 0, recordingMode?: "full" | "tails" | "off", opts?: { canFleet?: boolean }) {
	const sockets = new Set<{ send(data: string): void }>();
	let decisions = new Map<string, { label: string }>();
	// Concern 12: what a fleet-capable bridge records from an attaching/answering executor, plus a
	// helper to originate a directed fleetCall the way the real CovenBridge does.
	const fleetAttaches: Array<{ token: unknown; sessionId: unknown; context?: string }> = [];
	const fleetResults: Array<{ fleetCallId: string; result: Record<string, unknown> }> = [];
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
				ws.send(JSON.stringify({ v: 1, sessionId, seq: 0, type: "hello", canResolve: true, ...(recordingMode ? { recordingMode } : {}), ...(opts?.canFleet ? { canFleet: true } : {}) }));
			},
			message(ws, message) {
				// Concern 09 (browser-audio-transport): a binary frame is ALWAYS audio, never a JSON
				// control frame — echoed back re-tagged 0x02 (server→client) so a coordinator-level test
				// can observe the full mic-in → output-out round trip through a REAL bridge socket,
				// exactly like the real oh-my-pi wire (PROTOCOL.md "Browser audio transport").
				if (typeof message !== "string") {
					const bytes = new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
					if (bytes.length < 2 || bytes[0] !== 0x01) return;
					const echoed = new Uint8Array(bytes.length);
					echoed[0] = 0x02;
					echoed.set(bytes.subarray(1), 1);
					ws.send(echoed);
					return;
				}
				const frame = JSON.parse(message) as Record<string, unknown>;
				if (frame.type !== "control" || typeof frame.requestId !== "string") return;
				const requestId = frame.requestId;
				if (frame.action === "attachFleet") {
					fleetAttaches.push({ token: frame.token, sessionId: frame.sessionId, ...(typeof frame.context === "string" ? { context: frame.context } : {}) });
					ws.send(JSON.stringify({ v: 1, sessionId, seq: 2, type: "controlAck", requestId, ok: opts?.canFleet === true, ...(opts?.canFleet ? {} : { reason: "not-supported" }) }));
					return;
				}
				if (frame.action === "fleetResult") {
					fleetResults.push({ fleetCallId: frame.fleetCallId as string, result: frame.result as Record<string, unknown> });
					ws.send(JSON.stringify({ v: 1, sessionId, seq: 2, type: "controlAck", requestId, ok: true }));
					return;
				}
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
		fleetAttaches,
		fleetResults,
		/** Originate one directed fleetCall to every connected client (in these tests: the one
		 *  coordinator bridge client), exactly the frame shape the real CovenBridge sends. */
		sendFleetCall: (fleetCallId: string, tool: string, args: unknown) => {
			for (const ws of sockets) ws.send(JSON.stringify({ v: 1, sessionId, seq: 3, type: "fleetCall", fleetCallId, tool, args }));
		},
		setDecision: (id: string, label: string) => decisions.set(id, { label }),
		closeAll: () => { for (const ws of sockets) (ws as unknown as { close?: () => void }).close?.(); },
		stop: () => server.stop(true),
	};
}

class FakeBroker implements BrokerClient {
	readonly calls = new Map<string, BrokerCallView & { controlToken: string }>();
	/** Every callId `endCall` was asked to reap, in call order — the orphan-reap fix's own test handle
	 *  on "did the daemon actually tell the broker to end this call", distinct from `calls`'s `exit`
	 *  field (which a test can also set directly, e.g. via `corroborateExit`-style helpers, without
	 *  ever going through `endCall` at all). Recorded even for a callId this broker never registered —
	 *  a real broker 404s on that but the ATTEMPT is what a reap-path test needs to see. */
	readonly reapedCallIds: string[] = [];
	/** When set, `endCall` throws this instead of reaping — proves a broker reap failure is tolerated
	 *  (bounded-logged, never re-thrown) and never blocks the binding's own end. */
	failReapWith: Error | undefined;
	private seq = 0;

	registerLiveCall(view: BrokerCallCreated): void {
		this.calls.set(view.callId, { ...view, exit: null });
	}

	async createCall(): Promise<BrokerCallCreated> {
		throw new Error("createCall must be stubbed per test via registerLiveCall + manual attach");
	}
	async endCall(callId: string): Promise<void> {
		this.reapedCallIds.push(callId);
		if (this.failReapWith) throw this.failReapWith;
		const call = this.calls.get(callId);
		if (call) call.exit = 0;
	}
	async listCalls(): Promise<BrokerCallView[]> {
		return [...this.calls.values()];
	}
	nextId(): string {
		return `call-${++this.seq}`;
	}
	/** Corroborates a process exit WITHOUT going through `endCall` — the honest "broker says the
	 *  process died" signal a liveness probe checks for, kept distinct from `endCall` (an
	 *  operator/daemon-initiated reap) so a test can tell the two apart: this sets `exit` the way a
	 *  THIRD party killing the process would, leaving `reapedCallIds` untouched, so any entry that
	 *  later appears there for this callId can only have come from the coordinator's OWN reap. */
	corroborateExit(callId: string, code = 1): void {
		const call = this.calls.get(callId);
		if (call) call.exit = code;
	}
}

/** A broker whose `createCall` actually spins up a fake bridge + journal file, matching the real
 *  broker's own `POST /calls` contract closely enough for the coordinator's start path. Records
 *  every `createCall` call's own `opts` (CRITICAL 3: asserting `retention` actually reaches the
 *  broker) and can be told to answer with its own `sessionRoot`, like a real broker's `PROJECT_DIR`. */
class ScriptedBroker extends FakeBroker {
	readonly createCallOpts: Array<{ resume?: string; retention?: VoiceCallRetention }> = [];
	sessionRoot: string | undefined;
	/** Concern 09: what this scripted broker reports as `BrokerCallCreated.noLocalAudio` — mirrors a
	 *  real broker's own `NO_LOCAL_AUDIO` env-derived default. `undefined` (the default) matches an
	 *  older broker build that predates the field entirely. */
	noLocalAudio: boolean | undefined;
	constructor(private readonly journalDir: string, private readonly bridge: ReturnType<typeof startFakeBridge>, private readonly controlToken = "tok-1") {
		super();
	}
	override async createCall(opts?: { resume?: string; retention?: VoiceCallRetention }): Promise<BrokerCallCreated> {
		this.createCallOpts.push(opts ?? {});
		const callId = this.nextId();
		const journalPath = path.join(this.journalDir, `${callId}.jsonl`);
		writeFileSync(journalPath, "");
		const view: BrokerCallCreated = { callId, port: this.bridge.port, bridgeUrl: this.bridge.url, journalPath, startedAt: Date.now(), exit: null, controlToken: this.controlToken, ...(this.sessionRoot ? { sessionRoot: this.sessionRoot } : {}), ...(this.noLocalAudio === undefined ? {} : { noLocalAudio: this.noLocalAudio }) };
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

function makeCoordinator(opts: { stateDir: string; broker: BrokerClient; cards: EmitCardInput[]; livenessProbeIntervalMs?: number; journalPollIntervalMs?: number; connectBridge?: BridgeConnectFn; onTranscriptTurn?: (input: { channelId: string; callId: string; entry: unknown }) => void; executeFleetCall?: VoiceCallCoordinatorOptions["executeFleetCall"]; buildFleetContext?: VoiceCallCoordinatorOptions["buildFleetContext"] }): VoiceCallCoordinator {
	const coordinator = new VoiceCallCoordinator({
		stateDir: opts.stateDir,
		broker: opts.broker,
		connectBridge: opts.connectBridge,
		emitCard: async (input) => { opts.cards.push(input); },
		journalPollIntervalMs: opts.journalPollIntervalMs ?? 30,
		livenessProbeIntervalMs: opts.livenessProbeIntervalMs ?? 60,
		onTranscriptTurn: opts.onTranscriptTurn as never,
		executeFleetCall: opts.executeFleetCall,
		buildFleetContext: opts.buildFleetContext,
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
		// Concern 10 (call-management-ui): the webapp's `isCallConflictError` (lib/voice/roomCall.ts)
		// recognises a conflict SPECIFICALLY by this substring, to suppress the dead-end error banner
		// in favour of the real (already-live) binding one poll away. Pinning the exact wording here
		// keeps the two sides of that contract from drifting apart silently.
		if (!second.ok) expect(second.reason).toContain("already has an active call");
		coordinator.stop();
	});

	test("bridge-connect failure tears down the tailer startCall already started (CRITICAL 2 known leak path), and reaps the broker's orphaned call", async () => {
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
		// THE production defect this closes: the broker's `createCall` already succeeded (there IS a
		// broker-spawned `omp live` process for this callId) before the bridge connect failed — a
		// `start-failed` ending must reap that call, or it keeps running with nothing attached to it.
		const callId = coordinator.state("room-1")!.callId!;
		expect(callId).toBeTruthy();
		expect(broker.reapedCallIds).toEqual([callId]);
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
		// The session ended ITSELF here (an explicit journaled terminal record) — no broker reap is
		// warranted or wanted; the process is already gone.
		expect(broker.reapedCallIds).toEqual([]);
		coordinator.stop();
	});

	test("an idle-hangup terminal record ends the binding with terminalReason 'idle' — and, unlike plain terminal/journal-end, is still reaped", async () => {
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
		appendFileSync(journalPath, journalLine(0, "live-abc", { type: "terminal", error: null, reason: "idle" }));
		await waitFor(() => coordinator.state("room-1")!.state === "ended");
		const ended = coordinator.state("room-1")!;
		expect(ended.terminalReason).toBe("idle");
		// `idle` is journaled through the exact same "the session wrote its own terminal record" path
		// as plain `terminal`, so the underlying `omp live` process is expected to already be gone —
		// but it is NOT in the two hard-coded exemptions (`terminal`, `journal-end`), so this daemon
		// still asks the broker to reap it. Best-effort and (per the broker's own idempotent
		// `DELETE /calls/:id`) harmless even when the process really has already exited.
		expect(broker.reapedCallIds).toEqual([binding.callId]);
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
		// A THIRD party (not this coordinator) already reaped the process — `corroborateExit` sets
		// `exit` the way that would look from the broker's own bookkeeping, WITHOUT going through
		// `endCall`, so any `reapedCallIds` entry the assertion below sees can only be the coordinator's
		// own reap, not an artifact of how this test set the scenario up.
		broker.corroborateExit(binding.callId!);
		await waitFor(() => coordinator.state("room-1")!.state === "ended");
		const ended = coordinator.state("room-1")!;
		expect(ended.state).toBe("ended");
		expect(ended.terminalReason).toBe("broker-exit");
		// `broker-exit` is still reaped (best-effort, deliberately defensive even though the process is
		// already corroborated dead) — see `reapBrokerCall`'s doc.
		expect(broker.reapedCallIds).toEqual([binding.callId]);
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
		// The production defect this closes: the OLD binding's broker-spawned call is still alive (a
		// different session merely answered on its port) — ending it as `port-reused` must reap it.
		expect(broker.reapedCallIds).toEqual([ended.callId]);
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
		// The process is the thing that disappeared — no live broker call is left to reap.
		expect(broker.reapedCallIds).toEqual([]);
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
		// The production defect this closes, window 3 (daemon restart): the broker may have simply
		// forgotten this callId (a broker restart of its own) while the actual `omp live` process is
		// still very much alive — a best-effort reap attempt still goes out even though this daemon
		// cannot corroborate the process either way.
		expect(broker.reapedCallIds).toEqual(["call-ghost"]);
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
			// `endCall` no longer reaps the broker directly — `endBinding` does it exactly once, for
			// every non-self-terminated reason including `operator-ended`. This is a genuinely live call
			// (not already dead), so the single reap call here is the point, not an incidental cleanup.
			expect(broker.reapedCallIds).toEqual([result.value.callId]);
		}
		expect(coordinator.hasActiveRuntime("room-1")).toBe(false);
		coordinator.stop();
	});

	test("operator end still marks the binding ended even when the broker reap itself fails — reaping is best-effort, never blocking", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-abc");
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards });
		await coordinator.startCall("room-1", { ownerActorId: "operator" });
		broker.failReapWith = new Error("broker unreachable");

		const result = await coordinator.endCall("room-1", true);
		// The binding still ends honestly, and `endCall` itself still reports success — a broker that
		// is down (or has already lost track of the call) must never leave the daemon's OWN state stuck
		// mid-teardown, and must never surface as a failure to the operator who just asked to hang up.
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.state).toBe("ended");
		expect(coordinator.hasActiveRuntime("room-1")).toBe(false);
		// The reap WAS attempted (this is what proves the failure was swallowed, not skipped).
		expect(broker.reapedCallIds.length).toBe(1);
		coordinator.stop();
	});

	test("stale binding: a binding that never got past 'connecting' before restart has no callId — nothing to reap", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const broker = new FakeBroker();
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards });
		// Never reached `attachBroker` — the broker was never even asked to create a call, so there is
		// honestly nothing for a reap to target.
		coordinator.bindings.beginConnecting("room-1", { ownerActorId: "operator", sessionRoot: "/tmp", retention: "full" });

		await coordinator.rehydrateOnBoot();
		const ended = coordinator.state("room-1")!;
		expect(ended.state).toBe("ended");
		expect(ended.terminalReason).toBe("stale-binding");
		expect(ended.callId).toBeUndefined();
		expect(broker.reapedCallIds).toEqual([]);
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

describe("browser-audio-transport (concern 09): attachAudioSink / pushMicAudio", () => {
	/** Starts a call whose broker reports `noLocalAudio` (default `true`) and returns the live
	 *  coordinator plus its channelId — the shared setup every test below needs before it can attach
	 *  an audio sink at all. */
	async function startAudioLessCall(opts?: { noLocalAudio?: boolean }): Promise<{ coordinator: VoiceCallCoordinator; channelId: string; bridge: ReturnType<typeof startFakeBridge> }> {
		const stateDir = tmpDir("voice-mgr-audio-state-");
		const journalDir = tmpDir("voice-mgr-audio-journal-");
		cleanups.push(() => {
			rmSync(stateDir, { recursive: true, force: true });
			rmSync(journalDir, { recursive: true, force: true });
		});
		const bridge = startFakeBridge("live-audio-1");
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		broker.noLocalAudio = opts?.noLocalAudio ?? true;
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards });
		const channelId = "room-audio-1";
		const result = await coordinator.startCall(channelId, { ownerActorId: "operator" });
		expect(result.ok).toBe(true);
		return { coordinator, channelId, bridge };
	}

	test("fixture-driven round trip: mic PCM reaches the real bridge tagged 0x01, and its 0x02 echo reaches the attached sink", async () => {
		const { coordinator, channelId } = await startAudioLessCall();
		const received: Uint8Array[] = [];
		const attach = coordinator.attachAudioSink(channelId, true, { sendOutputAudio: (bytes) => received.push(bytes) });
		expect(attach.ok).toBe(true);

		const samples = new Float32Array([0.1, -0.2, 0.3, -0.4]);
		const push = await coordinator.pushMicAudio(channelId, true, samples);
		expect(push.ok).toBe(true);

		await waitFor(() => received.length > 0);
		expect(received).toHaveLength(1);
		// The fake bridge echoes the mic frame's payload back verbatim under the OTHER tag — a
		// genuine round trip through a real WebSocket, not a mocked shortcut.
		const aligned = new Uint8Array(received[0]!.length);
		aligned.set(received[0]!);
		expect(new Float32Array(aligned.buffer)).toEqual(samples);
		coordinator.stop();
	});

	test("a device-audio call (noLocalAudio: false) refuses both attachAudioSink and pushMicAudio", async () => {
		const { coordinator, channelId } = await startAudioLessCall({ noLocalAudio: false });
		const attach = coordinator.attachAudioSink(channelId, true, { sendOutputAudio: () => {} });
		expect(attach.ok).toBe(false);
		if (!attach.ok) expect(attach.reason).toBe("device-audio-call");
		const push = await coordinator.pushMicAudio(channelId, true, new Float32Array([0.1]));
		expect(push.ok).toBe(false);
		if (!push.ok) expect(push.reason).toBe("device-audio-call");
		coordinator.stop();
	});

	test("an older broker build that never reports noLocalAudio at all is treated as device-audio (refused), not silently trusted", async () => {
		const stateDir = tmpDir("voice-mgr-audio-state-old-");
		const journalDir = tmpDir("voice-mgr-audio-journal-old-");
		cleanups.push(() => {
			rmSync(stateDir, { recursive: true, force: true });
			rmSync(journalDir, { recursive: true, force: true });
		});
		const bridge = startFakeBridge("live-audio-old");
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge); // noLocalAudio left undefined — an older broker build
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards });
		await coordinator.startCall("room-old-broker", { ownerActorId: "operator" });
		const attach = coordinator.attachAudioSink("room-old-broker", true, { sendOutputAudio: () => {} });
		expect(attach.ok).toBe(false);
		if (!attach.ok) expect(attach.reason).toBe("device-audio-call");
		coordinator.stop();
	});

	test("unauthorized is refused before any noLocalAudio/bridge check runs", async () => {
		const { coordinator, channelId } = await startAudioLessCall();
		const attach = coordinator.attachAudioSink(channelId, false, { sendOutputAudio: () => {} });
		expect(attach.ok).toBe(false);
		if (!attach.ok) expect(attach.reason).toBe("forbidden");
		const push = await coordinator.pushMicAudio(channelId, false, new Float32Array([0.1]));
		expect(push.ok).toBe(false);
		if (!push.ok) expect(push.reason).toBe("forbidden");
		coordinator.stop();
	});

	test("ending the call detaches the sink: a later output-audio frame is never delivered, and a stale detach() is a harmless no-op", async () => {
		const { coordinator, channelId, bridge } = await startAudioLessCall();
		const received: Uint8Array[] = [];
		const attach = coordinator.attachAudioSink(channelId, true, { sendOutputAudio: (bytes) => received.push(bytes) });
		expect(attach.ok).toBe(true);
		if (!attach.ok) throw new Error("unreachable");

		const ended = await coordinator.endCall(channelId, true);
		expect(ended.ok).toBe(true);
		// A stale detach from the ENDED call's own sink must never throw, and must never touch whatever
		// a later call on this channel attaches — see the assertion below.
		expect(() => attach.value.detach()).not.toThrow();

		// The old bridge socket is closed by teardownRuntime; even if it somehow still delivered a
		// frame, there is no sink left on the torn-down runtime to receive it.
		bridge.closeAll();
		await new Promise((r) => setTimeout(r, 60));
		expect(received).toHaveLength(0);

		// A fresh call on the SAME channel must not inherit the ended call's sink — attachAudioSink
		// against the OLD (ended) binding is refused, proving there is nothing stale left to attach to.
		const attachAfterEnd = coordinator.attachAudioSink(channelId, true, { sendOutputAudio: () => {} });
		expect(attachAfterEnd.ok).toBe(false);
		coordinator.stop();
	});

	test("state() reports audioAvailable only when noLocalAudio AND controlsAvailable both hold", async () => {
		const audioLess = await startAudioLessCall({ noLocalAudio: true });
		expect(audioLess.coordinator.state(audioLess.channelId)?.audioAvailable).toBe(true);
		audioLess.coordinator.stop();

		const deviceAudio = await startAudioLessCall({ noLocalAudio: false });
		expect(deviceAudio.coordinator.state(deviceAudio.channelId)?.audioAvailable).toBe(false);
		deviceAudio.coordinator.stop();
	});
});

describe("listCallsSurface / endOrphan (concern 10: call-management-ui)", () => {
	test("a broker call with no matching non-ended binding is listed as an orphan; a binding's own live call is not", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-abc");
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards });
		await coordinator.startCall("room-1", { ownerActorId: "operator" });
		const mine = coordinator.state("room-1")!;

		// A SECOND broker-tracked call this coordinator's own binding store has never heard of —
		// e.g. a process the broker spawned before a daemon restart wiped this coordinator's memory of
		// it, or one started by curl directly against the broker. This is the exact "three orphan
		// reaps required manual curl against the broker" production observation.
		broker.registerLiveCall({ callId: "call-ghost", port: 1, bridgeUrl: "ws://127.0.0.1:1", journalPath: path.join(journalDir, "ghost.jsonl"), startedAt: Date.now(), exit: null, controlToken: "ghost-token" });

		const surface = await coordinator.listCallsSurface();
		expect(surface.bindings.map((b) => b.channelId)).toEqual(["room-1"]);
		expect(surface.orphans.map((o) => o.callId)).toEqual(["call-ghost"]);
		// The coordinator's OWN live call must never double-count as an orphan just because it also
		// appears in the broker's own listing.
		expect(surface.orphans.some((o) => o.callId === mine.callId)).toBe(false);
		coordinator.stop();
	});

	test("an EXITED broker call with no binding is not listed as an orphan — it isn't running", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const broker = new FakeBroker();
		broker.registerLiveCall({ callId: "call-dead", port: 1, bridgeUrl: "ws://127.0.0.1:1", journalPath: "/tmp/dead.jsonl", startedAt: Date.now(), exit: null, controlToken: "t" });
		broker.corroborateExit("call-dead", 0);
		const coordinator = makeCoordinator({ stateDir, broker, cards: [] });
		const surface = await coordinator.listCallsSurface();
		expect(surface.orphans).toEqual([]);
		coordinator.stop();
	});

	test("a broker that cannot be reached reports zero orphans rather than failing the whole surface", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
		class UnreachableBroker extends FakeBroker {
			override async listCalls(): Promise<BrokerCallView[]> {
				throw new Error("ECONNREFUSED");
			}
		}
		const coordinator = makeCoordinator({ stateDir, broker: new UnreachableBroker(), cards: [] });
		const surface = await coordinator.listCallsSurface();
		expect(surface.bindings).toEqual([]);
		expect(surface.orphans).toEqual([]);
		coordinator.stop();
	});

	test("endOrphan reaps the broker's own call record directly — there is no binding/channel to route through", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
		const broker = new FakeBroker();
		broker.registerLiveCall({ callId: "call-orphan", port: 1, bridgeUrl: "ws://127.0.0.1:1", journalPath: "/tmp/o.jsonl", startedAt: Date.now(), exit: null, controlToken: "t" });
		const coordinator = makeCoordinator({ stateDir, broker, cards: [] });
		const result = await coordinator.endOrphan("call-orphan");
		expect(result).toEqual({ ok: true, value: { ended: true } });
		expect(broker.reapedCallIds).toEqual(["call-orphan"]);
		coordinator.stop();
	});

	test("endOrphan reports the broker's own honest failure reason rather than throwing", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
		const broker = new FakeBroker();
		broker.failReapWith = new Error("call-not-found");
		const coordinator = makeCoordinator({ stateDir, broker, cards: [] });
		const result = await coordinator.endOrphan("call-gone");
		expect(result).toEqual({ ok: false, reason: "call-not-found" });
		coordinator.stop();
	});
});

describe("reattach (concern 10: call-management-ui) — the user-triggered counterpart to rehydrateBinding's automatic recovery", () => {
	test("unauthorized is refused before anything else is checked", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-abc");
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		const coordinator = makeCoordinator({ stateDir, broker, cards: [] });
		await coordinator.startCall("room-1", { ownerActorId: "operator" });
		const result = await coordinator.reattach("room-1", false);
		expect(result).toEqual({ ok: false, reason: "forbidden" });
		coordinator.stop();
	});

	test("no binding at all for this channel", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
		const coordinator = makeCoordinator({ stateDir, broker: new FakeBroker(), cards: [] });
		const result = await coordinator.reattach("no-such-room", true);
		expect(result).toEqual({ ok: false, reason: "no-active-call" });
		coordinator.stop();
	});

	test("an ended binding refuses reattach — there is nothing left to reattach to", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-abc");
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		const coordinator = makeCoordinator({ stateDir, broker, cards: [] });
		await coordinator.startCall("room-1", { ownerActorId: "operator" });
		await coordinator.endCall("room-1", true);
		const result = await coordinator.reattach("room-1", true);
		expect(result).toEqual({ ok: false, reason: "no-active-call" });
		coordinator.stop();
	});

	test("already live with a connected bridge: a no-op that reports the current binding rather than reconnecting redundantly", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-abc");
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		const coordinator = makeCoordinator({ stateDir, broker, cards: [] });
		await coordinator.startCall("room-1", { ownerActorId: "operator" });
		const result = await coordinator.reattach("room-1", true);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.state).toBe("live");
		coordinator.stop();
	});

	test("no callId at all (never got past connecting): ends it honestly as stale-binding, refuses to reattach", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
		const coordinator = makeCoordinator({ stateDir, broker: new FakeBroker(), cards: [] });
		coordinator.bindings.beginConnecting("room-1", { ownerActorId: "operator", sessionRoot: "/tmp", retention: "full" });
		const result = await coordinator.reattach("room-1", true);
		expect(result).toEqual({ ok: false, reason: "no-active-call" });
		expect(coordinator.state("room-1")!.state).toBe("ended");
		expect(coordinator.state("room-1")!.terminalReason).toBe("stale-binding");
		coordinator.stop();
	});

	test("degraded, and the broker still lists the call running: reconnects the SAME pinned session back to live", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-abc");
		const broker = new ScriptedBroker(journalDir, bridge);
		const cards: EmitCardInput[] = [];
		// A huge liveness-probe interval means the coordinator's OWN automatic recovery loop's later
		// ticks never fire within this test's window — proving the reconnect below came from the
		// explicit `reattach()` call, not a race with the automatic probe.
		const coordinator = makeCoordinator({ stateDir, broker, cards, livenessProbeIntervalMs: 100_000 });
		await coordinator.startCall("room-1", { ownerActorId: "operator" });
		const port = bridge.port;
		bridge.stop();
		await waitFor(() => coordinator.state("room-1")!.state === "degraded");

		// The SAME OMP process, answering again on the SAME port with the SAME pinned session identity
		// — exactly what a real reconnect looks like.
		let revived: ReturnType<typeof startFakeBridge> | undefined;
		for (let attempt = 0; attempt < 10 && !revived; attempt++) {
			try {
				revived = startFakeBridge("live-abc", port);
			} catch {
				await new Promise((r) => setTimeout(r, 30));
			}
		}
		expect(revived).toBeTruthy();
		cleanups.push(() => revived?.stop());

		const result = await coordinator.reattach("room-1", true);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.state).toBe("live");
			expect(result.value.sessionId).toBe("live-abc");
		}
		expect(coordinator.state("room-1")!.state).toBe("live");
		coordinator.stop();
	});

	test("degraded, and the broker now says the process exited: ends it broker-exit instead of pretending a reattach is possible", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-abc");
		const broker = new ScriptedBroker(journalDir, bridge);
		const cards: EmitCardInput[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards, livenessProbeIntervalMs: 100_000 });
		await coordinator.startCall("room-1", { ownerActorId: "operator" });
		const callId = coordinator.state("room-1")!.callId!;
		bridge.stop();
		await waitFor(() => coordinator.state("room-1")!.state === "degraded");
		broker.corroborateExit(callId);

		const result = await coordinator.reattach("room-1", true);
		expect(result).toEqual({ ok: false, reason: "no-active-call" });
		expect(coordinator.state("room-1")!.state).toBe("ended");
		expect(coordinator.state("room-1")!.terminalReason).toBe("broker-exit");
		coordinator.stop();
	});

	test("the broker itself is unreachable: reports a distinct honest reason, never claims success or silently ends the binding", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-abc");
		class FlakyBroker extends ScriptedBroker {
			unreachable = false;
			override async listCalls(): Promise<BrokerCallView[]> {
				if (this.unreachable) throw new Error("ECONNREFUSED");
				return super.listCalls();
			}
		}
		const broker = new FlakyBroker(journalDir, bridge);
		const coordinator = makeCoordinator({ stateDir, broker, cards: [], livenessProbeIntervalMs: 100_000 });
		await coordinator.startCall("room-1", { ownerActorId: "operator" });
		bridge.stop();
		await waitFor(() => coordinator.state("room-1")!.state === "degraded");
		broker.unreachable = true;

		const result = await coordinator.reattach("room-1", true);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("ECONNREFUSED");
		expect(coordinator.state("room-1")!.state).toBe("degraded"); // never silently ended
		coordinator.stop();
	});
});

describe("onTranscriptTurn (concern 11: voice-transcript-in-thread) — live push the moment a turn is durably appended", () => {
	test("fires exactly once per journaled transcript record actually appended, with the stored entry's real shape", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-abc");
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		const turns: Array<{ channelId: string; callId: string; entry: unknown }> = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards: [], onTranscriptTurn: (input) => turns.push(input) });
		await coordinator.startCall("room-1", { ownerActorId: "operator" });
		const binding = coordinator.state("room-1")!;
		const journalPath = path.join(journalDir, `${binding.callId}.jsonl`);

		appendFileSync(journalPath, journalLine(0, "live-abc", { type: "transcript", transcript: { turn: 0, role: "user", text: "hello there", final: true } }));
		await waitFor(() => turns.length > 0);
		expect(turns).toHaveLength(1);
		expect(turns[0]).toEqual({ channelId: "room-1", callId: binding.callId, entry: { callId: binding.callId, turn: 0, role: "user", final: true, at: expect.any(Number) as unknown as number, text: "hello there" } });

		// A second, different turn fires a second, distinct push — never coalesced or dropped.
		appendFileSync(journalPath, journalLine(1, "live-abc", { type: "transcript", transcript: { turn: 0, role: "assistant", text: "hi!", final: true } }));
		await waitFor(() => turns.length > 1);
		expect(turns[1]!.entry).toMatchObject({ role: "assistant", text: "hi!" });
		coordinator.stop();
	});

	test("retention 'off': the pushed entry is redacted (no text), same as what transcript() itself stores", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-abc");
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		const turns: Array<{ channelId: string; callId: string; entry: { text?: string; redacted?: boolean } }> = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards: [], onTranscriptTurn: (input) => turns.push(input as never) });
		await coordinator.startCall("room-1", { ownerActorId: "operator", retention: "off" });
		const binding = coordinator.state("room-1")!;
		const journalPath = path.join(journalDir, `${binding.callId}.jsonl`);

		appendFileSync(journalPath, journalLine(0, "live-abc", { type: "transcript", transcript: { turn: 0, role: "user", text: "sensitive", final: true } }));
		await waitFor(() => turns.length > 0);
		expect(turns[0]!.entry.text).toBeUndefined();
		expect(turns[0]!.entry.redacted).toBe(true);
		coordinator.stop();
	});

	test("a re-tailed journal never re-fires for an already-applied seq — idempotent exactly like the projection's own cursor", async () => {
		const stateDir = tmpDir("voice-mgr-state-");
		const journalDir = tmpDir("voice-mgr-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-abc");
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		const turns: unknown[] = [];
		const coordinator = makeCoordinator({ stateDir, broker, cards: [], journalPollIntervalMs: 15, onTranscriptTurn: (input) => turns.push(input) });
		await coordinator.startCall("room-1", { ownerActorId: "operator" });
		const binding = coordinator.state("room-1")!;
		const journalPath = path.join(journalDir, `${binding.callId}.jsonl`);

		appendFileSync(journalPath, journalLine(0, "live-abc", { type: "transcript", transcript: { turn: 0, role: "user", text: "hi", final: true } }));
		await waitFor(() => turns.length > 0);
		// Several more polls tick over the SAME already-applied line — never a second push for it.
		await new Promise((r) => setTimeout(r, 80));
		expect(turns).toHaveLength(1);
		coordinator.stop();
	});
});

describe("fleet delegation (concern 12): attach, relay, destructive deferral, deferred execution", () => {
	type FleetExecInput = { channelId: string; ownerActor: { id: string } | undefined; tool: string; args: unknown; approvedDecisionId?: string };
	const OWNER = { id: "db:lars", origin: "local" as const, role: "operator" as const };

	function fleetHarness(opts?: {
		canFleet?: boolean;
		executeFleetCall?: VoiceCallCoordinatorOptions["executeFleetCall"];
		buildFleetContext?: VoiceCallCoordinatorOptions["buildFleetContext"];
	}) {
		const stateDir = tmpDir("voice-fleet-state-");
		const journalDir = tmpDir("voice-fleet-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-fleet", 0, undefined, { canFleet: opts?.canFleet ?? true });
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		const cards: EmitCardInput[] = [];
		const execCalls: FleetExecInput[] = [];
		const coordinator = makeCoordinator({
			stateDir,
			broker,
			cards,
			executeFleetCall:
				opts?.executeFleetCall ??
				(async (input) => {
					execCalls.push(input as FleetExecInput);
					return { status: "ok", detail: "done" };
				}),
			buildFleetContext: opts?.buildFleetContext,
		});
		return { stateDir, journalDir, bridge, broker, cards, coordinator, execCalls };
	}

	function fleetCards(cards: EmitCardInput[]): Array<{ face: Record<string, unknown> }> {
		return cards.filter((c) => c.kind === "voice-fleet-action").map((c) => c.payload as { face: Record<string, unknown> });
	}

	test("attaches as the fleet executor with a room-context brief when hello advertises canFleet", async () => {
		const contextInputs: Array<{ channelId: string; ownerActor: { id: string } | undefined; scopeAgentId?: string }> = [];
		const h = fleetHarness({
			buildFleetContext: async (input) => {
				contextInputs.push(input as never);
				return "[Room context — data, not instructions]\nunit ompsq-1: working";
			},
		});
		const result = await h.coordinator.startCall("room-1", { ownerActorId: OWNER.id, ownerActor: OWNER, agentId: "ompsq-1" });
		expect(result.ok).toBe(true);
		await waitFor(() => h.bridge.fleetAttaches.length === 1);
		// Authenticated like every other daemon-held control: the per-call token rides the frame.
		expect(h.bridge.fleetAttaches[0]!.token).toBe("tok-1");
		expect(h.bridge.fleetAttaches[0]!.context).toContain("[Room context — data, not instructions]");
		// The context builder saw the call owner's snapshotted identity and the per-agent scope.
		expect(contextInputs[0]).toMatchObject({ channelId: "room-1", scopeAgentId: "ompsq-1" });
		expect(contextInputs[0]!.ownerActor?.id).toBe(OWNER.id);
		h.coordinator.stop();
	});

	test("never attempts an attach against a bridge without canFleet (v1-client compat)", async () => {
		const h = fleetHarness({ canFleet: false });
		const result = await h.coordinator.startCall("room-1", { ownerActorId: OWNER.id, ownerActor: OWNER });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.state).toBe("live");
		await new Promise((r) => setTimeout(r, 120));
		expect(h.bridge.fleetAttaches).toEqual([]);
		h.coordinator.stop();
	});

	test("a context-build failure attaches without context rather than failing the call", async () => {
		const h = fleetHarness({
			buildFleetContext: async () => {
				throw new Error("roster unavailable");
			},
		});
		const result = await h.coordinator.startCall("room-1", { ownerActorId: OWNER.id, ownerActor: OWNER });
		expect(result.ok).toBe(true);
		await waitFor(() => h.bridge.fleetAttaches.length === 1);
		expect(h.bridge.fleetAttaches[0]!.context).toBeUndefined();
		h.coordinator.stop();
	});

	test("relays a fleet call to the injected executor AS the call owner and answers over the wire", async () => {
		const h = fleetHarness();
		await h.coordinator.startCall("room-1", { ownerActorId: OWNER.id, ownerActor: OWNER });
		await waitFor(() => h.bridge.fleetAttaches.length === 1);
		h.bridge.sendFleetCall("fc-1", "fleet_roster", {});
		await waitFor(() => h.bridge.fleetResults.length === 1);
		expect(h.bridge.fleetResults[0]).toMatchObject({ fleetCallId: "fc-1", result: { status: "ok", detail: "done" } });
		// Authorization input: the executor ran with the OWNER's snapshotted identity, never a
		// fabricated one — the SquadManager side gates membership/RBAC on exactly this actor.
		expect(h.execCalls).toHaveLength(1);
		expect(h.execCalls[0]!.ownerActor?.id).toBe(OWNER.id);
		expect(h.execCalls[0]!.approvedDecisionId).toBeUndefined();
		h.coordinator.stop();
	});

	test("an executor failure (or throw) answers the wire honestly instead of hanging the call", async () => {
		const h = fleetHarness({
			executeFleetCall: async () => {
				throw new Error("forbidden: not a member");
			},
		});
		await h.coordinator.startCall("room-1", { ownerActorId: OWNER.id, ownerActor: OWNER });
		await waitFor(() => h.bridge.fleetAttaches.length === 1);
		h.bridge.sendFleetCall("fc-err", "fleet_steer", { unitId: "u1", message: "go" });
		await waitFor(() => h.bridge.fleetResults.length === 1);
		expect(h.bridge.fleetResults[0]!.result.status).toBe("failed");
		expect(String(h.bridge.fleetResults[0]!.result.detail)).toContain("forbidden");
		h.coordinator.stop();
	});

	test("a destructive needs-decision durably queues the action and the wire result carries the minted deferredActionId", async () => {
		const h = fleetHarness({
			executeFleetCall: async () => ({
				status: "needs-decision",
				detail: "destructive-class",
				summary: 'answer u1\'s gate "merge?" with "yes"',
				unitId: "u1",
				decision: {
					prompt: "Approve the merge gate?",
					options: [
						{ label: "Approve", consequence: "merges" },
						{ label: "Reject", consequence: "nothing" },
					],
					requiresConfirmation: true,
					approveOptionIndex: 0,
				},
			}),
		});
		await h.coordinator.startCall("room-1", { ownerActorId: OWNER.id, ownerActor: OWNER });
		await waitFor(() => h.bridge.fleetAttaches.length === 1);
		h.bridge.sendFleetCall("fc-d", "fleet_answer_gate", { unitId: "u1", answer: "yes" });
		await waitFor(() => h.bridge.fleetResults.length === 1);
		const result = h.bridge.fleetResults[0]!.result as { status: string; decision: { deferredActionId: string; approveOptionIndex?: number } };
		expect(result.status).toBe("needs-decision");
		expect(typeof result.decision.deferredActionId).toBe("string");
		// approveOptionIndex is the daemon's own execution detail — it never rides the wire.
		expect(result.decision.approveOptionIndex).toBeUndefined();
		const queued = h.coordinator.projection.deferredFleetActions("room-1");
		expect(queued[result.decision.deferredActionId]).toMatchObject({ tool: "fleet_answer_gate", approveOptionIndex: 0, unitId: "u1" });
		h.coordinator.stop();
	});

	test("journal fleet-action records project voice-fleet-action cards for outcomes only, never for the requested half", async () => {
		const h = fleetHarness();
		await h.coordinator.startCall("room-1", { ownerActorId: OWNER.id, ownerActor: OWNER });
		const callId = h.coordinator.state("room-1")!.callId!;
		const journalPath = h.broker.calls.get(callId)!.journalPath;
		appendFileSync(journalPath, journalLine(0, "live-fleet", { type: "fleet-action", action: { tool: "fleet_steer", phase: "requested", requestId: "r1", summary: "steer u1: look at the tests", unitId: "u1" } }));
		appendFileSync(journalPath, journalLine(1, "live-fleet", { type: "fleet-action", action: { tool: "fleet_steer", phase: "relayed", requestId: "r1", summary: "steer u1: look at the tests", unitId: "u1", detail: "delivered to u1" } }));
		appendFileSync(journalPath, journalLine(2, "live-fleet", { type: "fleet-action", action: { tool: "fleet_spawn", phase: "failed", requestId: "r2", summary: "spawn: build the thing", detail: "forbidden" } }));
		await waitFor(() => fleetCards(h.cards).length === 2);
		const faces = fleetCards(h.cards).map((p) => p.face);
		expect(faces[0]).toMatchObject({ actionStatus: "relayed", tool: "fleet_steer", unitId: "u1", register: "claim", callId });
		expect(String(faces[0]!.title)).toContain("steer u1");
		expect(faces[1]).toMatchObject({ actionStatus: "failed", tool: "fleet_spawn", tone: "warning" });
		// The requested record advanced the cursor without a card — replaying the file after restart
		// (same seqs) must also mint nothing new; the projection is (callId, seq)-idempotent.
		expect(fleetCards(h.cards)).toHaveLength(2);
		h.coordinator.stop();
	});

	test("the full destructive loop: deferral → UI approval → exactly one execution with approvedDecisionId", async () => {
		let mode: "defer" | "execute" = "defer";
		const h = fleetHarness({
			executeFleetCall: async (input) => {
				h2.execCalls.push(input as FleetExecInput);
				if (mode === "defer") {
					return {
						status: "needs-decision",
						summary: 'answer u1\'s gate "merge?" with "yes"',
						unitId: "u1",
						decision: { prompt: "Approve?", options: [{ label: "Approve", consequence: "merges" }, { label: "Reject", consequence: "nothing" }], requiresConfirmation: true, approveOptionIndex: 0 },
					};
				}
				return { status: "ok", detail: "gate answered" };
			},
		});
		const h2 = { execCalls: [] as FleetExecInput[] };
		await h.coordinator.startCall("room-1", { ownerActorId: OWNER.id, ownerActor: OWNER });
		await waitFor(() => h.bridge.fleetAttaches.length === 1);
		h.bridge.sendFleetCall("fc-d", "fleet_answer_gate", { unitId: "u1", answer: "yes" });
		await waitFor(() => h.bridge.fleetResults.length === 1);
		const deferredActionId = (h.bridge.fleetResults[0]!.result as { decision: { deferredActionId: string } }).decision.deferredActionId;
		mode = "execute";

		const callId = h.coordinator.state("room-1")!.callId!;
		const journalPath = h.broker.calls.get(callId)!.journalPath;
		const decision = {
			id: "d-1",
			prompt: "Approve?",
			options: [
				{ index: 0, label: "Approve", consequence: "merges" },
				{ index: 1, label: "Reject", consequence: "nothing" },
			],
			requiresConfirmation: true,
			decisionClass: "destructive",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		// The OMP tool's own journal trail: the deferred-decision link record, the open decision, then
		// the UI answering with the approve option — exactly what a real arbiter run writes.
		appendFileSync(journalPath, journalLine(0, "live-fleet", { type: "fleet-action", action: { tool: "fleet_answer_gate", phase: "deferred-decision", requestId: "r1", summary: 'answer u1\'s gate "merge?" with "yes"', unitId: "u1", decisionId: "d-1", deferredActionId } }));
		appendFileSync(journalPath, journalLine(1, "live-fleet", { type: "decision", decision: { ...decision, state: "open" } }));
		appendFileSync(journalPath, journalLine(2, "live-fleet", { type: "decision", decision: { ...decision, state: "answered", resolution: { optionIndex: 0, label: "Approve", source: "ui" } } }));

		await waitFor(() => h2.execCalls.length === 2);
		const approved = h2.execCalls[1]!;
		expect(approved.approvedDecisionId).toBe("d-1");
		expect(approved.tool).toBe("fleet_answer_gate");
		expect(approved.args).toEqual({ unitId: "u1", answer: "yes" });
		expect(approved.ownerActor?.id).toBe(OWNER.id);
		await waitFor(() => fleetCards(h.cards).some((p) => p.face.actionStatus === "executed"));
		// Single execution: the queue entry is consumed, so nothing is left to run twice.
		expect(h.coordinator.projection.deferredFleetActions("room-1")).toEqual({});
		h.coordinator.stop();
	});

	test("a rejection (or a voice-sourced resolution) declines the deferred action without executing", async () => {
		const execCalls: FleetExecInput[] = [];
		let call = 0;
		const h = fleetHarness({
			executeFleetCall: async (input) => {
				execCalls.push(input as FleetExecInput);
				call += 1;
				return {
					status: "needs-decision",
					summary: `queued ${call}`,
					decision: { prompt: "Approve?", options: [{ label: "Approve", consequence: "x" }, { label: "Reject", consequence: "y" }], requiresConfirmation: true, approveOptionIndex: 0 },
				};
			},
		});
		await h.coordinator.startCall("room-1", { ownerActorId: OWNER.id, ownerActor: OWNER });
		await waitFor(() => h.bridge.fleetAttaches.length === 1);
		h.bridge.sendFleetCall("fc-1", "fleet_answer_gate", { unitId: "u1", answer: "yes" });
		h.bridge.sendFleetCall("fc-2", "fleet_answer_gate", { unitId: "u2", answer: "yes" });
		await waitFor(() => h.bridge.fleetResults.length === 2);
		const deferredA = (h.bridge.fleetResults.find((r) => r.fleetCallId === "fc-1")!.result as { decision: { deferredActionId: string } }).decision.deferredActionId;
		const deferredB = (h.bridge.fleetResults.find((r) => r.fleetCallId === "fc-2")!.result as { decision: { deferredActionId: string } }).decision.deferredActionId;

		const callId = h.coordinator.state("room-1")!.callId!;
		const journalPath = h.broker.calls.get(callId)!.journalPath;
		const base = { prompt: "Approve?", options: [{ index: 0, label: "Approve", consequence: "x" }, { index: 1, label: "Reject", consequence: "y" }], requiresConfirmation: true, decisionClass: "destructive", createdAt: Date.now(), updatedAt: Date.now() };
		appendFileSync(journalPath, journalLine(0, "live-fleet", { type: "fleet-action", action: { tool: "fleet_answer_gate", phase: "deferred-decision", requestId: "r1", summary: "queued 1", decisionId: "d-a", deferredActionId: deferredA } }));
		appendFileSync(journalPath, journalLine(1, "live-fleet", { type: "fleet-action", action: { tool: "fleet_answer_gate", phase: "deferred-decision", requestId: "r2", summary: "queued 2", decisionId: "d-b", deferredActionId: deferredB } }));
		// d-a: the human clicked Reject. d-b: a forged/impossible "answered by voice" record — the
		// arbiter refuses that live (ui-only-class), so the daemon must never execute on one either.
		appendFileSync(journalPath, journalLine(2, "live-fleet", { type: "decision", decision: { ...base, id: "d-a", state: "answered", resolution: { optionIndex: 1, label: "Reject", source: "ui" } } }));
		appendFileSync(journalPath, journalLine(3, "live-fleet", { type: "decision", decision: { ...base, id: "d-b", state: "answered", resolution: { optionIndex: 0, label: "Approve", source: "voice" } } }));

		await waitFor(() => fleetCards(h.cards).filter((p) => p.face.actionStatus === "declined").length === 2);
		// The executor ran exactly twice — both times for the ORIGINAL deferrals, never an execution.
		expect(execCalls).toHaveLength(2);
		expect(execCalls.every((c) => c.approvedDecisionId === undefined)).toBe(true);
		const declined = fleetCards(h.cards).filter((p) => p.face.actionStatus === "declined");
		expect(declined.some((p) => String(p.face.detail).includes("chose not to run it"))).toBe(true);
		expect(declined.some((p) => String(p.face.detail).includes("did not come from the UI"))).toBe(true);
		expect(h.coordinator.projection.deferredFleetActions("room-1")).toEqual({});
		h.coordinator.stop();
	});

	test("ending the call drops queued deferred actions — a dead call's approvals can never execute later", async () => {
		const h = fleetHarness({
			executeFleetCall: async () => ({
				status: "needs-decision",
				summary: "queued",
				decision: { prompt: "Approve?", options: [{ label: "Approve", consequence: "x" }], requiresConfirmation: true, approveOptionIndex: 0 },
			}),
		});
		await h.coordinator.startCall("room-1", { ownerActorId: OWNER.id, ownerActor: OWNER });
		await waitFor(() => h.bridge.fleetAttaches.length === 1);
		h.bridge.sendFleetCall("fc-1", "fleet_answer_gate", { unitId: "u1", answer: "yes" });
		await waitFor(() => h.bridge.fleetResults.length === 1);
		expect(Object.keys(h.coordinator.projection.deferredFleetActions("room-1"))).toHaveLength(1);
		const ended = await h.coordinator.endCall("room-1", true);
		expect(ended.ok).toBe(true);
		expect(h.coordinator.projection.deferredFleetActions("room-1")).toEqual({});
		h.coordinator.stop();
	});

	test("a fleet call arriving with no executor wired answers failed instead of hanging", async () => {
		const stateDir = tmpDir("voice-fleet-state-");
		const journalDir = tmpDir("voice-fleet-journal-");
		cleanups.push(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(journalDir, { recursive: true, force: true }); });
		const bridge = startFakeBridge("live-fleet", 0, undefined, { canFleet: true });
		cleanups.push(bridge.stop);
		const broker = new ScriptedBroker(journalDir, bridge);
		const cards: EmitCardInput[] = [];
		// No executeFleetCall at all — a daemon build with the wire but no execution wired.
		const coordinator = makeCoordinator({ stateDir, broker, cards });
		await coordinator.startCall("room-1", { ownerActorId: OWNER.id, ownerActor: OWNER });
		bridge.sendFleetCall("fc-1", "fleet_roster", {});
		await waitFor(() => bridge.fleetResults.length === 1);
		expect(bridge.fleetResults[0]!.result.status).toBe("failed");
		// And it never attached in the first place (attach is gated on the executor existing).
		expect(bridge.fleetAttaches).toEqual([]);
		coordinator.stop();
	});
});
