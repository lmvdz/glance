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
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EmitCardInput, BrokerCallCreated, BrokerCallView, BrokerClient } from "../src/voice-call-manager.ts";
import { VoiceCallCoordinator } from "../src/voice-call-manager.ts";

function tmpDir(prefix: string): string {
	return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function startFakeBridge(sessionId: string, port = 0) {
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
				ws.send(JSON.stringify({ v: 1, sessionId, seq: 0, type: "hello", canResolve: true }));
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
 *  broker's own `POST /calls` contract closely enough for the coordinator's start path. */
class ScriptedBroker extends FakeBroker {
	constructor(private readonly journalDir: string, private readonly bridge: ReturnType<typeof startFakeBridge>, private readonly controlToken = "tok-1") {
		super();
	}
	override async createCall(): Promise<BrokerCallCreated> {
		const callId = this.nextId();
		const journalPath = path.join(this.journalDir, `${callId}.jsonl`);
		writeFileSync(journalPath, "");
		const view: BrokerCallCreated = { callId, port: this.bridge.port, bridgeUrl: this.bridge.url, journalPath, startedAt: Date.now(), exit: null, controlToken: this.controlToken };
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

function makeCoordinator(opts: { stateDir: string; broker: BrokerClient; cards: EmitCardInput[]; livenessProbeIntervalMs?: number; journalPollIntervalMs?: number }): VoiceCallCoordinator {
	const coordinator = new VoiceCallCoordinator({
		stateDir: opts.stateDir,
		broker: opts.broker,
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
