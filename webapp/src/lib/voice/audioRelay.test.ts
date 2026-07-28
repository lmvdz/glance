import { afterEach, describe, expect, test } from "bun:test";
import { connectVoiceCallAudio, micPermissionErrorMessage, parseVoiceAudioStatusFrame } from "./audioRelay";

/**
 * concern 09 (browser-audio-transport) — the wire logic this module owns: status-frame parsing,
 * the WS connection's own state transitions, and mic/output frame plumbing. `startMicCapture`/
 * `startAudioPlayback` (real `getUserMedia`/`AudioContext`/`AudioWorklet`) are deliberately NOT
 * covered here — see their own doc comments in `audioRelay.ts` for why.
 */

describe("parseVoiceAudioStatusFrame", () => {
	test("recognizes voiceAudioReady", () => {
		expect(parseVoiceAudioStatusFrame(JSON.stringify({ type: "voiceAudioReady" }))).toEqual({ status: "ready" });
	});

	test("recognizes voiceAudioError with its reason", () => {
		expect(parseVoiceAudioStatusFrame(JSON.stringify({ type: "voiceAudioError", reason: "device-audio-call" }))).toEqual({
			status: "refused",
			reason: "device-audio-call",
		});
	});

	test("a voiceAudioError with no reason field falls back to a generic reason, never throws", () => {
		expect(parseVoiceAudioStatusFrame(JSON.stringify({ type: "voiceAudioError" }))).toEqual({ status: "refused", reason: "refused" });
	});

	test("malformed JSON, non-object JSON, and an unrecognized type are all dropped as undefined", () => {
		expect(parseVoiceAudioStatusFrame("not json {{{")).toBeUndefined();
		expect(parseVoiceAudioStatusFrame("42")).toBeUndefined();
		expect(parseVoiceAudioStatusFrame('"a string"')).toBeUndefined();
		expect(parseVoiceAudioStatusFrame(JSON.stringify({ type: "somethingElse" }))).toBeUndefined();
	});
});

describe("micPermissionErrorMessage", () => {
	test("maps known DOMException names to specific, honest copy", () => {
		expect(micPermissionErrorMessage(new DOMException("x", "NotAllowedError"))).toBe("Microphone access was denied.");
		expect(micPermissionErrorMessage(new DOMException("x", "NotFoundError"))).toBe("No microphone was found on this device.");
		expect(micPermissionErrorMessage(new DOMException("x", "NotReadableError"))).toContain("in use by another application");
	});

	test("an unrecognized error still surfaces something specific, never a bare generic string", () => {
		expect(micPermissionErrorMessage(new Error("weird platform failure"))).toBe("weird platform failure");
		expect(micPermissionErrorMessage("not even an Error")).toBe("The microphone could not be opened.");
	});
});

describe("connectVoiceCallAudio", () => {
	const originalWebSocket = globalThis.WebSocket;
	const originalLocation = globalThis.location;

	afterEach(() => {
		Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: originalWebSocket });
		Object.defineProperty(globalThis, "location", { configurable: true, value: originalLocation });
	});

	class FakeSocket {
		static OPEN = 1;
		static CONNECTING = 0;
		readyState = FakeSocket.CONNECTING;
		binaryType = "blob";
		sentFrames: unknown[] = [];
		closed = false;
		onopen?: () => void;
		onmessage?: (event: { data: string | ArrayBuffer }) => void;
		onclose?: () => void;
		onerror?: () => void;
		readonly url: string;
		readonly protocols: string[] | undefined;
		constructor(url: string, protocols?: string[]) {
			this.url = url;
			this.protocols = protocols;
		}
		send(value: unknown) {
			this.sentFrames.push(value);
		}
		close() {
			this.closed = true;
			this.readyState = 3;
		}
	}

	function install(): { instances: FakeSocket[] } {
		const instances: FakeSocket[] = [];
		class TrackedFakeSocket extends FakeSocket {
			constructor(url: string, protocols?: string[]) {
				super(url, protocols);
				instances.push(this);
			}
		}
		Object.defineProperty(globalThis, "location", { configurable: true, value: { protocol: "http:", host: "localhost" } });
		Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: TrackedFakeSocket });
		return { instances };
	}

	test("connects to the per-channel audio path and reports 'connecting' immediately", () => {
		const { instances } = install();
		const statuses: Array<[string, string | undefined]> = [];
		connectVoiceCallAudio("room-1", { onStatus: (s, r) => statuses.push([s, r]), onOutputAudio: () => {} });
		expect(instances[0]?.url).toBe("ws://localhost/api/channels/room-1/voice-call/audio");
		expect(statuses).toEqual([["connecting", undefined]]);
	});

	test("channelId is URL-encoded", () => {
		const { instances } = install();
		connectVoiceCallAudio("room/weird id", { onStatus: () => {}, onOutputAudio: () => {} });
		expect(instances[0]?.url).toBe("ws://localhost/api/channels/room%2Fweird%20id/voice-call/audio");
	});

	test("a voiceAudioReady text frame flips status to 'ready'", () => {
		const { instances } = install();
		const statuses: string[] = [];
		connectVoiceCallAudio("room-1", { onStatus: (s) => statuses.push(s), onOutputAudio: () => {} });
		instances[0]!.onmessage?.({ data: JSON.stringify({ type: "voiceAudioReady" }) });
		expect(statuses).toEqual(["connecting", "ready"]);
	});

	test("a voiceAudioError text frame flips status to 'refused' with the daemon's own reason", () => {
		const { instances } = install();
		const statuses: Array<[string, string | undefined]> = [];
		connectVoiceCallAudio("room-1", { onStatus: (s, r) => statuses.push([s, r]), onOutputAudio: () => {} });
		instances[0]!.onmessage?.({ data: JSON.stringify({ type: "voiceAudioError", reason: "device-audio-call" }) });
		expect(statuses).toEqual([
			["connecting", undefined],
			["refused", "device-audio-call"],
		]);
	});

	test("a binary frame reaches onOutputAudio as bytes, untouched by the status parser", () => {
		const { instances } = install();
		const received: Uint8Array[] = [];
		connectVoiceCallAudio("room-1", { onStatus: () => {}, onOutputAudio: (bytes) => received.push(bytes) });
		const payload = new Uint8Array([1, 2, 3, 4]).buffer;
		instances[0]!.onmessage?.({ data: payload });
		expect(received).toHaveLength(1);
		expect([...received[0]!]).toEqual([1, 2, 3, 4]);
	});

	test("sendMic writes directly to the socket once OPEN, and is a silent no-op before/after", () => {
		const { instances } = install();
		const handle = connectVoiceCallAudio("room-1", { onStatus: () => {}, onOutputAudio: () => {} });
		const samples = new Float32Array([0.1, 0.2]);
		handle.sendMic(samples); // not yet OPEN — dropped, not queued (audio has no "catch up later" story)
		expect(instances[0]!.sentFrames).toHaveLength(0);
		instances[0]!.readyState = FakeSocket.OPEN;
		handle.sendMic(samples);
		expect(instances[0]!.sentFrames).toEqual([samples]);
		handle.close();
		handle.sendMic(samples); // after close() — still a no-op, never throws
		expect(instances[0]!.sentFrames).toHaveLength(1);
	});

	test("close() sets binaryType to arraybuffer before anything else can matter, and does not itself report 'closed'", () => {
		const { instances } = install();
		const statuses: string[] = [];
		const handle = connectVoiceCallAudio("room-1", { onStatus: (s) => statuses.push(s), onOutputAudio: () => {} });
		expect(instances[0]!.binaryType).toBe("arraybuffer");
		handle.close();
		expect(instances[0]!.closed).toBe(true);
		// A caller-initiated close is expected, not a surprise loss — this relay does not report a
		// SECOND transition for its own close() call (unlike an unexpected onclose from the socket).
		expect(statuses).toEqual(["connecting"]);
	});

	test("an unexpected close (the daemon dropped the socket, not us) reports 'closed'", () => {
		const { instances } = install();
		const statuses: string[] = [];
		connectVoiceCallAudio("room-1", { onStatus: (s) => statuses.push(s), onOutputAudio: () => {} });
		instances[0]!.onclose?.();
		expect(statuses).toEqual(["connecting", "closed"]);
	});
});
