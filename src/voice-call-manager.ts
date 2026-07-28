/**
 * voice-call-manager.ts — VoiceCallCoordinator, the per-daemon orchestrator for concern 02.
 *
 * Owns, per channel: the durable binding (`CallBindingStore`), the journal tailer + idempotent
 * projection (`JournalTailer` / `CallProjectionStore`), the artifact snapshot store, the voice
 * attention/push source, and the live bridge client (when the call is actually `live`). This is the
 * seam `SquadManager` delegates to — it knows nothing about `ChannelStore`/`AgentDTO`/RBAC; every
 * card emission and authorization check is injected by the caller.
 *
 * Card-honesty note (DESIGN.md): the binding's own state transitions are announced by THIS class
 * (`announceCallState`), driven by connect/degrade/end events. Decision cards are announced by
 * `CallProjectionStore`, driven ONLY by journal envelopes — never by a bridge frame — so "Journal
 * records, not WebSocket frame arrival, mutate the durable state" holds for decisions exactly as
 * DESIGN.md requires. The bridge's own `terminal` frame is observed but never itself ends a binding;
 * only the journal's `terminal` record, a broker-corroborated exit, or a stale-binding rehydration
 * failure does (see `CallBindingStore.markEnded`'s terminal-reason taxonomy).
 *
 * No-orphan note (production-observed defect): ending a binding must never leave a broker-spawned
 * `omp live` process running with nothing attached to it — the user would have no way to stop it.
 * `endBinding` is therefore the ONE place both the runtime teardown (`teardownRuntime`) AND a
 * best-effort broker reap (`reapBrokerCall` — the broker's `DELETE /calls/:id`) happen, for every
 * termination path except the two where the session already ended itself (`terminal`, `journal-end`).
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import { emitVoiceCallCard, emitVoiceDecisionCard } from "./schema/channel-card.ts";
import type { CardPayloadType } from "./schema/channel-card.ts";
import { TRANSCRIPT_EVENT_VOICE_CALL, TRANSCRIPT_EVENT_VOICE_DECISION } from "./transcript-event-kinds.ts";
import { errText } from "./err-text.ts";
import { ArtifactSnapshotStore, resolveWithinSessionRoot, type ArtifactReadResult, type ArtifactSnapshotRecord } from "./voice-call-artifacts.ts";
import {
	CallBindingStore,
	redactBinding,
	type VoiceCallBinding,
	type VoiceCallBindingView,
	type VoiceCallRetention,
	type VoiceCallTerminalReason,
} from "./voice-call-binding.ts";
import { VoiceCallBridgeClient, type BridgeConnectFn, type BridgeControlAck, type BridgeHelloFrame } from "./voice-call-bridge-client.ts";
import { JournalTailer, type JournalEnvelope } from "./voice-call-journal.ts";
import { CallProjectionStore, type EmitVoiceDecisionCardInput, type JournalGap, type StoredTranscriptEntry } from "./voice-call-projection.ts";
import { VoiceAttentionSource, voiceChannelLadderPriority } from "./voice-attention.ts";
import type { JournalDecisionSnapshot } from "./voice-call-journal.ts";
import type { LadderPriority } from "./attention-ladder.ts";
import type { PushService } from "./push.ts";

export interface BrokerCallView {
	callId: string;
	port: number;
	bridgeUrl: string;
	journalPath: string;
	startedAt: number;
	exit: number | null;
	/** The directory the broker actually launched `omp live` in (`broker/broker.ts`'s `PROJECT_DIR`,
	 *  passed to the child as its real `cwd` — not a guess). Absent only against an OLDER broker build
	 *  that predates this field; see `resolveEffectiveSessionRoot`. */
	sessionRoot?: string;
	/**
	 * Concern 09 (browser-audio-transport): whether the broker spawned this call's `omp live` process
	 * audio-less (`broker/broker.ts`'s own `NO_LOCAL_AUDIO`, threaded through as
	 * `OMP_LIVE_NO_LOCAL_AUDIO`). Absent against an older broker build that predates this field —
	 * see `VoiceCallBinding.noLocalAudio`'s doc for how that absence is treated.
	 */
	noLocalAudio?: boolean;
}

export interface BrokerCallCreated extends BrokerCallView {
	controlToken: string;
}

/** The broker's own HTTP surface (`opencoven-viz/broker/broker.ts`) — injectable so this module never
 *  needs a real broker process (or a real microphone) to be tested. */
export interface BrokerClient {
	createCall(opts?: { resume?: string; retention?: VoiceCallRetention }): Promise<BrokerCallCreated>;
	endCall(callId: string): Promise<void>;
	listCalls(): Promise<BrokerCallView[]>;
}

function brokerBaseUrl(): string {
	const port = Number(process.env.COVEN_BROKER_PORT ?? 8730);
	return `http://127.0.0.1:${port}`;
}

/** Default broker client: plain `fetch` against the loopback broker, matching `broker/broker.ts`'s
 *  own `/calls` GET/POST/DELETE contract exactly (including its `{error}` body on a non-2xx). */
export function httpBrokerClient(baseUrl: string = brokerBaseUrl()): BrokerClient {
	async function call(path: string, init?: RequestInit): Promise<unknown> {
		const res = await fetch(`${baseUrl}${path}`, init);
		const body = (await res.json().catch(() => undefined)) as unknown;
		if (!res.ok) {
			const message = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : `broker ${res.status}`;
			throw new Error(message);
		}
		return body;
	}
	return {
		async createCall(opts) {
			// `recording` is the broker's own field name (`broker/broker.ts`'s `POST /calls`, validated
			// full|tails|off server-side) for what becomes `OMP_LIVE_RECORDING_MODE` in the spawned
			// process — the binding's `retention` is exactly that policy, so it rides straight through.
			return (await call("/calls", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resume: opts?.resume, recording: opts?.retention }) })) as BrokerCallCreated;
		},
		async endCall(callId) {
			await call(`/calls/${encodeURIComponent(callId)}`, { method: "DELETE" });
		},
		async listCalls() {
			const body = (await call("/calls")) as { calls: BrokerCallView[] };
			return body.calls;
		},
	};
}

/**
 * Reconciles the caller-supplied `sessionRoot` override (if any) against the broker's own answer for
 * where it actually launched `omp live` — DESIGN.md's artifact-snapshot boundary is only as good as
 * `sessionRoot` being trustworthy, so an override gets no special credit just because a client asked
 * for one:
 *  - No override at all → the broker's root (the ground truth), or `process.cwd()` if the broker
 *    predates the field (an older build — additive, not a hard requirement).
 *  - An override that isn't an absolute path, or doesn't exist on disk → dropped; same fallback.
 *  - An override that IS absolute and exists, but — when the broker DID report a root — resolves
 *    outside it (`resolveWithinSessionRoot`, the same symlink-aware containment check
 *    `voice-call-artifacts.ts` uses for artifact paths) → dropped; same fallback. A client cannot walk
 *    the daemon's artifact snapshots outside the directory the broker itself actually ran in.
 *  - Otherwise (absolute, exists, and — if a broker root is known — contained within it) → accepted.
 * Every drop is logged (never thrown) — `startCall` still succeeds, just with the honest root instead
 * of the rejected one.
 */
export async function resolveEffectiveSessionRoot(clientOverride: string | undefined, brokerRoot: string | undefined, log: (msg: string) => void): Promise<string> {
	const fallback = brokerRoot ?? process.cwd();
	if (!clientOverride) return fallback;
	if (!path.isAbsolute(clientOverride)) {
		log(`voice-call: dropping non-absolute sessionRoot override "${clientOverride}" — using ${fallback}`);
		return fallback;
	}
	if (brokerRoot === undefined) {
		// No broker-provided root to check containment against — still require the override to exist.
		if (!existsSync(clientOverride)) {
			log(`voice-call: dropping sessionRoot override "${clientOverride}" — path does not exist — using ${fallback}`);
			return fallback;
		}
		return clientOverride;
	}
	const contained = await resolveWithinSessionRoot(brokerRoot, clientOverride);
	if (!contained.ok) {
		log(`voice-call: dropping sessionRoot override "${clientOverride}" — ${contained.reason}: ${contained.detail} — using broker-provided root ${fallback}`);
		return fallback;
	}
	return clientOverride;
}

export interface EmitCardInput {
	channelId: string;
	kind: "voice-call" | "voice-decision";
	text: string;
	payload: unknown;
}

export interface VoiceCallCoordinatorOptions {
	stateDir: string;
	log?: (msg: string) => void;
	now?: () => number;
	broker?: BrokerClient;
	connectBridge?: BridgeConnectFn;
	push?: PushService;
	emitCard: (input: EmitCardInput) => Promise<void>;
	channelMemberUserIds?: (channelId: string) => Promise<string[] | undefined>;
	journalPollIntervalMs?: number;
	livenessProbeIntervalMs?: number;
}

export interface StartCallInput {
	ownerActorId: string;
	sessionRoot?: string;
	retention?: VoiceCallRetention;
	resumeSessionId?: string;
}

export type CoordinatorResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * What a reader of a channel's call actually gets: the redacted binding PLUS the two facts that
 * live in the in-process runtime rather than on the durable record — whether the daemon has asked
 * the mic to be muted, and whether a live bridge socket exists at all right now.
 *
 * `micMuted` is deliberately NOT persisted onto the binding: a mute is a property of the live
 * session, and a daemon restart genuinely does not know what the mic is doing. Reading `false`
 * after a restart is the honest answer, not a lost setting.
 */
export interface VoiceCallStateView extends VoiceCallBindingView {
	micMuted: boolean;
	/** `true` only while a connected bridge client exists — the precondition for steering, resolving,
	 *  and muting. A `live` binding with no socket (mid-reconnect) can therefore be shown as "controls
	 *  are unavailable right now" instead of offering buttons that will be refused. */
	controlsAvailable: boolean;
	/**
	 * Concern 09 (browser-audio-transport): `true` only when this call is BOTH audio-less
	 * (`binding.noLocalAudio`) AND has the same live-bridge precondition `controlsAvailable` checks —
	 * the two facts a webapp needs before it renders mic-capture UI or attempts `attachAudioSink`/
	 * `pushMicAudio` at all, rather than offering a mic button a device-audio call would refuse.
	 */
	audioAvailable: boolean;
}

const DEFAULT_JOURNAL_POLL_MS = 400;
const DEFAULT_LIVENESS_PROBE_MS = 5_000;

function voiceCallFacePayload(binding: VoiceCallBinding): CardPayloadType<typeof TRANSCRIPT_EVENT_VOICE_CALL> {
	const title =
		binding.state === "connecting"
			? "Call connecting"
			: binding.state === "live"
				? "Call live"
				: binding.state === "degraded"
					? "Call degraded — checking connection"
					: `Call ended${binding.terminalReason ? ` (${binding.terminalReason})` : ""}`;
	return {
		refs: { callId: binding.callId },
		face: {
			title,
			status: binding.state,
			callId: binding.callId,
			state: binding.state,
			terminalReason: binding.terminalReason,
			detail:
				binding.state === "ended"
					? terminalReasonDetail(binding.terminalReason, binding.terminalError)
					: binding.state === "degraded"
						? "Socket connection lost — confirming with the call broker."
						: binding.retentionMismatch
							? `Recording mode mismatch: the room asked for "${binding.retentionMismatch.expected}", the session reports "${binding.retentionMismatch.reported}".`
							: undefined,
		},
	};
}

function terminalReasonDetail(reason: VoiceCallTerminalReason | undefined, terminalError: string | null | undefined): string {
	switch (reason) {
		case "operator-ended":
			return "Ended by the operator.";
		case "terminal":
			return terminalError ? `The session ended with an error: ${terminalError}` : "The session ended cleanly.";
		case "journal-end":
			return "The session's journal stopped without a clean terminal record — it likely crashed.";
		case "broker-exit":
			return "The call broker confirmed the session process exited.";
		case "stale-binding":
			return "This binding could not be confirmed live after a daemon restart — treated as ended rather than claiming liveness.";
		case "port-reused":
			return "A different session reused this call's port — refusing to adopt it as a continuation.";
		case "start-failed":
			return "The call could not be started.";
		case "idle":
			// Duration-free deliberately: the idle-hangup window is env-overridable
			// (OMP_COVEN_IDLE_HANGUP_MS) and this record does not carry the value that
			// was actually configured for this call, so naming a fixed number here
			// would drift from reality the moment an operator changes it.
			return "The call ended after sitting idle with no one speaking.";
		default:
			return "Ended.";
	}
}

function voiceDecisionFacePayload(channelId: string, callId: string, decision: JournalDecisionSnapshot, cardKind: "mint" | "terminal"): CardPayloadType<typeof TRANSCRIPT_EVENT_VOICE_DECISION> {
	const optionLabels = decision.options.map((o) => o.label);
	if (cardKind === "mint") {
		return {
			refs: { callId, decisionId: decision.id },
			face: {
				// Agent-authored question text — register:"claim" per concern 07's epistemic-register
				// semantics (an agent's own assertion presented as UI text, never a daemon-checked fact).
				title: decision.prompt,
				body: optionLabels.length ? `Options: ${optionLabels.join(" · ")}` : undefined,
				status: "open",
				callId,
				decisionId: decision.id,
				decisionState: decision.state,
				requiresConfirmation: decision.requiresConfirmation,
				optionLabels,
				...(decision.decisionClass === undefined ? {} : { decisionClass: decision.decisionClass }),
				tone: "warning",
				register: "claim",
			},
		};
	}
	const resolution = decision.resolution;
	const title =
		decision.state === "answered"
			? `Resolved · ${resolution?.label ?? decision.prompt}`
			: decision.state === "expired"
				? `Expired · ${decision.prompt}`
				: decision.state === "cancelled"
					? `Cancelled · ${decision.prompt}`
					: `Failed · ${decision.prompt}`;
	return {
		refs: { callId, decisionId: decision.id },
		face: {
			title,
			status: decision.state,
			callId,
			decisionId: decision.id,
			decisionState: decision.state,
			requiresConfirmation: decision.requiresConfirmation,
			optionLabels,
			...(decision.decisionClass === undefined ? {} : { decisionClass: decision.decisionClass }),
			resolutionSource: resolution?.source,
			tone: decision.state === "answered" ? "success" : "neutral",
			// Every terminal title still embeds `decision.prompt` verbatim (a resolved decision falls
			// back to it too, whenever `resolution?.label` is absent) — the SAME agent-authored assertion
			// the mint card carries, just prefixed with a state word ("Expired · ", "Failed · ", ...).
			// Prefixing it with a state label doesn't change what the embedded text IS, so this gets the
			// SAME register:"claim" the mint card sets, per concern 07's epistemic-register semantics.
			register: "claim",
		},
	};
}

/** One channel's live wiring — the pieces that exist only while a call is being connected or is
 *  live/degraded for this channel. Torn down (never adopted forward) once the binding ends. */
interface ChannelRuntime {
	tailer?: JournalTailer;
	bridge?: VoiceCallBridgeClient;
	livenessTimer?: ReturnType<typeof setInterval>;
	/** What the daemon has last ASKED this call's mic to be (concern 03's visible mute control).
	 *  The wire control is `toggleMute` — unauthenticated, fire-and-forget, no ack (PROTOCOL.md), so
	 *  this is honestly "what we asked for", not "what the mic is". Tracking it here is what lets a
	 *  caller say `setMuted(true)` idempotently: a second identical request sends no toggle at all,
	 *  rather than un-muting the mic the operator just muted. Cleared with the runtime, so a new
	 *  call never inherits the previous call's mute. */
	micMuted?: boolean;
	/**
	 * Concern 09 (browser-audio-transport): the connected browser's audio relay, when one has
	 * attached via `attachAudioSink`. Receives decoded output PCM the bridge forwards (wired once, in
	 * `connectAndPin`, regardless of whether a sink is attached yet — the bridge callback simply reads
	 * this field at delivery time). Cleared with the rest of the runtime, so a new call never inherits
	 * the previous call's sink, and a torn-down runtime never keeps feeding audio nobody asked for.
	 */
	audioSink?: { sendOutputAudio: (bytes: Uint8Array) => void };
	/** Guards against overlapping liveness-probe ticks — a broker round-trip plus a bridge reconnect
	 *  attempt can easily outlast `livenessProbeIntervalMs`, exactly like `observer.ts`'s own documented
	 *  "the gate run can outlast the interval" guard. Without this, a slow tick leaves the PREVIOUS
	 *  probe's `connectAndPin` (and its real WebSocket connect attempt) still in flight while the next
	 *  timer tick starts a brand new one — unbounded concurrent reconnect attempts under load. */
	livenessProbing?: boolean;
	ended: boolean;
}

export class VoiceCallCoordinator {
	private readonly stateDir: string;
	private readonly log: (msg: string) => void;
	private readonly now: () => number;
	private readonly broker: BrokerClient;
	private readonly connectBridge: BridgeConnectFn | undefined;
	private readonly emitCardFn: (input: EmitCardInput) => Promise<void>;
	private readonly channelMemberUserIds: ((channelId: string) => Promise<string[] | undefined>) | undefined;
	private readonly journalPollIntervalMs: number;
	private readonly livenessProbeIntervalMs: number;

	readonly bindings: CallBindingStore;
	readonly projection: CallProjectionStore;
	readonly artifacts: ArtifactSnapshotStore;
	readonly attention: VoiceAttentionSource;

	private readonly runtimes = new Map<string, ChannelRuntime>();

	constructor(opts: VoiceCallCoordinatorOptions) {
		this.stateDir = opts.stateDir;
		this.log = opts.log ?? (() => {});
		this.now = opts.now ?? Date.now;
		this.broker = opts.broker ?? httpBrokerClient();
		this.connectBridge = opts.connectBridge;
		this.emitCardFn = opts.emitCard;
		this.channelMemberUserIds = opts.channelMemberUserIds;
		this.journalPollIntervalMs = opts.journalPollIntervalMs ?? DEFAULT_JOURNAL_POLL_MS;
		this.livenessProbeIntervalMs = opts.livenessProbeIntervalMs ?? DEFAULT_LIVENESS_PROBE_MS;

		this.bindings = new CallBindingStore(this.stateDir, { log: this.log, now: this.now });
		this.artifacts = new ArtifactSnapshotStore(this.stateDir, { log: this.log, now: this.now });
		this.attention = new VoiceAttentionSource(this.stateDir, { log: this.log, push: opts.push });
		this.projection = new CallProjectionStore(this.stateDir, {
			log: this.log,
			now: this.now,
			onDecisionCard: (input) => this.onDecisionCard(input),
		});
	}

	private runtime(channelId: string): ChannelRuntime {
		let rt = this.runtimes.get(channelId);
		if (!rt) {
			rt = { ended: false };
			this.runtimes.set(channelId, rt);
		}
		return rt;
	}

	/** Start (or restart) a channel's runtime with a clean slate. Called at the top of `startCall`,
	 *  never by any reconnect/recovery path (those must keep reusing the SAME runtime object their
	 *  in-flight timers/callbacks already closed over — see `runtime()`). Without this, a channel that
	 *  hosted and ended a PREVIOUS call would hand the fresh call the previous runtime's `ended: true`
	 *  — `connectAndPin`'s stale-guard (`if (rt.ended) { client.close(); return; }`) would then close
	 *  the brand-new bridge the instant its `hello` arrives, and the binding would sit at `connecting`
	 *  forever even though `startCall` itself already returned `ok: true`. `beginConnecting` (called
	 *  just before this, in `startCall`) already guarantees any PRIOR binding on this channel is
	 *  `ended`, so replacing the map entry outright — rather than trying to reset fields on the reused
	 *  object — can never drop a still-active call's own state. */
	private resetRuntime(channelId: string): ChannelRuntime {
		const rt: ChannelRuntime = { ended: false };
		this.runtimes.set(channelId, rt);
		return rt;
	}

	/**
	 * Full per-channel runtime teardown — the ONE place a tailer, liveness timer, or bridge socket is
	 * guaranteed to stop outliving the binding it served. Called from `endBinding` (every termination
	 * path — terminal/journal-end/broker-exit/stale-binding/port-reused/start-failed/operator-ended —
	 * funnels through it, so a caller that already tore its own pieces down redundantly is harmless),
	 * from `onJournalMissing`'s already-ended branch (a leaked tailer that outlived its binding must
	 * still be shut down even when there's no NEW `endBinding` call to make), and from `stop()` at
	 * daemon shutdown. Idempotent: `JournalTailer.stop`, `clearInterval`, and
	 * `VoiceCallBridgeClient.close` are all themselves idempotent, so calling this twice — or on a
	 * channel with no runtime at all — is a harmless no-op.
	 */
	private teardownRuntime(channelId: string): void {
		const rt = this.runtime(channelId);
		rt.ended = true;
		rt.tailer?.stop();
		rt.tailer = undefined;
		this.stopLivenessProbe(channelId);
		try {
			rt.bridge?.close();
		} catch {
			/* best-effort */
		}
		rt.bridge = undefined;
		// A torn-down runtime has no mic to be muted. Leaving `true` here would have `state()` report
		// an ended call as muted, which is a claim about a session that no longer exists.
		rt.micMuted = undefined;
		// Concern 09: a torn-down runtime has no bridge left to relay audio for — an old sink lingering
		// here would silently swallow the NEXT call's onAudioFrame reads if a caller ever queried it
		// (it can't: `resetRuntime` always allocates a fresh object) and, more importantly, a stale
		// reference to a closed browser socket must never look attached.
		rt.audioSink = undefined;
	}

	/** @substrate exported for tests only — tests/voice-call-manager.test.ts asserts every
	 *  termination path actually tears down the per-channel runtime (tailer stopped, liveness probe
	 *  stopped, bridge closed), not merely that the binding reads `ended`. Never consulted by
	 *  production code: the daemon itself only ever needs the binding's own state (`state()`), never
	 *  "is anything still running for this channel" — a leaked timer is a bug the runtime should never
	 *  need to ask about itself. */
	hasActiveRuntime(channelId: string): boolean {
		const rt = this.runtimes.get(channelId);
		if (!rt) return false;
		return Boolean(rt.tailer || rt.bridge || rt.livenessTimer);
	}

	state(channelId: string): VoiceCallStateView | undefined {
		const binding = this.bindings.get(channelId);
		if (!binding) return undefined;
		const rt = this.runtimes.get(channelId);
		const controlsAvailable = binding.state === "live" && Boolean(rt?.bridge);
		return { ...redactBinding(binding), micMuted: rt?.micMuted === true, controlsAvailable, audioAvailable: binding.noLocalAudio === true && controlsAvailable };
	}

	list(): VoiceCallBindingView[] {
		return this.bindings.list().map(redactBinding);
	}

	ladderPriority(channelId: string): LadderPriority {
		return voiceChannelLadderPriority(this.projection.decisions(channelId));
	}

	decisions(channelId: string): JournalDecisionSnapshot[] {
		return this.projection.decisions(channelId);
	}

	gaps(channelId: string): JournalGap[] {
		return this.projection.gaps(channelId);
	}

	transcript(channelId: string): Promise<StoredTranscriptEntry[]> {
		const binding = this.bindings.get(channelId);
		return binding?.callId ? this.projection.transcript(binding.callId) : Promise.resolve([]);
	}

	listArtifacts(channelId: string): ArtifactSnapshotRecord[] {
		return this.artifacts.list(channelId);
	}

	/** One artifact's immutable snapshot bytes, for the room's Markdown viewer. Delegates straight to
	 *  the store — see `ArtifactSnapshotStore#read` for why every failure is a named state. */
	readArtifact(channelId: string, artifactId: string): Promise<ArtifactReadResult> {
		return this.artifacts.read(channelId, artifactId);
	}

	/**
	 * Thread-aware start: persists a `connecting` binding BEFORE dialing the broker, attaches the
	 * broker's response, tails the journal from the first byte, and pins the session identity the
	 * bridge's `hello` reports. Refuses when this channel already has a non-ended binding — V1 allows
	 * at most one active call per thread.
	 */
	async startCall(channelId: string, input: StartCallInput): Promise<CoordinatorResult<VoiceCallBindingView>> {
		let binding: VoiceCallBinding;
		try {
			binding = this.bindings.beginConnecting(channelId, {
				ownerActorId: input.ownerActorId,
				sessionRoot: input.sessionRoot ?? process.cwd(),
				retention: input.retention ?? "full",
				resumeSessionId: input.resumeSessionId,
			});
		} catch (err) {
			return { ok: false, reason: errText(err) };
		}
		await this.announceCallState(binding);
		const rt = this.resetRuntime(channelId);

		let created: BrokerCallCreated;
		try {
			created = await this.broker.createCall({ resume: input.resumeSessionId, retention: binding.retention });
		} catch (err) {
			await this.endBinding(channelId, "start-failed", errText(err));
			return { ok: false, reason: `broker: ${errText(err)}` };
		}
		// Reconcile the caller's own `sessionRoot` guess against the broker's authoritative answer for
		// where it actually ran `omp live` — see `resolveEffectiveSessionRoot`'s doc.
		const sessionRoot = await resolveEffectiveSessionRoot(input.sessionRoot, created.sessionRoot, this.log);
		binding = this.bindings.attachBroker(channelId, { ...created, sessionRoot, noLocalAudio: created.noLocalAudio });

		// Tail from the first byte — journal records land before the bridge or any viewer hears about
		// them (journal.ts's write-before-act contract), so tailing starts here, not after `hello`.
		rt.tailer = new JournalTailer({
			path: binding.journalPath!,
			intervalMs: this.journalPollIntervalMs,
			onEnvelope: (envelope) => this.onJournalEnvelope(channelId, envelope),
			onError: (err) => this.log(`voice-call ${channelId}: journal tail error: ${errText(err)}`),
			onMissing: () => void this.onJournalMissing(channelId),
		});
		// One immediate, awaited poll before the interval-driven ones: `JournalTailer`'s `everExisted`
		// guard (see its doc) means a journal-end this fast would otherwise never be detected — the
		// file could vanish in the gap before the FIRST timer tick ever fires without this. Also just
		// generally more responsive: any record already on disk by now is picked up right away rather
		// than waiting a full `journalPollIntervalMs`.
		await rt.tailer.poll();
		if (rt.ended) {
			// That first poll can consume a terminal record from a session that died between spawn and
			// attach (e.g. the speaker failed to open) — `endBinding` already ran the full teardown, so
			// `rt.tailer` is gone. Report the ended binding honestly instead of resurrecting anything.
			const ended = this.bindings.get(channelId);
			return { ok: false, reason: `session ended before attach: ${ended?.terminalError ?? ended?.terminalReason ?? "terminal"}` };
		}
		rt.tailer.start();

		try {
			await this.connectAndPin(channelId, binding, created.controlToken);
		} catch (err) {
			// The broker started a process but the bridge never answered — an honest, distinct
			// failure from a broker-side refusal.
			await this.endBinding(channelId, "start-failed", errText(err));
			return { ok: false, reason: `bridge: ${errText(err)}` };
		}
		const live = this.bindings.get(channelId)!;
		return { ok: true, value: redactBinding(live) };
	}

	/** Connects the bridge client, pins the session, and wires socket-loss → degraded + liveness
	 *  probe. Shared by `startCall` (first connect) and the degraded-recovery reconnect path. */
	private async connectAndPin(channelId: string, binding: VoiceCallBinding, controlToken: string | undefined): Promise<void> {
		const rt = this.runtime(channelId);
		const client = new VoiceCallBridgeClient({
			url: binding.bridgeUrl!,
			controlToken,
			sessionId: binding.sessionId,
			connect: this.connectBridge,
			onSocketLoss: () => void this.onSocketLoss(channelId),
			onTerminal: () => {
				// Presentation-plane signal only — see the module doc. The journal's own terminal
				// record (tailed independently) is what actually ends the binding.
			},
			// Concern 09: wired unconditionally — a device-audio call's bridge simply never sends a
			// `0x02` frame in the first place (see `LiveSessionController#handleOutputAudio`'s own
			// `noLocalAudio` gate on the OMP side), and an audio-less call with no browser attached YET
			// just has no `audioSink` to read here, which is a silent no-op, not an error.
			onAudioFrame: (bytes) => this.runtime(channelId).audioSink?.sendOutputAudio(bytes),
		});
		const hello = await client.connect();
		if (rt.ended) {
			// The runtime moved on (ended via another path, or `stop()`) while this connect attempt was
			// still in flight — never let a stale reconnect resurrect a binding that has already closed.
			client.close();
			return;
		}
		const pinned = this.bindings.pinSession(channelId, hello.sessionId);
		if (!pinned.ok) {
			client.close();
			await this.endBinding(channelId, "port-reused");
			throw new Error("a different session answered on this call's port — refusing to adopt it");
		}
		rt.bridge = client;
		rt.ended = false;
		const checked = this.checkRetentionMismatch(channelId, pinned.binding, hello.recordingMode);
		await this.announceCallState(checked);
	}

	/**
	 * Cross-checks what the session actually did (`hello.recordingMode` — set by whatever
	 * `OMP_LIVE_RECORDING_MODE` the broker's child process saw) against what the room asked for at
	 * attach time (`binding.retention`, sent to the broker as `createCall`'s `retention` option). The
	 * daemon sends the request; it does NOT get to assume the broker (a separate process, possibly a
	 * stale build, possibly misconfigured) actually honored it. `recordingMode` absent entirely is NOT
	 * a mismatch — an older bridge build never sends it at all (PROTOCOL.md's "Feature-off, not
	 * disconnected"), so there is no signal to disagree with, honest or otherwise. Persists (and
	 * returns the updated binding) only on an actual change — see `setRetentionMismatch`'s own
	 * idempotence.
	 */
	private checkRetentionMismatch(channelId: string, binding: VoiceCallBinding, reported: BridgeHelloFrame["recordingMode"]): VoiceCallBinding {
		if (reported === undefined || reported === binding.retention) {
			return binding.retentionMismatch ? this.bindings.setRetentionMismatch(channelId, undefined) : binding;
		}
		this.log(`voice-call ${channelId}: recording-mode mismatch — room retention "${binding.retention}", session reports "${reported}"`);
		return this.bindings.setRetentionMismatch(channelId, { expected: binding.retention, reported });
	}

	private async onSocketLoss(channelId: string): Promise<void> {
		const rt = this.runtime(channelId);
		if (rt.ended) return;
		const binding = this.bindings.get(channelId);
		if (!binding || binding.state === "ended") return;
		rt.bridge = undefined;
		const degraded = this.bindings.markDegraded(channelId, "socket-loss");
		await this.announceCallState(degraded);
		this.startLivenessProbe(channelId);
	}

	private startLivenessProbe(channelId: string): void {
		const rt = this.runtime(channelId);
		if (rt.livenessTimer) return;
		const tick = () => void this.probeLiveness(channelId).catch((err) => this.log(`voice-call ${channelId}: liveness probe failed: ${errText(err)}`));
		rt.livenessTimer = setInterval(tick, this.livenessProbeIntervalMs);
		rt.livenessTimer.unref?.();
		void tick();
	}

	private stopLivenessProbe(channelId: string): void {
		const rt = this.runtime(channelId);
		if (rt.livenessTimer) clearInterval(rt.livenessTimer);
		rt.livenessTimer = undefined;
	}

	/** One liveness check while `degraded`: ask the broker whether the process is still alive, and if
	 *  so, attempt to reconnect the bridge (which re-checks the pinned session identity). Re-entrancy
	 *  guarded (`rt.livenessProbing`, see `ChannelRuntime`'s doc) — a tick that outlasts the interval
	 *  must never overlap with the next one. */
	private async probeLiveness(channelId: string): Promise<void> {
		const rt = this.runtime(channelId);
		if (rt.livenessProbing) return;
		rt.livenessProbing = true;
		try {
			const binding = this.bindings.get(channelId);
			if (!binding || binding.state !== "degraded" || !binding.callId) {
				this.stopLivenessProbe(channelId);
				return;
			}
			let calls: BrokerCallView[];
			try {
				calls = await this.broker.listCalls();
			} catch {
				return; // broker itself unreachable right now — stay degraded, try again next tick
			}
			const mine = calls.find((c) => c.callId === binding.callId);
			if (!mine || mine.exit !== null) {
				this.stopLivenessProbe(channelId);
				await this.endBinding(channelId, "broker-exit");
				return;
			}
			// Broker says the process is still alive — try to reconnect the bridge socket.
			try {
				await this.connectAndPin(channelId, binding, binding.controlToken);
				this.stopLivenessProbe(channelId);
			} catch {
				// Still unreachable (or a port-reuse rejection already ended the binding above) — stay
				// degraded and let the next tick retry, unless connectAndPin already ended it.
				const after = this.bindings.get(channelId);
				if (after?.state === "ended") this.stopLivenessProbe(channelId);
			}
		} finally {
			rt.livenessProbing = false;
		}
	}

	/** Called once at daemon boot for every binding that was `connecting`/`live`/`degraded` when the
	 *  daemon last stopped — a restart has no live socket and no in-flight tailer for any of them, so
	 *  each must be corroborated against the broker before this daemon claims anything about it. */
	async rehydrateOnBoot(): Promise<void> {
		for (const binding of this.bindings.list()) {
			if (binding.state === "ended") continue;
			await this.rehydrateBinding(binding);
		}
	}

	private async rehydrateBinding(binding: VoiceCallBinding): Promise<void> {
		const channelId = binding.channelId;
		if (!binding.callId) {
			// Never got past `connecting` before the restart — nothing to corroborate; it never lived.
			await this.endBinding(channelId, "stale-binding");
			return;
		}
		let calls: BrokerCallView[];
		try {
			calls = await this.broker.listCalls();
		} catch {
			await this.endBinding(channelId, "stale-binding");
			return;
		}
		const mine = calls.find((c) => c.callId === binding.callId);
		if (!mine) {
			await this.endBinding(channelId, "stale-binding");
			return;
		}
		if (mine.exit !== null) {
			await this.endBinding(channelId, "broker-exit");
			return;
		}
		// The broker still lists it as alive — resume tailing and try to reconnect the bridge, exactly
		// like a post-socket-loss recovery. Start `degraded` (honest: we have no live socket yet).
		const degraded = this.bindings.markDegraded(channelId, "socket-loss");
		await this.announceCallState(degraded);
		const rt = this.runtime(channelId);
		rt.tailer = new JournalTailer({
			path: binding.journalPath!,
			intervalMs: this.journalPollIntervalMs,
			onEnvelope: (envelope) => this.onJournalEnvelope(channelId, envelope),
			onError: (err) => this.log(`voice-call ${channelId}: journal tail error: ${errText(err)}`),
			onMissing: () => void this.onJournalMissing(channelId),
		});
		// One immediate, awaited poll before the interval-driven ones: `JournalTailer`'s `everExisted`
		// guard (see its doc) means a journal-end this fast would otherwise never be detected — the
		// file could vanish in the gap before the FIRST timer tick ever fires without this. Also just
		// generally more responsive: any record already on disk by now is picked up right away rather
		// than waiting a full `journalPollIntervalMs`.
		await rt.tailer.poll();
		if (rt.ended) {
			// Same pre-attach terminal race as `startCall`: the rehydration poll itself may have
			// consumed a terminal record and torn the runtime down. Nothing left to start.
			return;
		}
		rt.tailer.start();
		this.startLivenessProbe(channelId);
	}

	/**
	 * Fired by the tailer only once the journal file has been seen to exist and then disappeared
	 * (`JournalTailer`'s `everExisted` guard — see its doc: a file that has simply never been created
	 * yet, lazily per `LiveJournal#defaultWriter`, is never itself a signal). By the time this fires,
	 * the honest fact is "journal-end": the process died without ever writing a terminal record, or
	 * its call directory was removed out from under it.
	 */
	private async onJournalMissing(channelId: string): Promise<void> {
		const rt = this.runtime(channelId);
		const alreadyTornDown = rt.ended;
		// Tear this channel's runtime down UNCONDITIONALLY, even when the binding already ended via
		// another path (broker-exit, port-reused, ...) that never itself owned THIS tailer's shutdown —
		// otherwise a leaked tailer just keeps polling the (now-gone) journal path and re-firing
		// `onMissing` every tick, forever, since the old early return here never touched it.
		this.teardownRuntime(channelId);
		if (alreadyTornDown) return;
		const binding = this.bindings.get(channelId);
		if (!binding || binding.state === "ended") return;
		await this.endBinding(channelId, "journal-end");
	}

	private async onJournalEnvelope(channelId: string, envelope: JournalEnvelope): Promise<void> {
		const binding = this.bindings.get(channelId);
		if (!binding || !binding.callId) return;
		const outcome = await this.projection.applyEnvelope(channelId, binding.callId, envelope, binding.retention);
		this.bindings.updateJournalCursor(channelId, envelope.seq);
		if (outcome.status === "applied-decision" && outcome.cardKind === "terminal") {
			this.attention.dismiss(channelId, outcome.decision.id);
		}
		if (outcome.status === "applied-decision" && outcome.cardKind === "mint") {
			const userIds = await this.channelMemberUserIds?.(channelId);
			await this.attention.notifyIfDue(channelId, outcome.decision, userIds);
		}
		if (outcome.status === "applied-artifact") {
			const artifact = outcome.artifact;
			if (artifact.status === "ready") {
				await this.artifacts.snapshotReady({ channelId, callId: binding.callId, sessionRoot: binding.sessionRoot, sourcePath: artifact.path });
			} else {
				this.artifacts.recordFailed({ channelId, callId: binding.callId, sessionRoot: binding.sessionRoot, sourcePath: artifact.path }, "journal reported artifact status: failed");
			}
		}
		if (outcome.status === "applied-idle-warning") {
			// Nothing to project — OMP already spoke the warning over its own live session; this
			// daemon has no HUD countdown to update from it. The record exists so the journal (and this
			// tailer's cursor) has an honest entry for it, matching the terminal record that follows.
		}
		if (outcome.status === "applied-terminal") {
			// `endBinding` itself runs the full runtime teardown (tailer/liveness/bridge) now — see its
			// doc. `reason === "idle"` (concern 05's idle-hangup policy) is projected as its OWN distinct
			// binding reason, not folded into the generic "terminal" every other clean/errored journaled
			// end maps to — see VoiceCallTerminalReason's doc.
			await this.endBinding(channelId, outcome.reason === "idle" ? "idle" : "terminal", outcome.error);
		}
	}

	private async onDecisionCard(input: EmitVoiceDecisionCardInput): Promise<void> {
		const payload = voiceDecisionFacePayload(input.channelId, input.callId, input.decision, input.cardKind);
		const event = emitVoiceDecisionCard(payload);
		await this.emitCardFn({ channelId: input.channelId, kind: "voice-decision", text: input.decision.prompt, payload: event.payload });
	}

	private async announceCallState(binding: VoiceCallBinding): Promise<void> {
		const payload = voiceCallFacePayload(binding);
		const event = emitVoiceCallCard(payload);
		await this.emitCardFn({ channelId: binding.channelId, kind: "voice-call", text: `voice call ${binding.state}`, payload: event.payload });
	}

	/**
	 * The ONE path that ends a binding: marks it terminal, tears down the FULL per-channel runtime
	 * (`teardownRuntime` — tailer stopped, liveness probe stopped, bridge closed with its handlers
	 * detached), announces the state, and runs the SAME end-of-call cleanup every terminal/journal-
	 * end/broker-exit/stale-binding/port-reused/start-failed/operator-ended path needs (DESIGN.md risk
	 * table): expire every still-open/awaiting decision (there is no arbiter left to do it properly),
	 * clear their attention/push dedup entries, and — the production defect this closes — best-effort
	 * reap the broker's own call record (`reapBrokerCall`) so a binding that ends here never leaves a
	 * broker-spawned `omp live` process running with nothing attached to it. Idempotent by
	 * construction — `markEnded`, `teardownRuntime`, and `expireActiveDecisions` all no-op on an
	 * already-terminal/torn-down input, so calling this on an already-ended binding (or a caller that
	 * already tore its own pieces down redundantly) is harmless; `wasActive` below additionally
	 * guarantees the broker reap itself only ever fires on the ONE call that actually transitions a
	 * binding to `ended`, never on a redundant second call.
	 */
	private async endBinding(channelId: string, reason: VoiceCallTerminalReason, error?: string | null): Promise<VoiceCallBinding> {
		const before = this.bindings.get(channelId);
		const wasActive = before !== undefined && before.state !== "ended";
		const ended = this.bindings.markEnded(channelId, reason, error);
		this.teardownRuntime(channelId);
		await this.announceCallState(ended);
		if (ended.callId) {
			const expired = await this.projection.expireActiveDecisions(channelId, ended.callId);
			for (const decision of expired) this.attention.dismiss(channelId, decision.id);
		}
		// `ended.terminalReason` (not the `reason` parameter) governs the reap decision: `markEnded` is
		// idempotent and keeps the FIRST honest reason a binding ended, so a redundant `endBinding` call
		// with a DIFFERENT reason than the one that actually stuck must still reap (or skip reaping)
		// according to what really happened — moot in practice since `wasActive` already keeps this to
		// one call, but correct either way.
		if (wasActive && ended.callId) await this.reapBrokerCall(channelId, ended.callId, ended.terminalReason ?? reason);
		return ended;
	}

	/**
	 * Best-effort broker cleanup for the production defect this closes: a broker-spawned `omp live`
	 * process that keeps running and speaking with no binding attached, because nothing ever told the
	 * broker the daemon was done with it. Skipped only for `"terminal"` and `"journal-end"` — the two
	 * reasons that mean the OMP session already ended ITSELF (an explicit journaled terminal record,
	 * or the journal disappearing because the process is already gone) — every other terminal reason
	 * (`start-failed`, `stale-binding`, `port-reused`, `broker-exit`, `idle`, `operator-ended`) can
	 * leave a broker-tracked call whose process is still alive with nothing bound to it, so all of them
	 * get a reap attempt. `broker-exit` and `idle` are the deliberately-defensive over-approximation:
	 * `broker-exit` has already been corroborated dead by `listCalls`, and `idle` is itself journaled
	 * exactly like `terminal`, so in both cases the broker's own `DELETE /calls/:id` is expected to be
	 * a harmless no-op/404 — but calling it anyway costs nothing and closes off any window where that
	 * assumption turns out to be wrong. Never throws: the broker may be down, may have already reaped
	 * the call itself, or may 404 on an already-gone callId — any of those means there is nothing left
	 * orphaned, which is exactly the outcome this method exists to guarantee, so a failure here is
	 * logged (bounded — one line, no retry loop) and never propagated. Called only from `endBinding`,
	 * strictly after the binding's own state has already been persisted as `ended` — a reap failure can
	 * therefore never prevent, delay-fail, or roll back the binding end itself.
	 */
	private async reapBrokerCall(channelId: string, callId: string, reason: VoiceCallTerminalReason): Promise<void> {
		if (reason === "terminal" || reason === "journal-end") return;
		try {
			await this.broker.endCall(callId);
		} catch (err) {
			this.log(`voice-call ${channelId}: broker reap of call ${callId} failed (reason=${reason}, broker may already be down or the call already gone): ${errText(err)}`);
		}
	}

	/** Authenticated, role/membership-checked decision resolution relay. `isAuthorized` is computed
	 *  by the caller (room membership + role tier) and re-checked here as the last gate before any
	 *  bridge frame is sent — the daemon relays the tokenized bridge control only past this point. */
	async resolveDecision(channelId: string, isAuthorized: boolean, input: { decisionId: string; optionIndex: number; label: string; confirmToken?: string }): Promise<CoordinatorResult<BridgeControlAck>> {
		if (!isAuthorized) return { ok: false, reason: "forbidden" };
		const binding = this.bindings.get(channelId);
		if (!binding || binding.state === "ended") return { ok: false, reason: "no-active-call" };
		const rt = this.runtime(channelId);
		if (binding.state !== "live" || !rt.bridge) return { ok: false, reason: "bridge-unavailable" };
		const ack = await rt.bridge.resolveDecision(input);
		return { ok: true, value: ack };
	}

	/**
	 * Visible mute (concern 03's call HUD). The wire control is `toggleMute` — unauthenticated and
	 * ack-less by PROTOCOL.md — so this layer makes it IDEMPOTENT and stateful daemon-side: it tracks
	 * what it last asked for and sends a toggle only when the request actually differs. Without that,
	 * two clients (or one double-click) race the mic back open, and the HUD has no honest value to
	 * render at all.
	 *
	 * The returned `muted` is therefore "what the daemon has asked the session for", never a
	 * confirmed mic state — the HUD's own copy says exactly that rather than implying a read-back the
	 * protocol cannot provide.
	 */
	async setMuted(channelId: string, isAuthorized: boolean, muted: boolean): Promise<CoordinatorResult<{ muted: boolean }>> {
		if (!isAuthorized) return { ok: false, reason: "forbidden" };
		const binding = this.bindings.get(channelId);
		if (!binding || binding.state === "ended") return { ok: false, reason: "no-active-call" };
		const rt = this.runtime(channelId);
		if (binding.state !== "live" || !rt.bridge) return { ok: false, reason: "bridge-unavailable" };
		if ((rt.micMuted === true) === muted) return { ok: true, value: { muted } };
		try {
			rt.bridge.toggleMute();
		} catch (err) {
			return { ok: false, reason: errText(err) };
		}
		rt.micMuted = muted;
		return { ok: true, value: { muted } };
	}

	/**
	 * Registers a browser's audio sink for a channel's live call (concern 09: browser-audio-transport)
	 * — the daemon-side half of "speaker PCM leaves via the bridge instead of a local device". Gated
	 * on the SAME preconditions `resolveDecision`/`steer`/`setMuted` already require (authorized,
	 * active binding, `live`, a connected bridge) PLUS one more this class owns alone:
	 * `binding.noLocalAudio === true` — a device-audio call already owns a real speaker and must never
	 * ALSO hand its output audio to a browser, which would be feeding the same session's voice out of
	 * two places at once.
	 *
	 * Returns a `detach()` that clears the sink ONLY if it is STILL the one this call attached — a
	 * slow/delayed detach (e.g. a browser tab's cleanup racing a fast reconnect that already attached
	 * a NEWER sink) must never clear a sink it does not own. Exactly one sink is held per channel: a
	 * second `attachAudioSink` call replaces the first outright (V1 scope is one viewer's audio relay
	 * per call, matching the "at most one active call per thread" boundary this whole feature already
	 * lives inside) — the FIRST sink's own `detach()` becomes a harmless no-op once that happens, since
	 * `rt.audioSink` no longer `===` it.
	 */
	attachAudioSink(channelId: string, isAuthorized: boolean, sink: { sendOutputAudio: (bytes: Uint8Array) => void }): CoordinatorResult<{ detach: () => void }> {
		if (!isAuthorized) return { ok: false, reason: "forbidden" };
		const binding = this.bindings.get(channelId);
		if (!binding || binding.state === "ended") return { ok: false, reason: "no-active-call" };
		if (binding.noLocalAudio !== true) return { ok: false, reason: "device-audio-call" };
		const rt = this.runtime(channelId);
		if (binding.state !== "live" || !rt.bridge) return { ok: false, reason: "bridge-unavailable" };
		rt.audioSink = sink;
		return { ok: true, value: { detach: () => { if (rt.audioSink === sink) rt.audioSink = undefined; } } };
	}

	/**
	 * Relays one chunk of browser microphone PCM towards the session (concern 09) — mono 16 kHz
	 * `Float32`, the format `VoiceCallBridgeClient#sendMicAudio`/oh-my-pi's own `AudioCapture` both
	 * use. Same authorization and `noLocalAudio` gate as `attachAudioSink`; deliberately does NOT
	 * require a sink to already be attached — a browser that only sends (never wants output audio
	 * relayed back, or has its own separate connection for that) is not something this layer should
	 * refuse just because it never called `attachAudioSink`.
	 */
	async pushMicAudio(channelId: string, isAuthorized: boolean, samples: Float32Array): Promise<CoordinatorResult<true>> {
		if (!isAuthorized) return { ok: false, reason: "forbidden" };
		const binding = this.bindings.get(channelId);
		if (!binding || binding.state === "ended") return { ok: false, reason: "no-active-call" };
		if (binding.noLocalAudio !== true) return { ok: false, reason: "device-audio-call" };
		const rt = this.runtime(channelId);
		if (binding.state !== "live" || !rt.bridge) return { ok: false, reason: "bridge-unavailable" };
		try {
			rt.bridge.sendMicAudio(samples);
		} catch (err) {
			return { ok: false, reason: errText(err) };
		}
		return { ok: true, value: true };
	}

	async steer(channelId: string, isAuthorized: boolean, text: string): Promise<CoordinatorResult<true>> {
		if (!isAuthorized) return { ok: false, reason: "forbidden" };
		const binding = this.bindings.get(channelId);
		if (!binding || binding.state === "ended") return { ok: false, reason: "no-active-call" };
		const rt = this.runtime(channelId);
		if (binding.state !== "live" || !rt.bridge) return { ok: false, reason: "bridge-unavailable" };
		rt.bridge.steer(text);
		return { ok: true, value: true };
	}

	/** Operator-initiated end. Relays `stop` (best-effort — a degraded/unreachable call has no socket
	 *  to relay to) and marks the binding ended with the honest `operator-ended` reason regardless of
	 *  whether the relay succeeded, since the human's intent to end it is the fact that matters. The
	 *  broker's own call record is reaped by `endBinding` itself (`reapBrokerCall` — `operator-ended`
	 *  is not one of its two self-terminated exemptions), so there is no separate `broker.endCall` here
	 *  — one reap call site for every termination path, not two racing to do the same thing. */
	async endCall(channelId: string, isAuthorized: boolean): Promise<CoordinatorResult<VoiceCallBindingView>> {
		if (!isAuthorized) return { ok: false, reason: "forbidden" };
		const binding = this.bindings.get(channelId);
		if (!binding) return { ok: false, reason: "no-active-call" };
		if (binding.state === "ended") return { ok: true, value: redactBinding(binding) };
		const rt = this.runtime(channelId);
		rt.ended = true; // set early — guards a concurrent liveness-probe reconnect (connectAndPin's own `rt.ended` check) against resurrecting this binding while the broker round-trip below is in flight.
		try {
			rt.bridge?.stop(); // the wire "stop" control frame — distinct from, and sent before, closing the socket.
		} catch {
			/* best-effort */
		}
		// `endBinding` runs the full runtime teardown (tailer/liveness/bridge close) AND the broker reap
		// — see both docs.
		const ended = await this.endBinding(channelId, "operator-ended");
		return { ok: true, value: redactBinding(ended) };
	}

	stop(): void {
		// Daemon shutdown, NOT call termination — bindings stay whatever state they were in (a live
		// binding is still live on disk) so `rehydrateOnBoot` has something honest to corroborate next
		// start; only the in-process runtime (tailer/liveness/bridge) is torn down here.
		for (const channelId of this.runtimes.keys()) this.teardownRuntime(channelId);
		this.bindings.stop();
	}
}
