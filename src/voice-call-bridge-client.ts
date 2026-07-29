/**
 * voice-call-bridge-client.ts — the daemon's WS client onto one call's Coven Bridge (concern 02).
 *
 * Speaks the additive control-plane surface `~/src/oh-my-pi`'s `coven-bridge.ts` implements
 * (`opencoven-viz/PROTOCOL.md` "The record and control plane"): `hello` on connect, directed
 * `controlAck` per authenticated `resolveDecision`/`setInterruptPolicy` request, and the three
 * unauthenticated controls (`stop`/`toggleMute`/`steer`). This is the ONLY place in the daemon that
 * holds the per-call control token and echoes it — the token itself never crosses any other boundary
 * (never returned by a daemon read API; see `voice-call-binding.ts#redactBinding`).
 *
 * `sessionId` pinning against "port reuse" happens ONE LAYER UP, in `VoiceCallCoordinator`: this
 * client reports whatever `sessionId` the `hello` frame actually carried, and the coordinator decides
 * whether that matches the binding's pinned identity. This class stays a dumb, testable wire client.
 *
 * Concern 09 (browser-audio-transport) extends this with the bridge's additive BINARY channel
 * (`opencoven-viz/PROTOCOL.md` "Browser audio transport"): `sendMicAudio` sends a `0x01`-tagged frame
 * of mic PCM towards the session, and `onAudioFrame` reports a `0x02`-tagged frame of decoded output
 * PCM the session sent back — never JSON, never counted against the bridge's own `seq`. Both are
 * no-ops/never-fired unless the call this client is talking to was started with `noLocalAudio`; the
 * coordinator one layer up is what enforces that (this class has no opinion on WHY audio is or isn't
 * flowing, only on how to move the bytes once asked to).
 *
 * Live captions fix (production defect, 2026-07-28): the bridge's `coven-bridge.ts` has ALWAYS
 * broadcast a `{type:"transcript",role,text,turn,final}` frame per utterance chunk — including
 * every non-final (`final:false`) partial as the agent speaks, replaced in place keyed `(role,turn)`
 * at the bridge itself (see `CovenBridge#publishTranscript`) — but this client never gave that frame
 * type a home: it fell through to the generic `onFrame` callback, which the coordinator never wired,
 * so partials were silently dropped. `onTranscriptFrame` gives it one, presentation-plane only (this
 * class never writes to the journal or the projection store — see `voice-call-manager.ts`'s own
 * `onLiveTranscriptFrame`/`onTranscriptTurn` split for why that boundary matters).
 */

const DEFAULT_ACK_TIMEOUT_MS = 8_000;
const DEFAULT_HELLO_TIMEOUT_MS = 10_000;

/** Binary WS frame tags — MUST match oh-my-pi's `coven-bridge.ts` exactly (PROTOCOL.md "Browser audio
 *  transport"). `0x01` is this client's OWN outbound tag (mic PCM, client→bridge); `0x02` is the one
 *  frame type this client ever expects to RECEIVE as binary (decoded output PCM, bridge→client). */
const MIC_AUDIO_FRAME_TAG = 0x01;
const OUTPUT_AUDIO_FRAME_TAG = 0x02;

/** The subset of the real `WebSocket` surface this client needs — small enough to fake in tests
 *  without standing up a real socket, and satisfied unchanged by the platform's own `WebSocket`.
 *  `send` and `onmessage.data` both widen to binary (concern 09) alongside the pre-existing string
 *  JSON path — additive, so every existing fake/test that only ever used strings keeps compiling. */
export interface BridgeSocketLike {
	send(data: string | Uint8Array): void;
	close(): void;
	set onopen(handler: (() => void) | null);
	set onmessage(handler: ((ev: { data: string | ArrayBuffer | Uint8Array }) => void) | null);
	set onclose(handler: (() => void) | null);
	set onerror(handler: ((ev: unknown) => void) | null);
}

export type BridgeConnectFn = (url: string) => BridgeSocketLike;

const defaultConnect: BridgeConnectFn = (url) => {
	const ws = new WebSocket(url);
	// Binary frames arrive as ArrayBuffer, not Blob — set explicitly rather than trust the platform
	// default (browsers default to "blob"; this daemon runs under Bun/Node, where the global
	// WebSocket already defaults to "arraybuffer", but a future runtime change should not silently
	// turn every output-audio frame into an unreadable Blob).
	ws.binaryType = "arraybuffer";
	return ws as unknown as BridgeSocketLike;
};

/** Normalizes whatever a binary WS frame arrived as into one `Uint8Array` view — `ArrayBuffer`
 *  (the platform `WebSocket` with `binaryType: "arraybuffer"`) or an already-typed `Uint8Array`
 *  (a test double, or a Node/Bun `Buffer`, which IS a `Uint8Array` subclass). */
function toBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
	return data instanceof Uint8Array ? data : new Uint8Array(data);
}

export interface BridgeHelloFrame {
	sessionId: string;
	callId?: string;
	canResolve?: boolean;
	recordingMode?: "full" | "tails" | "off";
	decisions?: unknown[];
	interruptPolicy?: "allow" | "doNotInterrupt";
	/** Concern 12 (voice-fleet-delegation): the bridge accepts `attachFleet`/`fleetResult` and can
	 *  send directed `fleetCall` frames. Absent against a TUI or pre-concern-12 bridge — feature-off,
	 *  the daemon never attempts an attach it would be refused. */
	canFleet?: boolean;
	[key: string]: unknown;
}

/** One directed `fleetCall` frame — the session asking THIS daemon (the attached executor) to run
 *  one fleet tool call. `args` is narrowed by `voice-fleet.ts`'s `parseVoiceFleetArgs`, not here —
 *  this class stays a dumb wire client (see the module doc). */
export interface BridgeFleetCall {
	fleetCallId: string;
	tool: string;
	args: unknown;
}

/** One `{type:"transcript",...}` presentation frame off the bridge — a chunk of one utterance,
 *  possibly still in progress (`final:false`). Shape matches `coven-bridge.ts`'s own `TranscriptEntry`
 *  minus `callId`/`at`, which this client does not know (the coordinator, which does, stamps them). */
export interface BridgeTranscriptFrame {
	role: "user" | "assistant";
	text: string;
	turn: number;
	final: boolean;
}

export interface BridgeControlAck {
	requestId: string;
	ok: boolean;
	reason?: string;
	decision?: unknown;
	confirmToken?: string;
}

export interface BridgeClientOptions {
	url: string;
	/** Daemon-held per-call token, echoed on every authenticated control frame. Undefined only for a
	 *  bare bridge with no broker in front of it (never true for a daemon-started call). */
	controlToken?: string;
	/** The binding's own pinned `sessionId`, sent as the SESSION CHECK on every authenticated control
	 *  frame (PROTOCOL.md's "Session check" — guards against a request meant for a call that has
	 *  since restarted). Absent on the FIRST connect, before anything is pinned yet. */
	sessionId?: string;
	onHello?: (hello: BridgeHelloFrame) => void;
	onTerminal?: (error: string | null) => void;
	/** Fired when the socket closes WITHOUT a preceding `terminal` frame — the honest "socket loss"
	 *  signal (as opposed to `onTerminal`, which means the session itself said it ended). */
	onSocketLoss?: (err?: unknown) => void;
	onFrame?: (frame: Record<string, unknown>) => void;
	/** Fired for every `{type:"transcript"}` frame the bridge broadcasts — one per utterance chunk,
	 *  final or not (live captions fix, see the module doc). Malformed shapes (missing/wrong-typed
	 *  role/text/turn/final) are dropped before this fires, same discipline as `onFleetCall`. */
	onTranscriptFrame?: (frame: BridgeTranscriptFrame) => void;
	/** Concern 09: fired for a `0x02`-tagged binary frame — one chunk of decoded output PCM the
	 *  session sent back, with the tag byte already stripped. Never fired for anything else (a
	 *  same-tagged frame arriving mistagged, or one this client did not itself send, is simply the
	 *  ONE tag it forwards; `0x01` — its own outbound tag — arriving inbound would be a bridge bug,
	 *  and is dropped rather than trusted). */
	onAudioFrame?: (bytes: Uint8Array) => void;
	/** Concern 12: fired once per directed `fleetCall` frame (this client is the attached
	 *  executor). Malformed frames (no string `fleetCallId`/`tool`) are dropped before this fires,
	 *  same discipline as every other inbound shape on this socket. */
	onFleetCall?: (call: BridgeFleetCall) => void;
	connect?: BridgeConnectFn;
	ackTimeoutMs?: number;
	helloTimeoutMs?: number;
}

export interface ResolveDecisionInput {
	decisionId: string;
	optionIndex: number;
	label: string;
	confirmToken?: string;
}

let requestSeq = 0;
function nextRequestId(): string {
	requestSeq += 1;
	return `req-${Date.now().toString(36)}-${requestSeq}`;
}

/** One connection to one call's bridge. `connect()` resolves once `hello` arrives (or rejects on
 *  error/timeout); every other method requires a prior successful `connect()`. */
export class VoiceCallBridgeClient {
	private readonly url: string;
	private readonly controlToken: string | undefined;
	private sessionId: string | undefined;
	private readonly onHello: ((hello: BridgeHelloFrame) => void) | undefined;
	private readonly onTerminal: ((error: string | null) => void) | undefined;
	private readonly onSocketLoss: ((err?: unknown) => void) | undefined;
	private readonly onFrame: ((frame: Record<string, unknown>) => void) | undefined;
	private readonly onTranscriptFrame: ((frame: BridgeTranscriptFrame) => void) | undefined;
	private readonly onAudioFrame: ((bytes: Uint8Array) => void) | undefined;
	private readonly onFleetCall: ((call: BridgeFleetCall) => void) | undefined;
	private readonly connectFn: BridgeConnectFn;
	private readonly ackTimeoutMs: number;
	private readonly helloTimeoutMs: number;
	private socket: BridgeSocketLike | undefined;
	private terminated = false;
	private readonly pending = new Map<string, { resolve: (ack: BridgeControlAck) => void; timer: ReturnType<typeof setTimeout> }>();

	constructor(opts: BridgeClientOptions) {
		this.url = opts.url;
		this.controlToken = opts.controlToken;
		this.sessionId = opts.sessionId;
		this.onHello = opts.onHello;
		this.onTerminal = opts.onTerminal;
		this.onSocketLoss = opts.onSocketLoss;
		this.onFrame = opts.onFrame;
		this.onTranscriptFrame = opts.onTranscriptFrame;
		this.onAudioFrame = opts.onAudioFrame;
		this.onFleetCall = opts.onFleetCall;
		this.connectFn = opts.connect ?? defaultConnect;
		this.ackTimeoutMs = opts.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
		this.helloTimeoutMs = opts.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
	}

	connect(): Promise<BridgeHelloFrame> {
		return new Promise((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				// A hello that never arrives leaves the socket half-open with nothing left to wait for —
				// close it here rather than leaking an open connection (matches `pinSession` rejection's
				// own `client.close()` a few lines down in the caller for the same reason). Detach the
				// handlers FIRST — this rejection already tells the caller everything it needs to know, so
				// the close this triggers must not ALSO fire `onSocketLoss` a tick later (that would be a
				// second, redundant "the connection died" signal for what is really just an abandoned
				// connect attempt).
				try {
					if (socket) {
						socket.onclose = null;
						socket.onerror = null;
						socket.onmessage = null;
						socket.close();
					}
				} catch {
					/* already gone */
				}
				reject(new Error(`bridge hello timed out after ${this.helloTimeoutMs}ms (${this.url})`));
			}, this.helloTimeoutMs);
			timer.unref?.(); // every other timer in this codebase does this (voice-call-journal.ts, voice-call-manager.ts, etc.) — a pending hello must never keep the process/test-runner alive.
			let socket: BridgeSocketLike;
			try {
				socket = this.connectFn(this.url);
			} catch (err) {
				clearTimeout(timer);
				reject(err);
				return;
			}
			this.socket = socket;
			socket.onerror = (err) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					// Detach + close exactly like the hello-timeout path above: this rejection already
					// tells the caller everything it needs to know, so a LATER `onclose` from this same
					// abandoned socket (many WebSocket implementations fire error then close) must never
					// ALSO fire `onSocketLoss` as a second, redundant "the connection died" signal.
					try {
						socket.onclose = null;
						socket.onerror = null;
						socket.onmessage = null;
						socket.close();
					} catch {
						/* already gone */
					}
					reject(err instanceof Error ? err : new Error(`bridge socket error: ${String(err)}`));
					return;
				}
				this.onSocketLoss?.(err);
			};
			socket.onclose = () => {
				this.rejectAllPending("socket closed");
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					reject(new Error("bridge socket closed before hello"));
					return;
				}
				if (!this.terminated) this.onSocketLoss?.();
			};
			socket.onmessage = (ev) => {
				// Concern 09: a binary frame is ALWAYS audio (the JSON control/presentation protocol is
				// text-only on this wire, matching oh-my-pi's own `coven-bridge.ts`) — handled on its own
				// path, never fed to `JSON.parse`, which only ever sees a string.
				if (typeof ev.data !== "string") {
					this.handleAudioFrame(toBytes(ev.data));
					return;
				}
				let frame: unknown;
				try {
					frame = JSON.parse(ev.data);
				} catch {
					return;
				}
				if (!frame || typeof frame !== "object") return;
				const record = frame as Record<string, unknown>;
				if (record.type === "hello") {
					const hello = record as unknown as BridgeHelloFrame;
					this.sessionId = hello.sessionId;
					if (!settled) {
						settled = true;
						clearTimeout(timer);
						this.onHello?.(hello);
						resolve(hello);
						return;
					}
					this.onHello?.(hello);
					return;
				}
				if (record.type === "terminal") {
					this.terminated = true;
					const error = typeof record.error === "string" ? record.error : null;
					this.onTerminal?.(error);
					return;
				}
				if (record.type === "fleetCall") {
					// Concern 12: a directed fleet tool call for this executor. Narrowed here (string
					// fleetCallId/tool) so the coordinator's handler never sees a malformed frame.
					if (typeof record.fleetCallId === "string" && record.fleetCallId && typeof record.tool === "string") {
						this.onFleetCall?.({ fleetCallId: record.fleetCallId, tool: record.tool, args: record.args });
					}
					return;
				}
				if (record.type === "controlAck" && typeof record.requestId === "string") {
					const waiter = this.pending.get(record.requestId);
					if (waiter) {
						this.pending.delete(record.requestId);
						clearTimeout(waiter.timer);
						waiter.resolve(record as unknown as BridgeControlAck);
					}
					return;
				}
				if (record.type === "transcript") {
					// Live captions fix: narrowed here (string role limited to the two known values, string
					// text, numeric turn, boolean final) so the coordinator's handler never sees a malformed
					// frame — same discipline as the `fleetCall` branch above.
					if (
						(record.role === "user" || record.role === "assistant") &&
						typeof record.text === "string" &&
						typeof record.turn === "number" &&
						typeof record.final === "boolean"
					) {
						this.onTranscriptFrame?.({ role: record.role, text: record.text, turn: record.turn, final: record.final });
					}
					return;
				}
				this.onFrame?.(record);
			};
		});
	}

	private rejectAllPending(reason: string): void {
		for (const [id, waiter] of this.pending) {
			clearTimeout(waiter.timer);
			waiter.resolve({ requestId: id, ok: false, reason });
		}
		this.pending.clear();
	}

	private send(frame: Record<string, unknown>): void {
		if (!this.socket) throw new Error("bridge client not connected");
		this.socket.send(JSON.stringify(frame));
	}

	/**
	 * One binary frame arriving from the bridge (concern 09). Only `OUTPUT_AUDIO_FRAME_TAG` is
	 * accepted — this client's OWN tag (`MIC_AUDIO_FRAME_TAG`) arriving INBOUND would mean the bridge
	 * echoed this client's own frame back, which is not a thing PROTOCOL.md's wire does; dropped
	 * rather than trusted, same discipline as every other malformed/unexpected input on this socket.
	 * A frame with no payload past the tag byte (an empty chunk) is dropped too — there is nothing to
	 * forward.
	 */
	private handleAudioFrame(bytes: Uint8Array): void {
		if (bytes.length < 2 || bytes[0] !== OUTPUT_AUDIO_FRAME_TAG) return;
		this.onAudioFrame?.(bytes.subarray(1));
	}

	/**
	 * Sends one chunk of microphone PCM towards the session (concern 09) — mono 16 kHz `Float32`, the
	 * exact format oh-my-pi's own `AudioCapture`/`pushRemoteAudio` use, tagged `MIC_AUDIO_FRAME_TAG`
	 * per PROTOCOL.md. Unauthenticated on the wire, like `steer`/`stop`/`toggleMute` above — the
	 * coordinator one layer up is what decides whether THIS call is even in `noLocalAudio` mode before
	 * ever calling this; this class only knows how to move the bytes once asked.
	 */
	sendMicAudio(samples: Float32Array): void {
		if (!this.socket) throw new Error("bridge client not connected");
		const payload = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
		const frame = new Uint8Array(1 + payload.length);
		frame[0] = MIC_AUDIO_FRAME_TAG;
		frame.set(payload, 1);
		this.socket.send(frame);
	}

	private sendAuthenticated(action: string, extra: Record<string, unknown>): Promise<BridgeControlAck> {
		const requestId = nextRequestId();
		const frame: Record<string, unknown> = { v: 1, type: "control", action, requestId, ...extra };
		if (this.controlToken !== undefined) frame.token = this.controlToken;
		if (this.sessionId !== undefined) frame.sessionId = this.sessionId;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(requestId);
				resolve({ requestId, ok: false, reason: "ack-timeout" });
			}, this.ackTimeoutMs);
			timer.unref?.(); // same hygiene as the hello timer above — an outstanding ack must never keep the process alive.
			this.pending.set(requestId, { resolve, timer });
			try {
				this.send(frame);
			} catch (err) {
				this.pending.delete(requestId);
				clearTimeout(timer);
				resolve({ requestId, ok: false, reason: err instanceof Error ? err.message : String(err) });
			}
		});
	}

	resolveDecision(input: ResolveDecisionInput): Promise<BridgeControlAck> {
		return this.sendAuthenticated("resolveDecision", {
			decisionId: input.decisionId,
			optionIndex: input.optionIndex,
			label: input.label,
			...(input.confirmToken !== undefined ? { confirmToken: input.confirmToken } : {}),
		});
	}

	setInterruptPolicy(policy: "allow" | "doNotInterrupt"): Promise<BridgeControlAck> {
		return this.sendAuthenticated("setInterruptPolicy", { policy });
	}

	/** Concern 12: register THIS client as the call's fleet executor, optionally seeding the
	 *  session with a room-context brief. Authenticated like `resolveDecision` — the token this
	 *  daemon already holds is what makes it, and nothing else on the loopback, the fleet. */
	attachFleet(context?: string): Promise<BridgeControlAck> {
		return this.sendAuthenticated("attachFleet", context === undefined ? {} : { context });
	}

	/** Concern 12: answer one directed `fleetCall`. `result` is the executor's already-shaped wire
	 *  result (`voice-fleet.ts`'s `VoiceFleetWireResult`) — this class moves it, never inspects it. */
	sendFleetResult(fleetCallId: string, result: unknown): Promise<BridgeControlAck> {
		return this.sendAuthenticated("fleetResult", { fleetCallId, result });
	}

	/** Unauthenticated, like the visualizer's own `esc`/`space`/steer controls — no token/session
	 *  fields, matching PROTOCOL.md exactly (`stop`/`toggleMute`/`steer` predate the record/control
	 *  plane and stay unauthenticated so a v1 client keeps working unmodified). */
	steer(text: string): void {
		this.send({ v: 1, type: "control", action: "steer", text });
	}

	stop(): void {
		this.send({ v: 1, type: "control", action: "stop" });
	}

	toggleMute(): void {
		this.send({ v: 1, type: "control", action: "toggleMute" });
	}

	/** Intentional close — used by the coordinator on every path that decides THIS bridge socket is
	 *  done (port reuse, end of call, runtime teardown). Detaches the socket's own handlers BEFORE
	 *  closing it: an async close can otherwise still fire `onclose` a tick later, which (since
	 *  `settled` is already true by the time anyone calls `close()`) would read as `onSocketLoss` — a
	 *  spurious "degraded" signal racing in AFTER the caller has already announced whatever card this
	 *  close was part of (e.g. the "ended" card from a port-reused rejection). */
	close(): void {
		this.rejectAllPending("client closed");
		try {
			if (this.socket) {
				this.socket.onclose = null;
				this.socket.onerror = null;
				this.socket.onmessage = null;
			}
			this.socket?.close();
		} catch {
			/* already gone */
		}
	}
}
