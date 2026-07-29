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
import { emitVoiceCallCard, emitVoiceDecisionCard, emitVoiceFleetActionCard } from "./schema/channel-card.ts";
import type { CardPayloadType } from "./schema/channel-card.ts";
import { TRANSCRIPT_EVENT_VOICE_CALL, TRANSCRIPT_EVENT_VOICE_DECISION, TRANSCRIPT_EVENT_VOICE_FLEET_ACTION } from "./transcript-event-kinds.ts";
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
import { VoiceCallBridgeClient, type BridgeConnectFn, type BridgeControlAck, type BridgeFleetCall, type BridgeHelloFrame, type BridgeTranscriptFrame } from "./voice-call-bridge-client.ts";
import { VoiceCallAudioMixer } from "./voice-call-audio-mixer.ts";
import { JournalTailer, type JournalEnvelope } from "./voice-call-journal.ts";
import type { JournalFleetAction } from "./voice-call-journal.ts";
import { CallProjectionStore, type DeferredFleetAction, type EmitVoiceDecisionCardInput, type EmitVoiceFleetActionCardInput, type JournalGap, type StoredTranscriptEntry } from "./voice-call-projection.ts";
import { fleetActionCardTitle, type VoiceFleetActionCardStatus, type VoiceFleetExecResult, type VoiceFleetWireResult, type VoiceOwnerActor } from "./voice-fleet.ts";
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
	kind: "voice-call" | "voice-decision" | "voice-fleet-action";
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
	/**
	 * Concern 11 (voice-transcript-in-thread): fired once per journaled transcript record that was
	 * actually appended to disk (never for a duplicate replay or a failed append — see
	 * `CallProjectionStore#applyEnvelope`'s own cursor-advance discipline). The caller (`SquadManager`)
	 * turns this into a `SquadEvent` push so a call's conversation pane can update in place the moment
	 * a turn lands, without waiting for its next poll. Additive and optional: a caller that never
	 * passes it (every existing test fixture) loses nothing — the turn is still durably appended and
	 * still readable via `transcript()`/`GET .../voice-call/transcript`, just without the live nudge.
	 */
	onTranscriptTurn?: (input: { channelId: string; callId: string; entry: StoredTranscriptEntry }) => void;
	/**
	 * Live captions fix (production defect, 2026-07-28): fired for every `{type:"transcript"}`
	 * presentation frame the bridge broadcasts as the agent speaks — including every non-final
	 * (`final:false`) partial, streamed word-by-word, never just the finalized turn. DELIBERATELY
	 * separate from `onTranscriptTurn` above: this is a presentation-plane nudge only, never touches
	 * the journal or `CallProjectionStore` (DESIGN.md's boundary — presentation frames never mutate
	 * durable state), so it carries none of that callback's "once per record actually appended to
	 * disk" guarantee — the SAME `(role, turn)` key can fire here many times as one utterance grows,
	 * by design. The caller (`SquadManager`) pushes it as the SAME `"voice-call-transcript-turn"`
	 * `SquadEvent` `onTranscriptTurn` already uses — the webapp's existing `mergeLiveTurn` (keyed
	 * `(role, turn)`, replace-in-place) neither knows nor cares whether a given push came from a live
	 * bridge frame or a durably-appended journal record; the journal's own eventual `final:true` push
	 * for the same key supersedes any partial exactly the way a later partial supersedes an earlier
	 * one. Additive and optional: a caller that never passes it loses only the live-captions nudge —
	 * the finalized turn still lands via `onTranscriptTurn` once the journal is tailed.
	 */
	onLiveTranscriptFrame?: (input: { channelId: string; callId: string; entry: StoredTranscriptEntry }) => void;
	/**
	 * Concern 13 (multi-party-calls): fired once per browser that successfully attaches an audio
	 * sink (`attachAudioSink`) — a genuine join, not a reconnect racing the same connId (see that
	 * method's own detach-identity guard). The caller (`SquadManager`) journals this as a call event
	 * and turns it into presence the HUD/call pane can render. Additive and optional: a daemon that
	 * never wires it loses only presence/join history, never the ability to attach at all.
	 */
	onParticipantJoined?: (input: { channelId: string; callId: string; participant: VoiceCallParticipant }) => void;
	/** Concern 13: fired once per attached sink that actually detaches (own-identity guarded, same as
	 *  `onParticipantJoined`'s join). Never fired for a stale/superseded detach that no longer owns
	 *  the connId's entry — see `attachAudioSink`'s own doc. */
	onParticipantLeft?: (input: { channelId: string; callId: string; participant: VoiceCallParticipant }) => void;
	/**
	 * Concern 12 (voice-fleet-delegation): execute one fleet tool call relayed from the live
	 * session, as `ownerActor` (the call owner's snapshotted identity — the caller enforces the
	 * SAME membership/RBAC gates a UI command from that actor passes; this coordinator has no RBAC
	 * of its own, per the module doc). `approvedDecisionId` is set only on the deferred-execution
	 * path — a destructive action whose UI decision just resolved with the approve option — and is
	 * the executor's signal to skip its own destructive re-classification for this one call.
	 * Absent entirely ⇒ this daemon has no fleet execution wired; relayed calls fail honestly.
	 */
	executeFleetCall?: (input: { channelId: string; ownerActor: VoiceOwnerActor | undefined; tool: string; args: unknown; approvedDecisionId?: string }) => Promise<VoiceFleetExecResult>;
	/** Concern 12: compose the room-context brief injected at fleet attach (roster, states, open
	 *  decisions, plan summary — the manager owns all of these; `scopeAgentId` scopes it to one
	 *  unit's detail for a per-agent start). `undefined` ⇒ attach without context. */
	buildFleetContext?: (input: { channelId: string; ownerActor: VoiceOwnerActor | undefined; scopeAgentId?: string }) => Promise<string | undefined>;
}

/** A broker-tracked call process (`BrokerClient#listCalls`) with no corresponding non-ended binding in
 *  THIS daemon's own store — the calls-management surface's (concern 10) "ORPHAN" row: a process the
 *  broker still lists as running that nothing in the room can see, end, or reattach to through the
 *  normal per-channel binding APIs, because there is no channel to route through. Distinct from a
 *  binding sitting in `degraded` (which DOES have a channel and normal End/Reattach controls) — an
 *  orphan is the case those controls cannot reach at all. */
export interface VoiceCallOrphan {
	callId: string;
	port?: number;
	startedAt?: number;
	sessionRoot?: string;
	noLocalAudio?: boolean;
}

export interface VoiceCallsSurface {
	/** Every binding this coordinator knows about, any state including `ended` — the caller
	 *  (`SquadManager#listVoiceCallsSurface`) filters this down to the channels the requesting actor
	 *  can actually read before it ever reaches a response body. */
	bindings: VoiceCallBindingView[];
	orphans: VoiceCallOrphan[];
}

export interface StartCallInput {
	ownerActorId: string;
	/** Concern 12 — the owner's full identity snapshot; see `VoiceCallBinding.ownerActor`. */
	ownerActor?: VoiceOwnerActor;
	/** Concern 12 — per-agent scoped start; see `VoiceCallBinding.scopeAgentId`. */
	agentId?: string;
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
	/** Concern 13 (multi-party-calls): every browser currently attached via `attachAudioSink`, for
	 *  presence in the call pane/HUD — "who is in this call right now". Empty for a device-audio
	 *  call (nothing can attach) or a call with nobody attached yet, never undefined — a caller
	 *  should not have to distinguish "no presence data" from "no one is here". */
	participants: VoiceCallParticipant[];
}

const DEFAULT_JOURNAL_POLL_MS = 400;
const DEFAULT_LIVENESS_PROBE_MS = 5_000;
/** Concern 13 (multi-party-calls): the connId a caller gets when it does not pass one to
 *  `attachAudioSink`/`pushMicAudio` — every pre-concern-13 caller (and every test written before
 *  multi-party calls existed) implicitly means "the one relay this call has", so defaulting BOTH
 *  methods to the SAME constant keeps their behavior identical to the old single-sink design when
 *  nobody opts into multi-party identity. */
const DEFAULT_PARTICIPANT_CONN_ID = "__default__";

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

/**
 * Concern 13 (multi-party-calls): one browser's attached audio relay, tagged from the
 * AUTHENTICATED WS session at attach time (`server.ts`'s `openVoiceAudioSocket` already resolves
 * an `Actor` before ever calling `attachAudioSink` — the daemon never has to guess who is
 * speaking). Keyed by a per-CONNECTION id, deliberately distinct from `actorId`: the same human
 * opening two tabs is two participants (two independent mic/speaker relays kept alive
 * independently), never one silently replacing the other the way the old single-sink design used
 * to force.
 */
export interface VoiceCallParticipant {
	connId: string;
	actorId: string;
	displayName?: string;
	/** True for the call's HOST — computed once at attach time by comparing `actorId` against
	 *  `binding.ownerActorId` (the actor who started the call, per the concern doc's "the person
	 *  who starts the call is the HOST"). Never re-derived later: a call keeps the same host for
	 *  its whole life, even if the host's own connection drops and reconnects. */
	host: boolean;
	joinedAt: number;
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
	 * Concern 09 (browser-audio-transport), generalized to N by concern 13 (multi-party-calls): every
	 * browser currently attached via `attachAudioSink`, keyed by its own connection id. Each receives
	 * decoded output PCM the bridge forwards (wired once, in `connectAndPin`, regardless of whether
	 * any sink is attached yet — the bridge callback simply fans out over whatever is in this map at
	 * delivery time — see `onAudioFrame`). Cleared with the rest of the runtime, so a new call never
	 * inherits the previous call's sinks, and a torn-down runtime never keeps feeding audio nobody
	 * asked for.
	 */
	audioSinks: Map<string, { participant: VoiceCallParticipant; sink: { sendOutputAudio: (bytes: Uint8Array) => void } }>;
	/**
	 * Concern 13: additive-mixes every attached participant's mic PCM into the ONE input stream the
	 * realtime provider accepts — see `voice-call-audio-mixer.ts`'s own module doc for the full
	 * tradeoff against push-to-talk floor control. Built lazily on the first `pushMicAudio` call (an
	 * audio-less call with no browser attached yet needs no mixer at all) and torn down with the rest
	 * of the runtime.
	 */
	mixer?: VoiceCallAudioMixer;
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
	private readonly onTranscriptTurnFn: ((input: { channelId: string; callId: string; entry: StoredTranscriptEntry }) => void) | undefined;
	private readonly onLiveTranscriptFrameFn: ((input: { channelId: string; callId: string; entry: StoredTranscriptEntry }) => void) | undefined;
	private readonly onParticipantJoinedFn: VoiceCallCoordinatorOptions["onParticipantJoined"];
	private readonly onParticipantLeftFn: VoiceCallCoordinatorOptions["onParticipantLeft"];
	private readonly executeFleetCall: VoiceCallCoordinatorOptions["executeFleetCall"];
	private readonly buildFleetContext: VoiceCallCoordinatorOptions["buildFleetContext"];

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
		this.onTranscriptTurnFn = opts.onTranscriptTurn;
		this.onLiveTranscriptFrameFn = opts.onLiveTranscriptFrame;
		this.onParticipantJoinedFn = opts.onParticipantJoined;
		this.onParticipantLeftFn = opts.onParticipantLeft;
		this.executeFleetCall = opts.executeFleetCall;
		this.buildFleetContext = opts.buildFleetContext;

		this.bindings = new CallBindingStore(this.stateDir, { log: this.log, now: this.now });
		this.artifacts = new ArtifactSnapshotStore(this.stateDir, { log: this.log, now: this.now });
		this.attention = new VoiceAttentionSource(this.stateDir, { log: this.log, push: opts.push });
		this.projection = new CallProjectionStore(this.stateDir, {
			log: this.log,
			now: this.now,
			onDecisionCard: (input) => this.onDecisionCard(input),
			onFleetActionCard: (input) => this.onFleetActionCard(input),
		});
	}

	private runtime(channelId: string): ChannelRuntime {
		let rt = this.runtimes.get(channelId);
		if (!rt) {
			rt = { ended: false, audioSinks: new Map() };
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
		const rt: ChannelRuntime = { ended: false, audioSinks: new Map() };
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
		// Concern 09/13: a torn-down runtime has no bridge left to relay audio for — sinks lingering
		// here would silently swallow the NEXT call's onAudioFrame reads if a caller ever queried it
		// (it can't: `resetRuntime` always allocates a fresh object) and, more importantly, a stale
		// reference to a closed browser socket must never look attached.
		rt.audioSinks.clear();
		rt.mixer?.stop();
		rt.mixer = undefined;
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
		const participants = rt ? [...rt.audioSinks.values()].map((entry) => entry.participant) : [];
		return { ...redactBinding(binding), micMuted: rt?.micMuted === true, controlsAvailable, audioAvailable: binding.noLocalAudio === true && controlsAvailable, participants };
	}

	list(): VoiceCallBindingView[] {
		return this.bindings.list().map(redactBinding);
	}

	/**
	 * Concern 10 (call-management-ui): every binding this coordinator knows about, PLUS every broker
	 * call process that has no corresponding non-ended binding — an ORPHAN, the production-observed
	 * failure this surface exists to close ("three orphan reaps required manual curl against the
	 * broker"). A broker call already covered by one of this coordinator's own live/degraded/
	 * connecting bindings is never double-listed as an orphan just because that binding happens to be
	 * mid-reconnect; only a call the broker still lists as running (`exit === null`) with NO matching
	 * binding at all counts. A broker that cannot be reached logs and reports zero orphans rather than
	 * failing the whole surface — the bindings half of the answer is still worth having.
	 */
	async listCallsSurface(): Promise<VoiceCallsSurface> {
		const bindings = this.list();
		const knownCallIds = new Set(bindings.filter((binding) => binding.state !== "ended" && binding.callId).map((binding) => binding.callId!));
		let orphans: VoiceCallOrphan[] = [];
		try {
			const calls = await this.broker.listCalls();
			orphans = calls
				.filter((call) => call.exit === null && !knownCallIds.has(call.callId))
				.map((call) => ({ callId: call.callId, port: call.port, startedAt: call.startedAt, sessionRoot: call.sessionRoot, noLocalAudio: call.noLocalAudio }));
		} catch (err) {
			this.log(`voice-call: could not list broker calls for the calls-management surface: ${errText(err)}`);
		}
		return { bindings, orphans };
	}

	/**
	 * Ends a broker call that has no channel to route through (an orphan — see `listCallsSurface`).
	 * There is no binding, so there is nothing for `endBinding`'s own chokepoint to do here; this is
	 * the one call site allowed to hit `broker.endCall` directly, precisely because it is reaping a
	 * process `endBinding` never owned in the first place. Never throws outward — a broker that is
	 * down, or has already reaped the call itself, or 404s on an already-gone id all mean there is
	 * nothing left orphaned, which is what this method exists to guarantee.
	 */
	async endOrphan(callId: string): Promise<CoordinatorResult<{ ended: true }>> {
		try {
			await this.broker.endCall(callId);
			return { ok: true, value: { ended: true } };
		} catch (err) {
			return { ok: false, reason: errText(err) };
		}
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
				ownerActor: input.ownerActor,
				scopeAgentId: input.agentId,
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
			// just has no attached sinks to read here, which is a silent no-op, not an error. Concern 13:
			// fans out to EVERY currently-attached browser, not just one — the multi-party generalization
			// of what used to be a single `audioSink?.sendOutputAudio` dereference.
			onAudioFrame: (bytes) => { for (const entry of this.runtime(channelId).audioSinks.values()) entry.sink.sendOutputAudio(bytes); },
			// Concern 12: wired unconditionally too — a bridge that never advertised `canFleet` simply
			// never sends a `fleetCall`, and the handler itself re-checks the live-binding preconditions.
			onFleetCall: (call) => void this.onFleetCall(channelId, call).catch((err) => this.log(`voice-call ${channelId}: fleet call handling failed: ${errText(err)}`)),
			// Live captions fix: wired unconditionally, same rule as onAudioFrame/onFleetCall above — a
			// bridge that predates this fix simply never sends a `transcript` frame this client would
			// otherwise not recognize, and the handler itself re-checks the live-binding preconditions.
			onTranscriptFrame: (frame) => this.onLiveTranscriptFrame(channelId, frame),
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
		// Concern 12: become the call's fleet executor, seeding the session with the room's projection.
		// AFTER pin+announce — the call is live either way, and a refused/failed attach must degrade to
		// "no fleet surface" (the tools fail honestly OMP-side), never to a failed connect.
		if (hello.canFleet === true && this.executeFleetCall) {
			await this.attachFleetExecutor(channelId, client, pinned.binding);
		}
	}

	/** Fleet attach (concern 12): compose the room-context brief (best-effort — a brief that cannot
	 *  be built must not cost the attach) and register this daemon as the call's executor. Failures
	 *  log and leave the call fully usable without a fleet surface; the same method serves first
	 *  connect, liveness-probe reconnects, and user-triggered reattach, so a reconnected call
	 *  re-seeds a FRESH brief (the roster has usually moved since the socket dropped). */
	private async attachFleetExecutor(channelId: string, client: VoiceCallBridgeClient, binding: VoiceCallBinding): Promise<void> {
		let context: string | undefined;
		try {
			context = await this.buildFleetContext?.({ channelId, ownerActor: binding.ownerActor, scopeAgentId: binding.scopeAgentId });
		} catch (err) {
			this.log(`voice-call ${channelId}: fleet context build failed (attaching without context): ${errText(err)}`);
		}
		try {
			const ack = await client.attachFleet(context);
			if (!ack.ok) this.log(`voice-call ${channelId}: fleet attach refused: ${ack.reason ?? "unknown"}`);
		} catch (err) {
			this.log(`voice-call ${channelId}: fleet attach failed: ${errText(err)}`);
		}
	}

	/**
	 * One relayed fleet tool call (concern 12). Preconditions mirror `steer`/`resolveDecision`'s
	 * own live-binding gates; execution itself is the injected `executeFleetCall` (the caller owns
	 * membership/RBAC — module doc). A destructive refusal (`needs-decision`) durably queues the
	 * action under a coordinator-minted `deferredActionId` BEFORE the refusal rides back, so the
	 * decision OMP mints can always be linked to a queued action this daemon still knows about.
	 * Every path answers the call — an unanswered `fleetCall` would hang the delegated agent's
	 * tool call for the full OMP-side timeout.
	 */
	private async onFleetCall(channelId: string, call: BridgeFleetCall): Promise<void> {
		const rt = this.runtime(channelId);
		const respond = async (result: VoiceFleetWireResult): Promise<void> => {
			try {
				const ack = await rt.bridge?.sendFleetResult(call.fleetCallId, result);
				if (ack && !ack.ok) this.log(`voice-call ${channelId}: fleet result for ${call.fleetCallId} not accepted: ${ack.reason ?? "unknown"}`);
			} catch (err) {
				this.log(`voice-call ${channelId}: could not deliver fleet result for ${call.fleetCallId}: ${errText(err)}`);
			}
		};
		const binding = this.bindings.get(channelId);
		if (!binding || binding.state !== "live" || !rt.bridge) {
			await respond({ status: "failed", detail: "this call has no live binding on the daemon" });
			return;
		}
		if (!this.executeFleetCall) {
			await respond({ status: "failed", detail: "this daemon has no fleet execution wired" });
			return;
		}
		let result: VoiceFleetExecResult;
		try {
			result = await this.executeFleetCall({ channelId, ownerActor: binding.ownerActor, tool: call.tool, args: call.args });
		} catch (err) {
			await respond({ status: "failed", detail: errText(err) });
			return;
		}
		if (result.status !== "needs-decision") {
			await respond(result);
			return;
		}
		const deferredActionId = crypto.randomUUID();
		this.projection.storeDeferredFleetAction(channelId, deferredActionId, {
			tool: call.tool,
			args: call.args,
			approveOptionIndex: result.decision.approveOptionIndex,
			summary: result.summary,
			...(result.unitId === undefined ? {} : { unitId: result.unitId }),
		});
		await respond({
			status: "needs-decision",
			...(result.detail === undefined ? {} : { detail: result.detail }),
			decision: {
				prompt: result.decision.prompt,
				options: result.decision.options,
				requiresConfirmation: result.decision.requiresConfirmation,
				deferredActionId,
			},
		});
	}

	/**
	 * Live captions fix (production defect, 2026-07-28): one `{type:"transcript"}` presentation
	 * frame off the bridge — final or not — becomes a presentation-plane nudge via
	 * `onLiveTranscriptFrame`. Deliberately mirrors `onTranscriptTurn`'s wire shape
	 * (`{channelId, callId, entry}`) so the caller can push both through the identical `SquadEvent`
	 * path, but does NOT touch `this.projection`/the journal — see the option's own doc for why that
	 * boundary matters (DESIGN.md: presentation frames never mutate durable state). Dropped silently
	 * (no binding, no callId, or the bridge that sent it is no longer this channel's live bridge) —
	 * same discipline as `onFleetCall`/`onAudioFrame`: a stale or unattached frame has nowhere honest
	 * to land, and this is a best-effort nudge, not a record that must never be lost.
	 */
	private onLiveTranscriptFrame(channelId: string, frame: BridgeTranscriptFrame): void {
		if (!this.onLiveTranscriptFrameFn) return;
		const binding = this.bindings.get(channelId);
		if (!binding?.callId || binding.state !== "live") return;
		const rt = this.runtimes.get(channelId);
		if (!rt?.bridge) return;
		// Retention "off" honesty, mirroring `applyEnvelope`'s own durable-path redaction (concern 11's
		// Resolution: "retention off pushes a redacted entry, no text"): a live caption must not show
		// text the room asked never to keep even transiently, so the presentation nudge redacts too.
		const redacted = binding.retention === "off";
		this.onLiveTranscriptFrameFn({
			channelId,
			callId: binding.callId,
			entry: {
				callId: binding.callId,
				turn: frame.turn,
				role: frame.role,
				final: frame.final,
				at: this.now(),
				...(redacted ? { redacted: true } : { text: frame.text }),
			},
		});
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
			// Concern 12: a terminal decision may be the UI approval a deferred destructive fleet
			// action has been waiting on — or its rejection/expiry, which discards the queue entry.
			await this.settleDeferredFleetAction(channelId, binding, outcome.decision);
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
		if (outcome.status === "applied-transcript") {
			// Concern 11: nudge a live conversation pane the moment a turn actually lands on disk — see
			// `onTranscriptTurn`'s own doc. Never fired for a duplicate replay or a failed append,
			// because `applyEnvelope` only returns this status once the append itself succeeded.
			this.onTranscriptTurnFn?.({ channelId, callId: binding.callId, entry: outcome.entry });
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

	/** Journal-projected fleet-action card (concern 12): one card per OUTCOME record the tailer
	 *  applied (`CallProjectionStore` never fires this for the `requested` half). */
	private async onFleetActionCard(input: EmitVoiceFleetActionCardInput): Promise<void> {
		const action = input.action;
		const status: VoiceFleetActionCardStatus = action.phase === "relayed" ? "relayed" : action.phase === "deferred-decision" ? "deferred" : "failed";
		await this.announceFleetAction(input.channelId, input.callId, {
			tool: action.tool,
			status,
			summary: action.summary,
			detail: action.detail,
			unitId: action.unitId,
			decisionId: action.decisionId,
		});
	}

	/** The one emit path every `voice-fleet-action` card takes — journal-projected outcomes and the
	 *  coordinator-authored deferred outcomes (executed/declined) alike. */
	private async announceFleetAction(
		channelId: string,
		callId: string,
		input: { tool: string; status: VoiceFleetActionCardStatus; summary: string; detail?: string; unitId?: string; decisionId?: string },
	): Promise<void> {
		const title = fleetActionCardTitle(input.tool, input.status, input.summary);
		const payload: CardPayloadType<typeof TRANSCRIPT_EVENT_VOICE_FLEET_ACTION> = {
			refs: { callId, ...(input.decisionId === undefined ? {} : { decisionId: input.decisionId }), ...(input.unitId === undefined ? {} : { unitId: input.unitId }) },
			face: {
				title,
				status: input.status,
				tone: input.status === "executed" ? "success" : input.status === "relayed" ? "info" : input.status === "declined" ? "neutral" : "warning",
				// The summary embeds the voice model's own words (steer text, spawn prompt) — an
				// agent's account, never a daemon-checked fact (concern 07 register semantics).
				register: "claim",
				callId,
				tool: input.tool,
				actionStatus: input.status,
				...(input.detail === undefined ? {} : { detail: input.detail }),
				...(input.unitId === undefined ? {} : { unitId: input.unitId }),
				...(input.decisionId === undefined ? {} : { decisionId: input.decisionId }),
			},
		};
		const event = emitVoiceFleetActionCard(payload);
		await this.emitCardFn({ channelId, kind: "voice-fleet-action", text: title, payload: event.payload });
	}

	/**
	 * Concern 12: settle a deferred destructive fleet action once its decision reached a terminal
	 * state. Approval means EXACTLY: `answered`, by the UI (the arbiter already refuses a voice
	 * source for a destructive class — re-checked here so this daemon's execution can never be
	 * looser than the arbiter's own policy, even against a forged journal line), selecting the
	 * approve option recorded at refusal time. Anything else — the reject option, expiry,
	 * cancellation, failure — discards the queued action with an honest card. Execution reuses the
	 * SAME injected executor with `approvedDecisionId` set, so the one approval executes the one
	 * queued action once (`takeDeferredForDecision` removes it before anything runs).
	 */
	private async settleDeferredFleetAction(channelId: string, binding: VoiceCallBinding, decision: JournalDecisionSnapshot): Promise<void> {
		const stored: DeferredFleetAction | undefined = this.projection.takeDeferredForDecision(channelId, decision.id);
		if (!stored || !binding.callId) return;
		const resolution = decision.resolution;
		const approved = decision.state === "answered" && resolution !== undefined && resolution.optionIndex === stored.approveOptionIndex && resolution.source === "ui";
		if (!approved) {
			const detail =
				decision.state === "answered"
					? resolution?.source !== "ui"
						? "refused: the approval did not come from the UI"
						: "the human chose not to run it"
					: `the decision ${decision.state} before anyone approved it`;
			await this.announceFleetAction(channelId, binding.callId, { tool: stored.tool, status: "declined", summary: stored.summary, detail, unitId: stored.unitId, decisionId: decision.id });
			return;
		}
		if (!this.executeFleetCall) {
			await this.announceFleetAction(channelId, binding.callId, {
				tool: stored.tool,
				status: "failed",
				summary: stored.summary,
				detail: "approved, but this daemon has no fleet execution wired",
				unitId: stored.unitId,
				decisionId: decision.id,
			});
			return;
		}
		let result: VoiceFleetExecResult;
		try {
			result = await this.executeFleetCall({ channelId, ownerActor: binding.ownerActor, tool: stored.tool, args: stored.args, approvedDecisionId: decision.id });
		} catch (err) {
			result = { status: "failed", detail: errText(err) };
		}
		if (result.status === "ok") {
			await this.announceFleetAction(channelId, binding.callId, { tool: stored.tool, status: "executed", summary: stored.summary, detail: result.detail, unitId: stored.unitId, decisionId: decision.id });
		} else {
			const detail = result.status === "failed" ? result.detail : "the executor re-classified the approved action as destructive — refusing to loop";
			await this.announceFleetAction(channelId, binding.callId, { tool: stored.tool, status: "failed", summary: stored.summary, detail, unitId: stored.unitId, decisionId: decision.id });
		}
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
		// Concern 12: a dead call's queued destructive actions can never be approved into execution —
		// the decisions that would approve them were just expired above.
		this.projection.dropDeferredFleetActions(channelId);
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
	 * Registers a browser's audio sink for a channel's live call (concern 09: browser-audio-transport;
	 * generalized to N concurrent browsers by concern 13: multi-party-calls) — the daemon-side half of
	 * "speaker PCM leaves via the bridge instead of a local device". Gated on the SAME preconditions
	 * `resolveDecision`/`steer`/`setMuted` already require (authorized, active binding, `live`, a
	 * connected bridge) PLUS one more this class owns alone: `binding.noLocalAudio === true` — a
	 * device-audio call already owns a real speaker and must never ALSO hand its output audio to a
	 * browser, which would be feeding the same session's voice out of two places at once.
	 *
	 * `participant` identifies WHO is attaching (the authenticated actor `server.ts` already resolved
	 * before ever calling this — see `VoiceCallParticipant`'s own doc). Omitted, it defaults to the
	 * single pre-concern-13 slot keyed under `DEFAULT_PARTICIPANT_CONN_ID`, attributed to the call's
	 * own owner — every existing single-party caller keeps its exact old behavior. `host` is computed
	 * here, once, by comparing `participant.actorId` against `binding.ownerActorId`.
	 *
	 * Returns a `detach()` that clears the sink ONLY if it is STILL the one THIS call attached — a
	 * slow/delayed detach (e.g. a browser tab's cleanup racing a fast reconnect that already attached
	 * a NEWER sink under the SAME connId) must never clear a sink it does not own, checked by object
	 * identity of the `sink` argument itself, not merely by key presence. Any number of DISTINCT
	 * connIds may be attached at once — that is the entire point of concern 13's generalization; only
	 * a second attach reusing the exact SAME connId replaces its own prior entry.
	 */
	attachAudioSink(
		channelId: string,
		isAuthorized: boolean,
		sink: { sendOutputAudio: (bytes: Uint8Array) => void },
		participant?: { connId: string; actorId: string; displayName?: string },
	): CoordinatorResult<{ detach: () => void }> {
		if (!isAuthorized) return { ok: false, reason: "forbidden" };
		const binding = this.bindings.get(channelId);
		if (!binding || binding.state === "ended") return { ok: false, reason: "no-active-call" };
		if (binding.noLocalAudio !== true) return { ok: false, reason: "device-audio-call" };
		const rt = this.runtime(channelId);
		if (binding.state !== "live" || !rt.bridge) return { ok: false, reason: "bridge-unavailable" };
		const identity = participant ?? { connId: DEFAULT_PARTICIPANT_CONN_ID, actorId: binding.ownerActorId };
		const full: VoiceCallParticipant = {
			connId: identity.connId,
			actorId: identity.actorId,
			...(identity.displayName === undefined ? {} : { displayName: identity.displayName }),
			host: identity.actorId === binding.ownerActorId,
			joinedAt: this.now(),
		};
		rt.audioSinks.set(identity.connId, { participant: full, sink });
		this.onParticipantJoinedFn?.({ channelId, callId: binding.callId!, participant: full });
		return {
			ok: true,
			value: {
				detach: () => {
					const current = rt.audioSinks.get(identity.connId);
					if (!current || current.sink !== sink) return;
					rt.audioSinks.delete(identity.connId);
					rt.mixer?.remove(identity.connId);
					this.onParticipantLeftFn?.({ channelId, callId: binding.callId!, participant: full });
				},
			},
		};
	}

	/**
	 * Relays one chunk of browser microphone PCM towards the session (concern 09; additively mixed
	 * with every OTHER currently-pushing participant's own chunk by concern 13 — see
	 * `voice-call-audio-mixer.ts`'s module doc for the mixing tradeoff). Mono 16 kHz `Float32`, the
	 * format `VoiceCallBridgeClient#sendMicAudio`/oh-my-pi's own `AudioCapture` both use. Same
	 * authorization and `noLocalAudio` gate as `attachAudioSink`; deliberately does NOT require a sink
	 * to already be attached — a browser that only sends (never wants output audio relayed back, or
	 * has its own separate connection for that) is not something this layer should refuse just because
	 * it never called `attachAudioSink`.
	 *
	 * `connId` defaults to the same `DEFAULT_PARTICIPANT_CONN_ID` slot `attachAudioSink` defaults to —
	 * a caller that never opts into multi-party identity gets exactly the old single-source behavior
	 * (the mixer's own "one pending participant" path forwards their frame byte-for-byte, unaltered).
	 *
	 * The actual send to the bridge is now DEFERRED to the mixer's own tick (see
	 * `VoiceCallAudioMixer#tick`), decoupled from any one caller's `await` — a bridge-send failure can
	 * no longer be reported back to the specific push that "caused" it (there may be several pending
	 * participants by the time a tick fires), so it is bounded-logged here instead, matching every
	 * other best-effort relay path in this class (e.g. `reapBrokerCall`).
	 */
	async pushMicAudio(channelId: string, isAuthorized: boolean, samples: Float32Array, connId: string = DEFAULT_PARTICIPANT_CONN_ID): Promise<CoordinatorResult<true>> {
		if (!isAuthorized) return { ok: false, reason: "forbidden" };
		const binding = this.bindings.get(channelId);
		if (!binding || binding.state === "ended") return { ok: false, reason: "no-active-call" };
		if (binding.noLocalAudio !== true) return { ok: false, reason: "device-audio-call" };
		const rt = this.runtime(channelId);
		if (binding.state !== "live" || !rt.bridge) return { ok: false, reason: "bridge-unavailable" };
		if (!rt.mixer) {
			rt.mixer = new VoiceCallAudioMixer({
				onMixedFrame: (mixed) => {
					try {
						this.runtime(channelId).bridge?.sendMicAudio(mixed);
					} catch (err) {
						this.log(`voice-call ${channelId}: mixed mic frame could not be relayed: ${errText(err)}`);
					}
				},
			});
			rt.mixer.start();
		}
		rt.mixer.push(connId, samples);
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

	/**
	 * Concern 10 (call-management-ui): the user-triggered counterpart to `rehydrateBinding`'s automatic
	 * degraded→live recovery — invokable on demand from the calls-management surface's Reattach button
	 * (and the HUD's own, for the room's current call) when the automatic liveness probe hasn't, or
	 * doesn't ever, succeed on its own. Same corroborate-then-reconnect steps `probeLiveness` already
	 * runs each tick, just callable directly and reporting its own outcome instead of leaving the
	 * caller to infer one from polling the binding again:
	 *  - already live with a connected bridge → no-op, reports the current binding (nothing to do).
	 *  - no `callId` at all → this binding never got far enough to be reattachable; ends it honestly
	 *    (`stale-binding`) rather than hanging a Reattach button off nothing.
	 *  - the broker no longer lists the call, or lists it exited → ends it (`broker-exit`); reattaching
	 *    a process that is actually gone would be claiming a liveness this daemon cannot verify.
	 *  - otherwise → the same `connectAndPin` every first-connect and liveness-probe reconnect already
	 *    shares, so a successful reattach re-pins the SAME session identity and refuses a different one
	 *    exactly as any other reconnect does.
	 * Never adds a new teardown path — every ending here still funnels through `endBinding`.
	 */
	async reattach(channelId: string, isAuthorized: boolean): Promise<CoordinatorResult<VoiceCallBindingView>> {
		if (!isAuthorized) return { ok: false, reason: "forbidden" };
		const binding = this.bindings.get(channelId);
		if (!binding || binding.state === "ended") return { ok: false, reason: "no-active-call" };
		const rt = this.runtime(channelId);
		if (binding.state === "live" && rt.bridge) return { ok: true, value: redactBinding(binding) };
		if (!binding.callId) {
			await this.endBinding(channelId, "stale-binding");
			return { ok: false, reason: "no-active-call" };
		}
		let calls: BrokerCallView[];
		try {
			calls = await this.broker.listCalls();
		} catch (err) {
			return { ok: false, reason: `broker: ${errText(err)}` };
		}
		const mine = calls.find((call) => call.callId === binding.callId);
		if (!mine || mine.exit !== null) {
			this.stopLivenessProbe(channelId);
			await this.endBinding(channelId, "broker-exit");
			return { ok: false, reason: "no-active-call" };
		}
		try {
			await this.connectAndPin(channelId, binding, binding.controlToken);
		} catch (err) {
			return { ok: false, reason: `bridge: ${errText(err)}` };
		}
		this.stopLivenessProbe(channelId);
		const live = this.bindings.get(channelId);
		if (!live || live.state === "ended") return { ok: false, reason: "no-active-call" };
		return { ok: true, value: redactBinding(live) };
	}

	stop(): void {
		// Daemon shutdown, NOT call termination — bindings stay whatever state they were in (a live
		// binding is still live on disk) so `rehydrateOnBoot` has something honest to corroborate next
		// start; only the in-process runtime (tailer/liveness/bridge) is torn down here.
		for (const channelId of this.runtimes.keys()) this.teardownRuntime(channelId);
		this.bindings.stop();
	}
}
