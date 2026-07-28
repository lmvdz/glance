/**
 * voice-call-binding.ts — the durable call-binding record (concern 02,
 * plans/voice-orchestrated-room-integration/02-squad-call-projection.md).
 *
 * The OMP Squad daemon is the durable owner of a thread-bound live call. A binding is keyed by
 * `channelId` (the thread/room a call was started from) and records: the broker identity
 * (`callId`/`port`/`bridgeUrl`/`journalPath`), the daemon-held per-call control token, the PINNED
 * session identity OMP returned in its `hello` frame, the owning actor, the retention policy chosen
 * at attach time, and the current `connecting|live|degraded|ended` state with an honest terminal
 * reason once ended.
 *
 * Persisted synchronously to `<stateDir>/voice-calls.json` on every mutation — bindings mutate rarely
 * (call lifecycle events, not per-message traffic), so there is no debounce to get wrong, and a crash
 * immediately after `beginConnecting()` still leaves visible evidence that a connection was attempted
 * rather than silence (DESIGN.md: "Persist the binding before connecting").
 *
 * "Never adopt a different session that happens to reuse the same port" (DESIGN.md risk table) is
 * enforced here: `pinSession` accepts the FIRST sessionId a binding ever sees and refuses — never
 * silently overwrites — any later, different sessionId for the same still-open binding. The caller
 * (VoiceCallCoordinator) is expected to end the OLD binding with `terminalReason: "port-reused"` and
 * start a fresh one rather than trust the new session under the old identity.
 */

import { getStorageBackend } from "./dal/storage.ts";
import { errText } from "./err-text.ts";

export type VoiceCallState = "connecting" | "live" | "degraded" | "ended";

/** Retention policy for this call's transcript, chosen at attach time (default `full`, concern 05's
 *  recorded product default) and never changed mid-call — a call that started `full` cannot quietly
 *  become `tails` (or vice versa) without the human re-attaching. */
export type VoiceCallRetention = "full" | "tails" | "off";

/**
 * Every terminal reason a binding can honestly report, kept distinct rather than folded into one
 * generic "ended" (the concern's Verify bullet: "socket loss, terminal, journal end, broker exit, and
 * stale binding produce distinct honest states" — socket loss is `degraded`, the other four map here):
 *  - `operator-ended`   — a human (or the idle-hangup policy) asked the daemon to end the call.
 *  - `terminal`         — the OMP journal wrote an explicit `{type:"terminal", error}` record: the
 *                          session told us, cleanly or with an error, that it is over.
 *  - `journal-end`      — the journal file disappeared (or stopped growing past a liveness deadline)
 *                          with NO terminal record ever observed — the process died without telling us.
 *  - `broker-exit`      — the broker corroborates the child process exited (a non-null `exit` code, or
 *                          the callId no longer listed) before any terminal/journal-end was seen.
 *  - `stale-binding`    — a rehydrated binding claimed live/degraded but neither the broker nor the
 *                          journal can corroborate it (e.g. the broker itself restarted too) — the
 *                          daemon refuses to claim liveness it cannot verify.
 *  - `port-reused`      — a reconnect attempt produced a `hello` whose `sessionId` does not match the
 *                          one this binding pinned; the daemon refuses to adopt the new session.
 *  - `idle`             — OMP's own idle-hangup policy (concern 05's recorded default: 10 minutes with
 *                          no human or agent activity, a spoken warning first) ended the call. Distinct
 *                          from the generic `terminal` a journaled `{type:"terminal"}` record otherwise
 *                          maps to — see `onJournalEnvelope`'s reason mapping — so the ended card and the
 *                          HUD can say "ended after sitting idle" rather than a bare "ended cleanly".
 */
export type VoiceCallTerminalReason = "operator-ended" | "terminal" | "journal-end" | "broker-exit" | "stale-binding" | "port-reused" | "start-failed" | "idle";

const TERMINAL_REASONS: readonly VoiceCallTerminalReason[] = ["operator-ended", "terminal", "journal-end", "broker-exit", "stale-binding", "port-reused", "start-failed", "idle"];

export interface VoiceCallBinding {
	channelId: string;
	/** Broker-minted call id. Absent only during the brief `connecting` window before the broker answers. */
	callId?: string;
	/** OMP's own session identity, PINNED on first sight — see module doc. */
	sessionId?: string;
	port?: number;
	bridgeUrl?: string;
	/** Broker-minted per-call journal path this binding's tailer reads. */
	journalPath?: string;
	/** Daemon-held per-call control token (PROTOCOL.md's `resolveDecision`/`setInterruptPolicy` auth).
	 *  Never returned by any read API — see `redactBinding`. */
	controlToken?: string;
	/** Directory `omp live` was launched from — artifact snapshots resolve beneath this and reject an
	 *  escape past it (see `voice-call-artifacts.ts`). */
	sessionRoot: string;
	ownerActorId: string;
	retention: VoiceCallRetention;
	startedAt: number;
	updatedAt: number;
	state: VoiceCallState;
	degradedSince?: number;
	degradedReason?: "socket-loss";
	terminalReason?: VoiceCallTerminalReason;
	/** Set only for `terminalReason === "terminal"` — the journal's own `error` field (null = clean). */
	terminalError?: string | null;
	endedAt?: number;
	/** Durable idempotency cursor: the highest journal `seq` this binding's tailer has applied — lets a
	 *  restarted tailer resume without re-projecting (or re-pushing) anything already applied. */
	lastJournalSeq?: number;
	/** `--resume` session file passed to `omp live`, when this call resumed a prior one. */
	resumeSessionId?: string;
	/**
	 * Set when the bridge's own `hello.recordingMode` (what the SESSION actually did, per
	 * `OMP_LIVE_RECORDING_MODE`) disagrees with `retention` (what the ROOM asked for at attach time).
	 * The daemon sends the room's retention through to the broker (see `VoiceCallCoordinator#startCall`
	 * / `BrokerClient#createCall`'s `retention` option), but the broker is a separate process that
	 * could be stale, misconfigured, or simply not the same build the daemon expects — surfacing the
	 * disagreement here is the honest alternative to silently trusting either side. Absent when they
	 * agree (or the bridge never reported a `recordingMode` at all — an older bridge build, additive
	 * per PROTOCOL.md, is not itself a mismatch). Cleared if a later reconnect reports agreement.
	 */
	retentionMismatch?: { expected: VoiceCallRetention; reported: "full" | "tails" | "off" };
}

/** Read-only view: never carries `controlToken`. Every daemon read API (state, rehydration) returns
 *  this shape, never the raw binding — a page that can read call state must never learn the secret
 *  that lets it forge a bridge control frame. */
export type VoiceCallBindingView = Omit<VoiceCallBinding, "controlToken">;

export function redactBinding(binding: VoiceCallBinding): VoiceCallBindingView {
	const { controlToken, ...view } = binding;
	return view;
}

export interface BeginConnectingInput {
	ownerActorId: string;
	sessionRoot: string;
	retention: VoiceCallRetention;
	resumeSessionId?: string;
}

export type PinSessionResult = { ok: true; binding: VoiceCallBinding } | { ok: false; reason: "port-reused"; binding: VoiceCallBinding };

function bindingsPath(stateDir: string): string {
	return `${stateDir}/voice-calls.json`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Narrow a raw parsed object into a `VoiceCallBinding`, dropping anything unrecognizable rather than
 *  trusting a corrupt/foreign shape verbatim — same fail-closed discipline as attention.ts's
 *  `narrowSeenMap`. A binding missing its required string fields is dropped entirely. */
function narrowBinding(raw: unknown): VoiceCallBinding | undefined {
	if (!isPlainRecord(raw)) return undefined;
	const channelId = raw.channelId;
	const sessionRoot = raw.sessionRoot;
	const ownerActorId = raw.ownerActorId;
	const retention = raw.retention;
	const startedAt = raw.startedAt;
	const updatedAt = raw.updatedAt;
	const state = raw.state;
	if (typeof channelId !== "string" || !channelId) return undefined;
	if (typeof sessionRoot !== "string" || !sessionRoot) return undefined;
	if (typeof ownerActorId !== "string" || !ownerActorId) return undefined;
	if (retention !== "full" && retention !== "tails" && retention !== "off") return undefined;
	if (typeof startedAt !== "number" || typeof updatedAt !== "number") return undefined;
	if (state !== "connecting" && state !== "live" && state !== "degraded" && state !== "ended") return undefined;
	const out: VoiceCallBinding = { channelId, sessionRoot, ownerActorId, retention, startedAt, updatedAt, state };
	if (typeof raw.callId === "string") out.callId = raw.callId;
	if (typeof raw.sessionId === "string") out.sessionId = raw.sessionId;
	if (typeof raw.port === "number") out.port = raw.port;
	if (typeof raw.bridgeUrl === "string") out.bridgeUrl = raw.bridgeUrl;
	if (typeof raw.journalPath === "string") out.journalPath = raw.journalPath;
	if (typeof raw.controlToken === "string") out.controlToken = raw.controlToken;
	if (typeof raw.degradedSince === "number") out.degradedSince = raw.degradedSince;
	if (raw.degradedReason === "socket-loss") out.degradedReason = "socket-loss";
	if (typeof raw.terminalReason === "string" && (TERMINAL_REASONS as readonly string[]).includes(raw.terminalReason)) {
		out.terminalReason = raw.terminalReason as VoiceCallTerminalReason;
	}
	if (raw.terminalError === null || typeof raw.terminalError === "string") out.terminalError = raw.terminalError;
	if (typeof raw.endedAt === "number") out.endedAt = raw.endedAt;
	if (typeof raw.lastJournalSeq === "number") out.lastJournalSeq = raw.lastJournalSeq;
	if (typeof raw.resumeSessionId === "string") out.resumeSessionId = raw.resumeSessionId;
	if (isPlainRecord(raw.retentionMismatch)) {
		const { expected, reported } = raw.retentionMismatch;
		const expectedOk = expected === "full" || expected === "tails" || expected === "off";
		const reportedOk = reported === "full" || reported === "tails" || reported === "off";
		if (expectedOk && reportedOk) out.retentionMismatch = { expected, reported };
	}
	return out;
}

function loadBindings(stateDir: string, log: (msg: string) => void): Map<string, VoiceCallBinding> {
	const out = new Map<string, VoiceCallBinding>();
	try {
		const raw = getStorageBackend().readTextSync(bindingsPath(stateDir));
		if (!raw) return out;
		const parsed = JSON.parse(raw) as unknown;
		if (!isPlainRecord(parsed)) return out;
		for (const [channelId, value] of Object.entries(parsed)) {
			const binding = narrowBinding(value);
			if (binding) out.set(channelId, binding);
		}
	} catch (err) {
		log(`voice-calls.json unreadable — starting with no bindings: ${errText(err)}`);
	}
	return out;
}

export class CallBindingStore {
	/** Lazily loaded on first access — see `bindingsMap()`. `SquadManager` constructs one of these
	 *  per manager unconditionally (voice calls are a per-channel feature, not opt-in at the manager
	 *  level), so an eager sync read here would add a filesystem hit to EVERY manager construction —
	 *  including the overwhelming majority of daemons/tests that never touch a voice call at all. At
	 *  full test-suite scale (thousands of `SquadManager` constructions across hundreds of files in
	 *  one process) that unconditional cost is worth avoiding. */
	private bindings: Map<string, VoiceCallBinding> | undefined;
	private readonly stateDir: string;
	private readonly log: (msg: string) => void;
	private readonly now: () => number;

	constructor(stateDir: string, opts?: { log?: (msg: string) => void; now?: () => number }) {
		this.stateDir = stateDir;
		this.log = opts?.log ?? (() => {});
		this.now = opts?.now ?? Date.now;
	}

	private bindingsMap(): Map<string, VoiceCallBinding> {
		this.bindings ??= loadBindings(this.stateDir, this.log);
		return this.bindings;
	}

	private persist(): void {
		try {
			const obj: Record<string, VoiceCallBinding> = {};
			for (const [channelId, binding] of this.bindingsMap()) obj[channelId] = binding;
			getStorageBackend().writeDurableSync(bindingsPath(this.stateDir), JSON.stringify(obj));
		} catch (err) {
			this.log(`voice-calls.json write failed: ${errText(err)}`);
		}
	}

	get(channelId: string): VoiceCallBinding | undefined {
		return this.bindingsMap().get(channelId);
	}

	list(): VoiceCallBinding[] {
		return [...this.bindingsMap().values()];
	}

	/**
	 * Persist a fresh `connecting` binding BEFORE the caller ever dials the broker — a crash between
	 * this call and the broker's answer still leaves a visible "we tried to start a call here" record
	 * instead of silence. Refuses (throws) when a NON-terminal binding already occupies this channel:
	 * V1 allows at most one active call per thread (DESIGN.md's V1 boundary).
	 */
	beginConnecting(channelId: string, input: BeginConnectingInput): VoiceCallBinding {
		const existing = this.bindingsMap().get(channelId);
		if (existing && existing.state !== "ended") {
			throw new Error(`channel ${channelId} already has an active call (${existing.state})`);
		}
		const now = this.now();
		const binding: VoiceCallBinding = {
			channelId,
			sessionRoot: input.sessionRoot,
			ownerActorId: input.ownerActorId,
			retention: input.retention,
			startedAt: now,
			updatedAt: now,
			state: "connecting",
			...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
		};
		this.bindingsMap().set(channelId, binding);
		this.persist();
		return binding;
	}

	/** Attach the broker's response to a `connecting` binding. Throws if the binding is missing or has
	 *  already moved past `connecting` (a caller race — the binding was ended out from under it).
	 *  `sessionRoot`, when given, REPLACES the provisional guess `beginConnecting` recorded — the
	 *  caller (`VoiceCallCoordinator#startCall`) is expected to have already reconciled the broker's
	 *  own answer against any client-supplied override before calling this (see
	 *  `resolveEffectiveSessionRoot`); omitted entirely, the provisional guess stands unchanged. */
	attachBroker(channelId: string, broker: { callId: string; port: number; bridgeUrl: string; journalPath: string; controlToken: string; sessionRoot?: string }): VoiceCallBinding {
		const binding = this.requireBinding(channelId);
		if (binding.state !== "connecting") throw new Error(`channel ${channelId} binding is not connecting (${binding.state})`);
		const updated: VoiceCallBinding = { ...binding, ...broker, updatedAt: this.now() };
		this.bindingsMap().set(channelId, updated);
		this.persist();
		return updated;
	}

	/**
	 * Pin the session identity OMP's `hello` frame reported. The FIRST call for a binding pins it and
	 * transitions to `live`; a LATER call reporting a DIFFERENT sessionId for the same still-open
	 * binding is refused — the caller must end this binding (`port-reused`) rather than adopt the new
	 * session under the old identity. A later call reporting the SAME sessionId (a reconnect after a
	 * transient socket loss) is accepted and clears any `degraded` marker.
	 */
	pinSession(channelId: string, sessionId: string): PinSessionResult {
		const binding = this.requireBinding(channelId);
		if (binding.sessionId !== undefined && binding.sessionId !== sessionId) {
			return { ok: false, reason: "port-reused", binding };
		}
		const updated: VoiceCallBinding = { ...binding, sessionId, state: "live", updatedAt: this.now(), degradedSince: undefined, degradedReason: undefined };
		this.bindingsMap().set(channelId, updated);
		this.persist();
		return { ok: true, binding: updated };
	}

	markDegraded(channelId: string, reason: "socket-loss" = "socket-loss"): VoiceCallBinding {
		const binding = this.requireBinding(channelId);
		if (binding.state === "ended") return binding;
		const updated: VoiceCallBinding = { ...binding, state: "degraded", degradedSince: binding.degradedSince ?? this.now(), degradedReason: reason, updatedAt: this.now() };
		this.bindingsMap().set(channelId, updated);
		this.persist();
		return updated;
	}

	/** Sets or clears `retentionMismatch` — see the field's own doc. `undefined` clears it (a
	 *  reconnect that now agrees with what the room asked for). A no-op write when the new value is
	 *  already what's recorded, so a repeated identical mismatch across several reconnects doesn't
	 *  churn `updatedAt`/persist on every one. */
	setRetentionMismatch(channelId: string, mismatch: { expected: VoiceCallRetention; reported: "full" | "tails" | "off" } | undefined): VoiceCallBinding {
		const binding = this.requireBinding(channelId);
		const current = binding.retentionMismatch;
		const unchanged = mismatch === undefined ? current === undefined : current !== undefined && current.expected === mismatch.expected && current.reported === mismatch.reported;
		if (unchanged) return binding;
		const updated: VoiceCallBinding = { ...binding, retentionMismatch: mismatch, updatedAt: this.now() };
		this.bindingsMap().set(channelId, updated);
		this.persist();
		return updated;
	}

	/** Recovery from `degraded` back to `live` — the SAME pinned session answered again. */
	markLiveAgain(channelId: string): VoiceCallBinding {
		const binding = this.requireBinding(channelId);
		if (binding.state !== "degraded") return binding;
		const updated: VoiceCallBinding = { ...binding, state: "live", degradedSince: undefined, degradedReason: undefined, updatedAt: this.now() };
		this.bindingsMap().set(channelId, updated);
		this.persist();
		return updated;
	}

	/** Idempotent: ending an already-ended binding is a no-op that returns the existing record
	 *  unchanged (its original terminal reason wins — the FIRST honest reason a binding ended is the
	 *  one worth keeping, not whichever caller happened to call `markEnded` last). */
	markEnded(channelId: string, terminalReason: VoiceCallTerminalReason, terminalError?: string | null): VoiceCallBinding {
		const binding = this.requireBinding(channelId);
		if (binding.state === "ended") return binding;
		const now = this.now();
		const updated: VoiceCallBinding = {
			...binding,
			state: "ended",
			terminalReason,
			terminalError: terminalError ?? null,
			endedAt: now,
			updatedAt: now,
			degradedSince: undefined,
			degradedReason: undefined,
		};
		this.bindingsMap().set(channelId, updated);
		this.persist();
		return updated;
	}

	/** Advance the durable idempotency cursor. A no-op (never regresses) when `seq` is not ahead of the
	 *  already-recorded cursor — the tailer's own dedup already guarantees `seq` is monotone per call,
	 *  but a defensive max-merge costs nothing and matches every other durable cursor in this codebase. */
	updateJournalCursor(channelId: string, seq: number): void {
		const binding = this.bindingsMap().get(channelId);
		if (!binding) return;
		if (binding.lastJournalSeq !== undefined && binding.lastJournalSeq >= seq) return;
		this.bindingsMap().set(channelId, { ...binding, lastJournalSeq: seq, updatedAt: this.now() });
		this.persist();
	}

	private requireBinding(channelId: string): VoiceCallBinding {
		const binding = this.bindingsMap().get(channelId);
		if (!binding) throw new Error(`no voice-call binding for channel ${channelId}`);
		return binding;
	}

	/** No debounced write to flush — every mutation above persists synchronously. Present for symmetry
	 *  with every other daemon-owned store's `stop()` and to make the shutdown call site uniform. */
	stop(): void {}
}
