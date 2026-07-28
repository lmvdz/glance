/**
 * fake-omp-call.ts — a protocol-accurate, self-contained stand-in for ONE `omp live` call: a real
 * `Bun.serve` WebSocket bridge speaking the exact wire shape `~/src/oh-my-pi`'s `CovenBridge` does
 * (opencoven-viz/PROTOCOL.md) plus a real append-only journal file on disk, with an embedded
 * decision-arbiter clone that mirrors `oh-my-pi/packages/coding-agent/src/live/decision-arbiter.ts`'s
 * state machine closely enough to exercise races, duplicates, staleness, and confirmation honestly.
 *
 * This exists because concern 02/03's own daemon tests (tests/voice-call-bridge-client.test.ts,
 * tests/voice-call-manager.test.ts) each hand-rolled their OWN much simpler one-off fake bridge —
 * neither supports the confirmation two-step, duplicate-request detection, or origin/token
 * enforcement a genuine acceptance spine needs. This is that harness, built once, exported for reuse,
 * per the concern-04 survey's recommendation. It intentionally reimplements the OMP-side protocol
 * rather than importing `~/src/oh-my-pi` directly, so the daemon test suite never depends on a
 * sibling checkout existing on disk — see `tests/voice-acceptance-spine.test.ts`'s separate
 * `test.skipIf(!ompCheckoutPresent)` block for the smoke path against the REAL checkout.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import * as path from "node:path";
import type { BrokerCallCreated, BrokerCallView, BrokerClient } from "../../src/voice-call-manager.ts";
import type { VoiceCallRetention } from "../../src/voice-call-binding.ts";

export interface FakeDecisionOption {
	index: number;
	label: string;
	consequence: string;
}

export type FakeDecisionState = "open" | "awaiting-confirmation" | "answered" | "expired" | "cancelled" | "failed";

export interface FakeDecisionResolution {
	optionIndex: number;
	label: string;
	source: "voice" | "ui";
}

export interface FakeDecisionSnapshot {
	id: string;
	prompt: string;
	options: FakeDecisionOption[];
	requiresConfirmation: boolean;
	state: FakeDecisionState;
	createdAt: number;
	updatedAt: number;
	resolution?: FakeDecisionResolution;
}

export type FakeDecisionRejectionReason =
	| "not-found"
	| "not-open"
	| "not-awaiting-confirmation"
	| "invalid-option"
	| "label-mismatch"
	| "duplicate-request"
	| "wrong-request-id"
	| "already-terminal";

export type FakeDecisionResult =
	| { ok: true; decision: FakeDecisionSnapshot; confirmToken?: string }
	| { ok: false; reason: FakeDecisionRejectionReason; decision?: FakeDecisionSnapshot };

export interface MintDecisionInput {
	prompt: string;
	options: readonly FakeDecisionOption[];
	requiresConfirmation?: boolean;
}

export interface ResolveDecisionInput {
	decisionId: string;
	optionIndex: number;
	label: string;
	source: "voice" | "ui";
	requestId: string;
}

export interface ConfirmDecisionInput {
	decisionId: string;
	confirmToken: string;
	requestId: string;
}

export interface FakeOmpCallOptions {
	sessionId: string;
	journalPath: string;
	controlToken?: string;
	allowedOrigins?: string[];
	recordingMode?: "full" | "tails" | "off";
	port?: number;
	now?: () => number;
	idFactory?: () => string;
}

let idSeq = 0;
function defaultId(): string {
	idSeq += 1;
	return `fake-decision-${idSeq}`;
}

interface PendingConfirmation {
	optionIndex: number;
	label: string;
	source: "voice" | "ui";
	confirmToken: string;
}

/**
 * One fake `omp live` call: bridge + journal + arbiter, together, as one process would own them.
 *
 * All the presentation/journal-writing methods (`mintDecision`, `resolveVoice`, `confirmVoice`,
 * `publishTranscript`, `publishArtifact`, `publishTerminal`) mirror what the real controller does:
 * write the journal record FIRST (write-before-act, journal.ts's own contract), then broadcast the
 * bridge frame. `crash()` and `deleteJournalFile()` deliberately skip that contract — they exist to
 * simulate the dishonest failure modes (OMP dying without a terminal record, the journal file itself
 * disappearing) the daemon must detect rather than paper over.
 */
export class FakeOmpCall {
	readonly sessionId: string;
	readonly journalPath: string;
	readonly recordingMode: "full" | "tails" | "off";
	private readonly controlToken: string | undefined;
	private readonly allowedOrigins: Set<string> | undefined;
	private readonly now: () => number;
	private readonly idFactory: () => string;

	private server: ReturnType<typeof Bun.serve> | undefined;
	private sockets = new Set<{ send(data: string): unknown }>();
	private bridgeSeq = 0;
	private journalSeq = 0;
	private closed = false;
	private muted = false;
	private interruptPolicy: "allow" | "doNotInterrupt" = "allow";

	private decisions = new Map<string, FakeDecisionSnapshot>();
	private pendingConfirm = new Map<string, PendingConfirmation>();
	private seenRequests = new Map<string, Set<string>>();
	/** Per-decision serialization so a raced voice/UI resolve always resolves in FIFO order, exactly
	 *  like the real arbiter's own `#chains` — otherwise two `await`s racing this class's methods
	 *  directly (no wire involved for the voice side) could interleave unpredictably in the test. */
	private chains = new Map<string, Promise<unknown>>();

	constructor(opts: FakeOmpCallOptions) {
		this.sessionId = opts.sessionId;
		this.journalPath = opts.journalPath;
		this.controlToken = opts.controlToken;
		this.allowedOrigins = opts.allowedOrigins && opts.allowedOrigins.length > 0 ? new Set(opts.allowedOrigins) : undefined;
		this.recordingMode = opts.recordingMode ?? "full";
		this.now = opts.now ?? Date.now;
		this.idFactory = opts.idFactory ?? defaultId;
		mkdirSync(path.dirname(this.journalPath), { recursive: true });
		writeFileSyncEmpty(this.journalPath);
		this.server = Bun.serve({
			port: opts.port ?? 0,
			hostname: "127.0.0.1",
			fetch: (request, server) => {
				const origin = request.headers.get("origin");
				if (this.allowedOrigins && origin && !this.allowedOrigins.has(origin)) {
					return new Response("fake omp call: origin not allowed", { status: 403 });
				}
				if (server.upgrade(request, { data: undefined })) return undefined;
				return new Response("ws only", { status: 426 });
			},
			websocket: {
				open: (ws) => {
					this.sockets.add(ws);
					this.sendTo(ws, {
						type: "hello",
						phase: "listening",
						muted: this.muted,
						transcripts: [],
						activity: [],
						agents: [],
						plan: [],
						agentMessages: [],
						canSteer: true,
						callId: opts.sessionId,
						canResolve: true,
						recordingMode: this.recordingMode,
						decisions: [...this.decisions.values()].filter((d) => d.state === "open" || d.state === "awaiting-confirmation"),
						interruptPolicy: this.interruptPolicy,
					});
				},
				close: (ws) => this.sockets.delete(ws),
				message: (ws, message) => this.handleControl(ws, message),
			},
		});
	}

	get port(): number {
		return this.server!.port as number;
	}

	get url(): string {
		return `ws://127.0.0.1:${this.port}`;
	}

	// ── Decision minting/resolution (journal write-before-act, then bridge broadcast) ──────────────

	async mintDecision(input: MintDecisionInput): Promise<FakeDecisionSnapshot> {
		if (input.options.length === 0) throw new Error("a decision needs at least one option");
		const snapshot: FakeDecisionSnapshot = {
			id: this.idFactory(),
			prompt: input.prompt,
			options: input.options.map((o) => ({ ...o })),
			requiresConfirmation: input.requiresConfirmation ?? false,
			state: "open",
			createdAt: this.now(),
			updatedAt: this.now(),
		};
		await this.appendJournal({ type: "decision", decision: snapshot });
		this.decisions.set(snapshot.id, snapshot);
		this.seenRequests.set(snapshot.id, new Set());
		this.broadcastDecision(snapshot);
		return snapshot;
	}

	/** The in-process path a spoken resolution takes — OMP's own controller calls its arbiter
	 *  directly, never over the wire, so this mirrors that rather than sending a control frame. */
	resolveVoice(input: Omit<ResolveDecisionInput, "source">): Promise<FakeDecisionResult> {
		return this.serialize(input.decisionId, () => this.resolveLocked({ ...input, source: "voice" }));
	}

	confirmVoice(input: ConfirmDecisionInput): Promise<FakeDecisionResult> {
		return this.serialize(input.decisionId, () => this.confirmLocked(input));
	}

	private serialize<T>(decisionId: string, task: () => Promise<T>): Promise<T> {
		const prior = this.chains.get(decisionId) ?? Promise.resolve();
		const result = prior.then(task, task);
		this.chains.set(
			decisionId,
			result.then(
				() => undefined,
				() => undefined,
			),
		);
		return result;
	}

	private async resolveLocked(input: ResolveDecisionInput): Promise<FakeDecisionResult> {
		const decision = this.decisions.get(input.decisionId);
		if (!decision) return { ok: false, reason: "not-found" };
		const seen = this.seenRequests.get(decision.id);
		if (seen?.has(input.requestId)) return { ok: false, reason: "duplicate-request", decision };
		if (decision.state !== "open") {
			return { ok: false, reason: decision.state === "awaiting-confirmation" ? "not-open" : "already-terminal", decision };
		}
		const option = decision.options[input.optionIndex];
		if (!option) return { ok: false, reason: "invalid-option", decision };
		if (option.label !== input.label) return { ok: false, reason: "label-mismatch", decision };
		seen?.add(input.requestId);
		if (!decision.requiresConfirmation) return this.finalize(decision, input.optionIndex, option.label, input.source);
		const confirmToken = this.idFactory();
		const updated: FakeDecisionSnapshot = { ...decision, state: "awaiting-confirmation", updatedAt: this.now() };
		await this.appendJournal({ type: "decision", decision: updated });
		this.decisions.set(decision.id, updated);
		this.pendingConfirm.set(decision.id, { optionIndex: input.optionIndex, label: option.label, source: input.source, confirmToken });
		this.broadcastDecision(updated);
		return { ok: true, decision: updated, confirmToken };
	}

	private async confirmLocked(input: ConfirmDecisionInput): Promise<FakeDecisionResult> {
		const decision = this.decisions.get(input.decisionId);
		if (!decision) return { ok: false, reason: "not-found" };
		if (decision.state !== "awaiting-confirmation") {
			return { ok: false, reason: decision.state === "open" ? "not-awaiting-confirmation" : "already-terminal", decision };
		}
		const pending = this.pendingConfirm.get(decision.id);
		if (!pending || pending.confirmToken !== input.confirmToken) return { ok: false, reason: "wrong-request-id", decision };
		const seen = this.seenRequests.get(decision.id);
		if (seen?.has(input.requestId)) return { ok: false, reason: "duplicate-request", decision };
		seen?.add(input.requestId);
		this.pendingConfirm.delete(decision.id);
		return this.finalize(decision, pending.optionIndex, pending.label, pending.source);
	}

	private async finalize(decision: FakeDecisionSnapshot, optionIndex: number, label: string, source: "voice" | "ui"): Promise<FakeDecisionResult> {
		const resolution: FakeDecisionResolution = { optionIndex, label, source };
		const updated: FakeDecisionSnapshot = { ...decision, state: "answered", updatedAt: this.now(), resolution };
		await this.appendJournal({ type: "decision", decision: updated });
		this.decisions.set(decision.id, updated);
		this.broadcastDecision(updated);
		return { ok: true, decision: updated };
	}

	decisionSnapshot(decisionId: string): FakeDecisionSnapshot | undefined {
		return this.decisions.get(decisionId);
	}

	// ── Transcript / artifact / terminal — journal + (for transcript) bridge presentation ──────────

	async publishTranscript(entry: { role: "user" | "assistant"; text: string; turn: number; final: boolean }): Promise<void> {
		// Retention governs the DURABLE record only — PROTOCOL.md: "recordingMode... changes nothing
		// about what crosses THIS wire". The bridge frame always goes out; the journal record is
		// written only when the call isn't recording `off`.
		if (this.recordingMode !== "off") await this.appendJournal({ type: "transcript", transcript: entry });
		this.broadcast({ type: "transcript", ...entry });
	}

	async publishArtifact(entry: { path: string; status: "ready" | "failed" }): Promise<void> {
		await this.appendJournal({ type: "artifact", artifact: entry });
	}

	/** Clean end: journal terminal record first, then the bridge's own terminal frame + socket
	 *  teardown — the honest path a real `/live` session exiting cleanly takes. */
	async publishTerminal(error: string | null): Promise<void> {
		if (this.closed) return;
		await this.appendJournal({ type: "terminal", error });
		this.closed = true;
		this.broadcast({ type: "terminal", error });
		const sockets = [...this.sockets];
		this.sockets.clear();
		for (const ws of sockets) {
			try {
				(ws as unknown as { close?: () => void }).close?.();
			} catch {
				/* already gone */
			}
		}
		this.server?.stop(true);
		this.server = undefined;
	}

	/** Dishonest exit: the process dies with NO terminal journal record and NO terminal bridge frame
	 *  — just a dropped socket. Simulates "OMP exit without terminal" (concern 04's Verify #7). The
	 *  journal FILE is left exactly as it was; only `deleteJournalFile()` removes it. */
	crash(): void {
		if (this.closed) return;
		this.closed = true;
		for (const ws of this.sockets) {
			try {
				(ws as unknown as { close?: () => void }).close?.();
			} catch {
				/* already gone */
			}
		}
		this.sockets.clear();
		this.server?.stop(true);
		this.server = undefined;
	}

	/** Simulates "journal discontinuity": the durable record itself vanishes out from under a still-
	 *  polling tailer, distinct from a clean/dirty process exit. */
	deleteJournalFile(): void {
		if (existsSync(this.journalPath)) rmSync(this.journalPath);
	}

	/** Graceful harness teardown for a test's own cleanup — same effect as `crash()` but named for
	 *  what it is at the test-lifecycle level, not as a scenario under test. */
	stop(): void {
		this.crash();
	}

	// ── Wire plumbing ────────────────────────────────────────────────────────────────────────────

	private handleControl(ws: { send(data: string): unknown }, message: string | Buffer): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(typeof message === "string" ? message : message.toString());
		} catch {
			return;
		}
		if (!parsed || typeof parsed !== "object") return;
		const frame = parsed as Record<string, unknown>;
		if (frame.type !== "control") return;
		if (frame.action === "resolveDecision") void this.handleResolveDecision(ws, frame);
		else if (frame.action === "setInterruptPolicy") void this.handleSetInterruptPolicy(ws, frame);
		else if (frame.action === "toggleMute") {
			this.muted = !this.muted;
			this.broadcast({ type: "muted", muted: this.muted });
		}
		// stop/steer: accepted and ignored by this fixture — no test in this suite drives them through
		// the wire (steering and stop are exercised at the coordinator level, which never sends them
		// through THIS fixture's control path in the spine).
	}

	private authorize(frame: Record<string, unknown>): { requestId: string; reason?: string } | undefined {
		const requestId = typeof frame.requestId === "string" && frame.requestId ? frame.requestId : undefined;
		if (!requestId) return undefined;
		if (this.controlToken !== undefined && frame.token !== this.controlToken) return { requestId, reason: "invalid-token" };
		if (typeof frame.sessionId !== "string" || frame.sessionId !== this.sessionId) return { requestId, reason: "wrong-session" };
		return { requestId };
	}

	private async handleResolveDecision(ws: { send(data: string): unknown }, frame: Record<string, unknown>): Promise<void> {
		const auth = this.authorize(frame);
		if (!auth) return;
		if (auth.reason) {
			this.ack(ws, auth.requestId, false, auth.reason);
			return;
		}
		const decisionId = typeof frame.decisionId === "string" ? frame.decisionId : undefined;
		const optionIndex = typeof frame.optionIndex === "number" ? frame.optionIndex : undefined;
		const label = typeof frame.label === "string" ? frame.label : undefined;
		const confirmToken = typeof frame.confirmToken === "string" ? frame.confirmToken : undefined;
		if (decisionId === undefined || optionIndex === undefined || label === undefined) {
			this.ack(ws, auth.requestId, false, "malformed-request");
			return;
		}
		const result = confirmToken
			? await this.serialize(decisionId, () => this.confirmLocked({ decisionId, confirmToken, requestId: auth.requestId }))
			: await this.serialize(decisionId, () => this.resolveLocked({ decisionId, optionIndex, label, requestId: auth.requestId, source: "ui" }));
		if (result.ok) this.ack(ws, auth.requestId, true, undefined, result.decision, result.confirmToken);
		else this.ack(ws, auth.requestId, false, result.reason, result.decision);
	}

	private async handleSetInterruptPolicy(ws: { send(data: string): unknown }, frame: Record<string, unknown>): Promise<void> {
		const auth = this.authorize(frame);
		if (!auth) return;
		if (auth.reason) {
			this.ack(ws, auth.requestId, false, auth.reason);
			return;
		}
		const policy = frame.policy === "doNotInterrupt" || frame.policy === "allow" ? frame.policy : undefined;
		if (!policy) {
			this.ack(ws, auth.requestId, false, "malformed-request");
			return;
		}
		this.interruptPolicy = policy;
		this.broadcast({ type: "interruptPolicy", policy });
		this.ack(ws, auth.requestId, true);
	}

	private ack(ws: { send(data: string): unknown }, requestId: string, ok: boolean, reason?: string, decision?: FakeDecisionSnapshot, confirmToken?: string): void {
		this.sendTo(ws, {
			type: "controlAck",
			requestId,
			ok,
			...(reason === undefined ? {} : { reason }),
			...(decision === undefined ? {} : { decision }),
			...(confirmToken === undefined ? {} : { confirmToken }),
		});
	}

	private broadcastDecision(decision: FakeDecisionSnapshot): void {
		this.broadcast({ type: "decision", decision });
	}

	private broadcast(body: Record<string, unknown>): void {
		const frame = this.frame(body);
		for (const ws of [...this.sockets]) {
			try {
				ws.send(frame);
			} catch {
				this.sockets.delete(ws);
			}
		}
	}

	private sendTo(ws: { send(data: string): unknown }, body: Record<string, unknown>): void {
		try {
			ws.send(this.frame(body));
		} catch {
			this.sockets.delete(ws);
		}
	}

	private frame(body: Record<string, unknown>): string {
		const seq = this.bridgeSeq;
		this.bridgeSeq += 1;
		return JSON.stringify({ v: 1, sessionId: this.sessionId, seq, ...body });
	}

	private appendJournal(record: Record<string, unknown>): Promise<void> {
		const envelope = { seq: this.journalSeq, at: this.now(), sessionId: this.sessionId, record };
		this.journalSeq += 1;
		appendFileSync(this.journalPath, `${JSON.stringify(envelope)}\n`, "utf8");
		return Promise.resolve();
	}
}

function writeFileSyncEmpty(filePath: string): void {
	const fd = openSync(filePath, "a");
	closeSync(fd);
}

/**
 * A `BrokerClient` whose `createCall` spins up a real `FakeOmpCall` per call, matching the real
 * broker's own `POST /calls` contract (callId/port/bridgeUrl/journalPath/controlToken/sessionRoot) —
 * the coordinator's `startCall` cannot tell this apart from a real `broker/broker.ts` process, other
 * than there being no actual subprocess. One broker instance can host several calls; `endCall` marks
 * the matching `FakeOmpCall` as exited without touching any OTHER call it is hosting, matching a real
 * broker's per-call reap semantics.
 */
export class FakeOmpBroker implements BrokerClient {
	readonly calls = new Map<string, { view: BrokerCallCreated; call: FakeOmpCall; exit: number | null }>();
	private seq = 0;
	constructor(
		private readonly journalDir: string,
		private readonly opts: { sessionIdFor?: (callId: string) => string; controlToken?: string; sessionRoot?: string; recordingMode?: "full" | "tails" | "off" } = {},
	) {}

	/** The `FakeOmpCall` behind a given callId — the test's own handle to mint decisions, publish
	 *  artifacts/transcript, or crash the session for a call this broker created. */
	callFor(callId: string): FakeOmpCall {
		const entry = this.calls.get(callId);
		if (!entry) throw new Error(`FakeOmpBroker: no call ${callId}`);
		return entry.call;
	}

	async createCall(opts?: { resume?: string; retention?: VoiceCallRetention }): Promise<BrokerCallCreated> {
		this.seq += 1;
		const callId = `fake-call-${this.seq}`;
		const journalPath = path.join(this.journalDir, `${callId}.jsonl`);
		const sessionId = this.opts.sessionIdFor?.(callId) ?? `live-${callId}`;
		const controlToken = this.opts.controlToken ?? `tok-${callId}`;
		const call = new FakeOmpCall({
			sessionId,
			journalPath,
			controlToken,
			recordingMode: opts?.retention ?? this.opts.recordingMode ?? "full",
		});
		const view: BrokerCallCreated = {
			callId,
			port: call.port,
			bridgeUrl: call.url,
			journalPath,
			startedAt: Date.now(),
			exit: null,
			controlToken,
			...(this.opts.sessionRoot ? { sessionRoot: this.opts.sessionRoot } : {}),
		};
		this.calls.set(callId, { view, call, exit: null });
		return view;
	}

	async endCall(callId: string): Promise<void> {
		const entry = this.calls.get(callId);
		if (!entry) return;
		entry.exit = 0;
		entry.call.crash();
	}

	async listCalls(): Promise<BrokerCallView[]> {
		return [...this.calls.values()].map((e) => ({ ...e.view, exit: e.exit, controlToken: undefined }) as BrokerCallView);
	}

	/** Corroborates a process exit WITHOUT touching the call's own socket/journal — the honest
	 *  "broker says the process died" signal a liveness probe checks for, distinct from `endCall`
	 *  (which is an operator-initiated end) and from `FakeOmpCall#crash` (the session's own socket
	 *  dying, which the broker may or may not have noticed yet). */
	corroborateExit(callId: string, code = 1): void {
		const entry = this.calls.get(callId);
		if (entry) entry.exit = code;
	}
}
