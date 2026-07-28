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
	onmessage: ((ev: { data: string | ArrayBuffer | Uint8Array }) => void) | null = null;
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

/** Copies a byte view into a fresh, 4-byte-aligned buffer so it can be safely read as `Float32Array`
 *  — `subarray(1)` (stripping a 1-byte tag) shifts the byte offset by 1, which `Float32Array`'s
 *  constructor rejects as unaligned regardless of the view's total length. */
function asFloat32(bytes: Uint8Array): Float32Array {
	const aligned = new Uint8Array(bytes.length);
	aligned.set(bytes);
	return new Float32Array(aligned.buffer);
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

describe("browser audio transport (concern 09) — binary frames alongside the JSON control protocol", () => {
	/** A fake bridge that also understands the two binary audio tags — `0x01` (mic, client→bridge,
	 *  echoed back verbatim as a `0x02` output frame so the test can observe the round trip) and
	 *  records every raw binary frame it received. */
	function startFakeAudioBridge(sessionId: string) {
		const received: Uint8Array[] = [];
		const sockets = new Set<{ send(data: string | Uint8Array): void }>();
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(req, srv) {
				if (srv.upgrade(req)) return undefined;
				return new Response("ws only", { status: 426 });
			},
			websocket: {
				open(ws) {
					sockets.add(ws as unknown as { send(data: string | Uint8Array): void });
					ws.send(JSON.stringify({ v: 1, sessionId, seq: 0, type: "hello", canResolve: true }));
				},
				message(ws, message) {
					if (typeof message === "string") return; // this fake only exercises the binary path
					const bytes = new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
					received.push(bytes.slice()); // detach from the (possibly pooled) underlying buffer
					if (bytes[0] !== 0x01) return; // only the client's own mic tag gets echoed back
					const echoed = new Uint8Array(bytes.length);
					echoed[0] = 0x02; // re-tagged as the server→client output-audio tag
					echoed.set(bytes.subarray(1), 1);
					ws.send(echoed);
				},
				close(ws) {
					sockets.delete(ws as unknown as { send(data: string | Uint8Array): void });
				},
			},
		});
		return {
			url: `ws://127.0.0.1:${server.port}`,
			received,
			stop: () => server.stop(true),
		};
	}

	test("sendMicAudio tags the frame 0x01 and carries the exact Float32 bytes sent", async () => {
		const bridge = startFakeAudioBridge("live-audio-1");
		cleanups.push(bridge.stop);
		const client = new VoiceCallBridgeClient({ url: bridge.url });
		await client.connect();
		const samples = new Float32Array([0.1, -0.2, 0.3, -0.4]);
		client.sendMicAudio(samples);
		await new Promise((r) => setTimeout(r, 100));
		expect(bridge.received).toHaveLength(1);
		expect(bridge.received[0]?.[0]).toBe(0x01);
		const payload = bridge.received[0]?.subarray(1) ?? new Uint8Array();
		expect(asFloat32(payload)).toEqual(samples);
		client.close();
	});

	test("a 0x02-tagged inbound frame reaches onAudioFrame with the tag byte stripped", async () => {
		const bridge = startFakeAudioBridge("live-audio-2");
		cleanups.push(bridge.stop);
		const frames: Uint8Array[] = [];
		const client = new VoiceCallBridgeClient({ url: bridge.url, onAudioFrame: (bytes) => frames.push(bytes) });
		await client.connect();
		client.sendMicAudio(new Float32Array([0.5, -0.5])); // the fake bridge echoes this back re-tagged 0x02
		await new Promise((r) => setTimeout(r, 100));
		expect(frames).toHaveLength(1);
		expect(asFloat32(frames[0]!)).toEqual(new Float32Array([0.5, -0.5]));
		client.close();
	});

	test("audio frames and JSON control frames coexist on the same socket without disturbing each other", async () => {
		const bridge = startFakeAudioBridge("live-audio-3");
		cleanups.push(bridge.stop);
		const frames: Uint8Array[] = [];
		const client = new VoiceCallBridgeClient({ url: bridge.url, onAudioFrame: (bytes) => frames.push(bytes) });
		await client.connect();
		client.sendMicAudio(new Float32Array([0.25]));
		expect(() => client.toggleMute()).not.toThrow(); // a JSON control frame, interleaved
		client.sendMicAudio(new Float32Array([0.75]));
		await new Promise((r) => setTimeout(r, 100));
		expect(frames).toHaveLength(2); // both mic frames echoed back as output-audio frames
		expect(bridge.received.filter((b) => b[0] === 0x01)).toHaveLength(2);
		client.close();
	});

	test("a malformed inbound binary frame (wrong tag, or too short to carry a tag at all) never reaches onAudioFrame, never throws", async () => {
		const frames: Uint8Array[] = [];
		const socket = new FakeSocket();
		const client = new VoiceCallBridgeClient({ url: "ws://fake", connect: () => socket, onAudioFrame: (bytes) => frames.push(bytes) });
		const pending = client.connect();
		socket.onmessage?.({ data: JSON.stringify({ v: 1, sessionId: "s1", seq: 0, type: "hello", canResolve: true }) });
		await pending;
		expect(() => socket.onmessage?.({ data: new Uint8Array([0x01, 9, 9, 9]) })).not.toThrow(); // the client's OWN outbound tag, arriving inbound
		expect(() => socket.onmessage?.({ data: new Uint8Array([0x02]) })).not.toThrow(); // right tag, no payload at all
		expect(() => socket.onmessage?.({ data: new Uint8Array(0) })).not.toThrow(); // empty frame
		expect(frames).toHaveLength(0);
		client.close();
	});

	test("sendMicAudio throws before connect(), exactly like the JSON controls do", () => {
		const client = new VoiceCallBridgeClient({ url: "ws://fake" });
		expect(() => client.sendMicAudio(new Float32Array([0.1]))).toThrow();
	});
});
