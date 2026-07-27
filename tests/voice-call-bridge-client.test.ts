/**
 * Concern 02 — VoiceCallBridgeClient against a real WebSocket server implementing the Coven Bridge
 * control-plane subset from `opencoven-viz/PROTOCOL.md` (hello / resolveDecision / controlAck with
 * token, session, and label-echo checks) — a genuine wire-protocol exercise, not a mocked client.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { VoiceCallBridgeClient, type BridgeSocketLike } from "../src/voice-call-bridge-client.ts";

/** Minimal hand-rolled `BridgeSocketLike` — for the handler-detachment tests (MINOR 10) below, which
 *  need to fire `onerror`/`onclose` on cue rather than depend on a real socket's own timing. */
class FakeSocket implements BridgeSocketLike {
	closed = false;
	onopen: (() => void) | null = null;
	onmessage: ((ev: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: ((ev: unknown) => void) | null = null;
	send(): void {}
	close(): void {
		this.closed = true;
	}
	fireError(err: unknown): void {
		this.onerror?.(err);
	}
	fireClose(): void {
		this.onclose?.();
	}
}

interface FakeDecision {
	label: string;
	optionIndex: number;
}

interface FakeBridgeOptions {
	sessionId: string;
	controlToken?: string;
	decisions?: Map<string, FakeDecision>;
	/** Send a `terminal` frame right after hello, instead of waiting for a control frame. */
	terminalOnConnect?: string | null;
	/** Never send hello at all — for the connect-timeout/reject path. */
	suppressHello?: boolean;
}

function startFakeBridge(opts: FakeBridgeOptions) {
	const sockets = new Set<{ send(data: string): void }>();
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req, srv) {
			if (srv.upgrade(req)) return undefined;
			return new Response("ws only", { status: 426 });
		},
		websocket: {
			open(ws) {
				sockets.add(ws as unknown as { send(data: string): void });
				if (opts.suppressHello) return;
				ws.send(JSON.stringify({ v: 1, sessionId: opts.sessionId, seq: 0, type: "hello", canResolve: true }));
				if (opts.terminalOnConnect !== undefined) {
					ws.send(JSON.stringify({ v: 1, sessionId: opts.sessionId, seq: 1, type: "terminal", error: opts.terminalOnConnect }));
				}
			},
			message(ws, message) {
				const frame = JSON.parse(typeof message === "string" ? message : message.toString()) as Record<string, unknown>;
				if (frame.type !== "control") return;
				const requestId = frame.requestId as string | undefined;
				if (!requestId) return;
				if (opts.controlToken !== undefined && frame.token !== opts.controlToken) {
					ws.send(JSON.stringify({ v: 1, sessionId: opts.sessionId, seq: 2, type: "controlAck", requestId, ok: false, reason: "invalid-token" }));
					return;
				}
				if (frame.sessionId !== undefined && frame.sessionId !== opts.sessionId) {
					ws.send(JSON.stringify({ v: 1, sessionId: opts.sessionId, seq: 2, type: "controlAck", requestId, ok: false, reason: "wrong-session" }));
					return;
				}
				if (frame.action === "resolveDecision") {
					const decision = opts.decisions?.get(frame.decisionId as string);
					if (!decision) {
						ws.send(JSON.stringify({ v: 1, sessionId: opts.sessionId, seq: 2, type: "controlAck", requestId, ok: false, reason: "not-found" }));
						return;
					}
					if (decision.label !== frame.label) {
						ws.send(JSON.stringify({ v: 1, sessionId: opts.sessionId, seq: 2, type: "controlAck", requestId, ok: false, reason: "label-mismatch" }));
						return;
					}
					ws.send(JSON.stringify({ v: 1, sessionId: opts.sessionId, seq: 2, type: "controlAck", requestId, ok: true, decision: { id: frame.decisionId, state: "answered" } }));
					return;
				}
				if (frame.action === "setInterruptPolicy") {
					ws.send(JSON.stringify({ v: 1, sessionId: opts.sessionId, seq: 2, type: "controlAck", requestId, ok: true }));
					return;
				}
			},
			close(ws) {
				sockets.delete(ws as unknown as { send(data: string): void });
			},
		},
	});
	return {
		url: `ws://127.0.0.1:${server.port}`,
		stop: () => server.stop(true),
		sendTerminal: (error: string | null) => {
			for (const ws of sockets) ws.send(JSON.stringify({ v: 1, sessionId: opts.sessionId, seq: 9, type: "terminal", error }));
		},
		closeAll: () => {
			for (const ws of sockets) (ws as unknown as { close?: () => void }).close?.();
		},
	};
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
});

describe("connect", () => {
	test("resolves with the bridge's own sessionId from hello", async () => {
		const bridge = startFakeBridge({ sessionId: "live-123" });
		cleanups.push(bridge.stop);
		const client = new VoiceCallBridgeClient({ url: bridge.url });
		const hello = await client.connect();
		expect(hello.sessionId).toBe("live-123");
		client.close();
	});

	test("rejects when the socket closes before hello ever arrives", async () => {
		const bridge = startFakeBridge({ sessionId: "live-123", suppressHello: true });
		cleanups.push(bridge.stop);
		const client = new VoiceCallBridgeClient({ url: bridge.url, helloTimeoutMs: 300 });
		await expect(client.connect()).rejects.toBeTruthy();
	});
});

describe("MINOR 10 — handler detachment on an abandoned/closed socket", () => {
	test("a pre-hello socket error rejects connect AND detaches handlers before closing — a later close on the same socket never double-fires onSocketLoss", async () => {
		let onSocketLoss = 0;
		const socket = new FakeSocket();
		const client = new VoiceCallBridgeClient({ url: "ws://fake", connect: () => socket, onSocketLoss: () => { onSocketLoss++; } });
		const pending = client.connect();
		socket.fireError(new Error("connection refused"));
		await expect(pending).rejects.toBeTruthy();
		// Detached before close — exactly like the hello-timeout path this mirrors.
		expect(socket.closed).toBe(true);
		expect(socket.onerror).toBeNull();
		expect(socket.onclose).toBeNull();
		expect(socket.onmessage).toBeNull();
		// A LATER close event on this same (already abandoned) socket must never reach onSocketLoss —
		// this rejection already told the caller everything it needs to know.
		socket.fireClose();
		expect(onSocketLoss).toBe(0);
	});

	test("close() detaches handlers before closing the real socket — an async close afterward never fires onSocketLoss", async () => {
		const bridge = startFakeBridge({ sessionId: "live-123" });
		cleanups.push(bridge.stop);
		let onSocketLoss = 0;
		const client = new VoiceCallBridgeClient({ url: bridge.url, onSocketLoss: () => { onSocketLoss++; } });
		await client.connect();
		client.close();
		// Give the real WebSocket's own async close a real chance to fire, if it ever will — the fix
		// this guards is exactly that a LATER close must not read as a fresh socket-loss signal (the
		// spurious "degraded" card racing in after an "ended" card that MINOR 10 flagged).
		await new Promise((r) => setTimeout(r, 150));
		expect(onSocketLoss).toBe(0);
	});
});

describe("resolveDecision — authorization outcomes", () => {
	test("allowed member with the right token/session/label: ok", async () => {
		const bridge = startFakeBridge({ sessionId: "live-123", controlToken: "tok-1", decisions: new Map([["d1", { label: "Keep it", optionIndex: 0 }]]) });
		cleanups.push(bridge.stop);
		const client = new VoiceCallBridgeClient({ url: bridge.url, controlToken: "tok-1" });
		await client.connect();
		const ack = await client.resolveDecision({ decisionId: "d1", optionIndex: 0, label: "Keep it" });
		expect(ack.ok).toBe(true);
		client.close();
	});

	test("denied: wrong control token is refused with invalid-token", async () => {
		const bridge = startFakeBridge({ sessionId: "live-123", controlToken: "tok-1", decisions: new Map([["d1", { label: "Keep it", optionIndex: 0 }]]) });
		cleanups.push(bridge.stop);
		const client = new VoiceCallBridgeClient({ url: bridge.url, controlToken: "wrong-token" });
		await client.connect();
		const ack = await client.resolveDecision({ decisionId: "d1", optionIndex: 0, label: "Keep it" });
		expect(ack.ok).toBe(false);
		expect(ack.reason).toBe("invalid-token");
	});

	test("arbiter rejection: a label that does not match the real option is refused with label-mismatch", async () => {
		const bridge = startFakeBridge({ sessionId: "live-123", controlToken: "tok-1", decisions: new Map([["d1", { label: "Keep it", optionIndex: 0 }]]) });
		cleanups.push(bridge.stop);
		const client = new VoiceCallBridgeClient({ url: bridge.url, controlToken: "tok-1" });
		await client.connect();
		const ack = await client.resolveDecision({ decisionId: "d1", optionIndex: 0, label: "A DIFFERENT label the agent never showed" });
		expect(ack.ok).toBe(false);
		expect(ack.reason).toBe("label-mismatch");
	});

	test("bridge outage: an ack times out honestly rather than hanging forever", async () => {
		const bridge = startFakeBridge({ sessionId: "live-123", controlToken: "tok-1", decisions: new Map([["d1", { label: "Keep it", optionIndex: 0 }]]) });
		cleanups.push(bridge.stop);
		const client = new VoiceCallBridgeClient({ url: bridge.url, controlToken: "tok-1", ackTimeoutMs: 100 });
		await client.connect();
		bridge.stop(); // the process is gone; nothing will ever ack
		const ack = await client.resolveDecision({ decisionId: "d1", optionIndex: 0, label: "Keep it" });
		expect(ack.ok).toBe(false);
	});
});

describe("socket loss vs terminal frame", () => {
	test("an unexpected close (no terminal frame first) fires onSocketLoss, never onTerminal", async () => {
		const bridge = startFakeBridge({ sessionId: "live-123" });
		cleanups.push(bridge.stop);
		let socketLoss = 0;
		let terminal = 0;
		const client = new VoiceCallBridgeClient({ url: bridge.url, onSocketLoss: () => { socketLoss++; }, onTerminal: () => { terminal++; } });
		await client.connect();
		bridge.closeAll();
		await new Promise((r) => setTimeout(r, 100));
		expect(socketLoss).toBe(1);
		expect(terminal).toBe(0);
	});

	test("a terminal frame fires onTerminal with the session's own error", async () => {
		const bridge = startFakeBridge({ sessionId: "live-123" });
		cleanups.push(bridge.stop);
		let terminalError: string | null | undefined;
		const client = new VoiceCallBridgeClient({ url: bridge.url, onTerminal: (error) => { terminalError = error; } });
		await client.connect();
		bridge.sendTerminal("provider disconnected");
		await new Promise((r) => setTimeout(r, 50));
		expect(terminalError).toBe("provider disconnected");
		client.close();
	});
});

describe("unauthenticated controls", () => {
	test("steer/stop/toggleMute send without waiting for an ack", async () => {
		const bridge = startFakeBridge({ sessionId: "live-123" });
		cleanups.push(bridge.stop);
		const client = new VoiceCallBridgeClient({ url: bridge.url });
		await client.connect();
		expect(() => client.steer("focus on the auth module")).not.toThrow();
		expect(() => client.stop()).not.toThrow();
		expect(() => client.toggleMute()).not.toThrow();
		client.close();
	});
});
