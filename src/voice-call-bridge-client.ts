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
 */

const DEFAULT_ACK_TIMEOUT_MS = 8_000;
const DEFAULT_HELLO_TIMEOUT_MS = 10_000;

/** The subset of the real `WebSocket` surface this client needs — small enough to fake in tests
 *  without standing up a real socket, and satisfied unchanged by the platform's own `WebSocket`. */
export interface BridgeSocketLike {
	send(data: string): void;
	close(): void;
	set onopen(handler: (() => void) | null);
	set onmessage(handler: ((ev: { data: string }) => void) | null);
	set onclose(handler: (() => void) | null);
	set onerror(handler: ((ev: unknown) => void) | null);
}

export type BridgeConnectFn = (url: string) => BridgeSocketLike;

const defaultConnect: BridgeConnectFn = (url) => new WebSocket(url) as unknown as BridgeSocketLike;

export interface BridgeHelloFrame {
	sessionId: string;
	callId?: string;
	canResolve?: boolean;
	recordingMode?: "full" | "tails" | "off";
	decisions?: unknown[];
	interruptPolicy?: "allow" | "doNotInterrupt";
	[key: string]: unknown;
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
				reject(new Error(`bridge hello timed out after ${this.helloTimeoutMs}ms (${this.url})`));
			}, this.helloTimeoutMs);
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
				if (record.type === "controlAck" && typeof record.requestId === "string") {
					const waiter = this.pending.get(record.requestId);
					if (waiter) {
						this.pending.delete(record.requestId);
						clearTimeout(waiter.timer);
						waiter.resolve(record as unknown as BridgeControlAck);
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

	close(): void {
		this.rejectAllPending("client closed");
		try {
			this.socket?.close();
		} catch {
			/* already gone */
		}
	}
}
