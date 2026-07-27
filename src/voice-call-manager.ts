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
 */

import { emitVoiceCallCard, emitVoiceDecisionCard } from "./schema/channel-card.ts";
import type { CardPayloadType } from "./schema/channel-card.ts";
import { TRANSCRIPT_EVENT_VOICE_CALL, TRANSCRIPT_EVENT_VOICE_DECISION } from "./transcript-event-kinds.ts";
import { errText } from "./err-text.ts";
import { ArtifactSnapshotStore, type ArtifactSnapshotRecord } from "./voice-call-artifacts.ts";
import {
	CallBindingStore,
	redactBinding,
	type VoiceCallBinding,
	type VoiceCallBindingView,
	type VoiceCallRetention,
	type VoiceCallTerminalReason,
} from "./voice-call-binding.ts";
import { VoiceCallBridgeClient, type BridgeConnectFn, type BridgeControlAck } from "./voice-call-bridge-client.ts";
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
}

export interface BrokerCallCreated extends BrokerCallView {
	controlToken: string;
}

/** The broker's own HTTP surface (`opencoven-viz/broker/broker.ts`) — injectable so this module never
 *  needs a real broker process (or a real microphone) to be tested. */
export interface BrokerClient {
	createCall(opts?: { resume?: string }): Promise<BrokerCallCreated>;
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
			return (await call("/calls", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resume: opts?.resume }) })) as BrokerCallCreated;
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
			resolutionSource: resolution?.source,
			tone: decision.state === "answered" ? "success" : "neutral",
		},
	};
}

/** One channel's live wiring — the pieces that exist only while a call is being connected or is
 *  live/degraded for this channel. Torn down (never adopted forward) once the binding ends. */
interface ChannelRuntime {
	tailer?: JournalTailer;
	bridge?: VoiceCallBridgeClient;
	livenessTimer?: ReturnType<typeof setInterval>;
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

	state(channelId: string): VoiceCallBindingView | undefined {
		const binding = this.bindings.get(channelId);
		return binding ? redactBinding(binding) : undefined;
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
		const rt = this.runtime(channelId);

		let created: BrokerCallCreated;
		try {
			created = await this.broker.createCall({ resume: input.resumeSessionId });
		} catch (err) {
			await this.endBinding(channelId, "start-failed", errText(err));
			return { ok: false, reason: `broker: ${errText(err)}` };
		}
		binding = this.bindings.attachBroker(channelId, created);

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
		await this.announceCallState(pinned.binding);
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
		const binding = this.bindings.get(channelId);
		if (!binding || binding.state === "ended") return;
		const rt = this.runtime(channelId);
		if (rt.ended) return;
		rt.ended = true;
		rt.tailer?.stop();
		this.stopLivenessProbe(channelId);
		try {
			rt.bridge?.close();
		} catch {
			/* best-effort */
		}
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
		if (outcome.status === "applied-terminal") {
			this.runtime(channelId).ended = true;
			this.runtime(channelId).tailer?.stop();
			this.stopLivenessProbe(channelId);
			this.runtime(channelId).bridge?.close();
			await this.endBinding(channelId, "terminal", outcome.error);
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
	 * The ONE path that ends a binding: marks it terminal, announces the state, and runs the SAME
	 * end-of-call cleanup every terminal/journal-end/broker-exit/stale-binding/port-reused/operator-
	 * ended path needs (DESIGN.md risk table): expire every still-open/awaiting decision (there is no
	 * arbiter left to do it properly) and clear their attention/push dedup entries. Idempotent by
	 * construction — `markEnded` and `expireActiveDecisions` both no-op on an already-terminal input,
	 * so calling this on an already-ended binding is harmless.
	 */
	private async endBinding(channelId: string, reason: VoiceCallTerminalReason, error?: string | null): Promise<VoiceCallBinding> {
		const ended = this.bindings.markEnded(channelId, reason, error);
		await this.announceCallState(ended);
		if (ended.callId) {
			const expired = await this.projection.expireActiveDecisions(channelId, ended.callId);
			for (const decision of expired) this.attention.dismiss(channelId, decision.id);
		}
		return ended;
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
	 *  whether the relay succeeded, since the human's intent to end it is the fact that matters. */
	async endCall(channelId: string, isAuthorized: boolean): Promise<CoordinatorResult<VoiceCallBindingView>> {
		if (!isAuthorized) return { ok: false, reason: "forbidden" };
		const binding = this.bindings.get(channelId);
		if (!binding) return { ok: false, reason: "no-active-call" };
		if (binding.state === "ended") return { ok: true, value: redactBinding(binding) };
		const rt = this.runtime(channelId);
		rt.ended = true;
		try {
			rt.bridge?.stop();
		} catch {
			/* best-effort */
		}
		if (binding.callId) {
			try {
				await this.broker.endCall(binding.callId);
			} catch (err) {
				this.log(`voice-call ${channelId}: broker end failed (marking ended anyway): ${errText(err)}`);
			}
		}
		rt.tailer?.stop();
		this.stopLivenessProbe(channelId);
		rt.bridge?.close();
		const ended = await this.endBinding(channelId, "operator-ended");
		return { ok: true, value: redactBinding(ended) };
	}

	stop(): void {
		for (const [channelId, rt] of this.runtimes) {
			rt.ended = true; // matches onJournalMissing/endCall — guards a still in-flight connectAndPin (see its own `rt.ended` check) against resurrecting a binding after shutdown.
			rt.tailer?.stop();
			this.stopLivenessProbe(channelId);
			try {
				rt.bridge?.close();
			} catch {
				/* best-effort */
			}
		}
		this.bindings.stop();
	}
}
