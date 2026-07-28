/**
 * voice-call-projection.ts — idempotent journal-record projection (concern 02).
 *
 * `CallProjectionStore.applyEnvelope` is the single chokepoint every journal envelope for a channel
 * passes through. It is the ONLY place that mutates the durable decision and transcript stores, and
 * it does so keyed on `(callId, seq)` — a duplicate delivery of an envelope already applied (a
 * restarted tailer re-reading from byte 0, a broker replay) is a detected no-op, and a seq gap is
 * recorded and surfaced rather than silently skipped over.
 *
 * Decision projection: the mutable "current state of decision X" lives in a compacted map, persisted
 * alongside the gap ledger and the per-call apply cursor in one JSON file per channel. Timeline cards
 * are append-only room history — one card when a decision is minted (carrying the agent's own prompt,
 * `register: "claim"` per concern 07) and one when it reaches a terminal state (answered / expired /
 * cancelled / failed), mirroring `squad-manager.ts`'s existing "asked" + "resolved" needs-you pattern.
 * The intermediate `awaiting-confirmation` step updates the mutable store (so a live decision panel —
 * concern 03 — reads it) but does not mint a THIRD card; it is a transient step, not itself news.
 *
 * Transcript projection respects the binding's retention policy: `off` never persists turn text, only
 * a truthful redaction marker; `full`/`tails` persist exactly what the journal carried (OMP itself
 * already bounds `tails` at the source — see journal.ts's `recordingMode`).
 */

import * as path from "node:path";
import { getStorageBackend } from "./dal/storage.ts";
import { errText } from "./err-text.ts";
import type { JournalArtifact, JournalDecisionSnapshot, JournalEnvelope, JournalTranscript } from "./voice-call-journal.ts";
import type { VoiceCallRetention } from "./voice-call-binding.ts";

export interface JournalGap {
	callId: string;
	/** The seq that arrived right after the gap — the missing range is `(lastApplied, atSeq)`. */
	atSeq: number;
	missingCount: number;
	detectedAt: number;
}

export interface StoredTranscriptEntry {
	callId: string;
	turn: number;
	role: "user" | "assistant";
	/** Absent when this turn was not retained (`retention === "off"`) — see `redacted`. */
	text?: string;
	final: boolean;
	at: number;
	/** True for a retention-suppressed turn — `text` is deliberately absent, never empty-string. */
	redacted?: boolean;
	/** Set on the entry immediately following a detected gap, so a transcript reader sees the honest
	 *  hole rather than two turns that merely look consecutive. */
	gapBefore?: { missingCount: number };
}

interface ProjectionState {
	decisions: Record<string, JournalDecisionSnapshot>;
	lastAppliedSeq: Record<string, number>;
	gaps: JournalGap[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function emptyState(): ProjectionState {
	return { decisions: {}, lastAppliedSeq: {}, gaps: [] };
}

function narrowState(raw: unknown): ProjectionState {
	if (!isPlainRecord(raw)) return emptyState();
	const decisions: Record<string, JournalDecisionSnapshot> = {};
	if (isPlainRecord(raw.decisions)) {
		for (const [id, value] of Object.entries(raw.decisions)) {
			if (isPlainRecord(value) && typeof value.id === "string" && typeof value.state === "string") decisions[id] = value as unknown as JournalDecisionSnapshot;
		}
	}
	const lastAppliedSeq: Record<string, number> = {};
	if (isPlainRecord(raw.lastAppliedSeq)) {
		for (const [callId, value] of Object.entries(raw.lastAppliedSeq)) if (typeof value === "number") lastAppliedSeq[callId] = value;
	}
	const gaps: JournalGap[] = Array.isArray(raw.gaps)
		? raw.gaps.filter((g): g is JournalGap => isPlainRecord(g) && typeof g.callId === "string" && typeof g.atSeq === "number" && typeof g.missingCount === "number" && typeof g.detectedAt === "number")
		: [];
	return { decisions, lastAppliedSeq, gaps };
}

function projectionPath(stateDir: string, channelId: string): string {
	return path.join(stateDir, "voice-projection", `${channelId}.json`);
}

function transcriptPath(stateDir: string, callId: string): string {
	return path.join(stateDir, "voice-transcripts", `${callId}.jsonl`);
}

export type ApplyOutcome =
	| { status: "duplicate" }
	| { status: "applied-decision"; decision: JournalDecisionSnapshot; cardKind: "mint" | "terminal" | "none" }
	| { status: "applied-transcript"; entry: StoredTranscriptEntry }
	/** The append itself failed (a disk error, not a missing journal record) — the durable cursor was
	 *  deliberately NOT advanced for this seq; see `applyEnvelope`'s doc for why. `entry` is still
	 *  handed back (it carries what WOULD have been written) so a caller can log/surface it, even
	 *  though it was never durably persisted. */
	| { status: "transcript-append-failed"; entry: StoredTranscriptEntry }
	| { status: "applied-artifact"; artifact: JournalArtifact }
	/** `reason` is additive (concern 05's idle-hangup policy, e.g. `"idle"`) — see journal.ts's own
	 *  `JournalRecord["terminal"]`. Absent for every terminal record that predates this field. */
	| { status: "applied-terminal"; error: string | null; reason?: string }
	/** OMP's idle-hangup policy spoke its warning — nothing to mint a card for, but the cursor still
	 *  advances so a restarted tailer does not re-observe it as new. */
	| { status: "applied-idle-warning" };

const DECISION_TERMINAL_STATES = new Set(["answered", "expired", "cancelled", "failed"]);

export interface EmitVoiceDecisionCardInput {
	channelId: string;
	callId: string;
	decision: JournalDecisionSnapshot;
	cardKind: "mint" | "terminal";
}

export interface CallProjectionStoreOptions {
	log?: (msg: string) => void;
	now?: () => number;
	/** Fired once per timeline card this store decides to mint — the caller (VoiceCallCoordinator)
	 *  owns the actual `ChannelStore#appendManager` call, keeping this store decoupled from the room
	 *  channel abstraction (and trivially testable without one). */
	onDecisionCard?: (input: EmitVoiceDecisionCardInput) => void | Promise<void>;
}

export class CallProjectionStore {
	private readonly stateDir: string;
	private readonly log: (msg: string) => void;
	private readonly now: () => number;
	private readonly onDecisionCard: ((input: EmitVoiceDecisionCardInput) => void | Promise<void>) | undefined;
	private readonly states = new Map<string, ProjectionState>();

	constructor(stateDir: string, opts?: CallProjectionStoreOptions) {
		this.stateDir = stateDir;
		this.log = opts?.log ?? (() => {});
		this.now = opts?.now ?? Date.now;
		this.onDecisionCard = opts?.onDecisionCard;
	}

	private stateFor(channelId: string): ProjectionState {
		let state = this.states.get(channelId);
		if (!state) {
			try {
				const raw = getStorageBackend().readTextSync(projectionPath(this.stateDir, channelId));
				state = raw ? narrowState(JSON.parse(raw)) : emptyState();
			} catch (err) {
				this.log(`voice-projection/${channelId}.json unreadable — starting empty: ${errText(err)}`);
				state = emptyState();
			}
			this.states.set(channelId, state);
		}
		return state;
	}

	private persist(channelId: string): void {
		try {
			getStorageBackend().writeDurableSync(projectionPath(this.stateDir, channelId), JSON.stringify(this.stateFor(channelId)));
		} catch (err) {
			this.log(`voice-projection/${channelId}.json write failed: ${errText(err)}`);
		}
	}

	decisions(channelId: string): JournalDecisionSnapshot[] {
		return Object.values(this.stateFor(channelId).decisions);
	}

	decision(channelId: string, decisionId: string): JournalDecisionSnapshot | undefined {
		return this.stateFor(channelId).decisions[decisionId];
	}

	gaps(channelId: string): JournalGap[] {
		return [...this.stateFor(channelId).gaps];
	}

	/**
	 * End-of-call cleanup (DESIGN.md risk table: "Dead call leaves answerable cards" — "Terminal,
	 * journal-end, and broker-exit paths expire or mark decisions unconfirmed and clear attention").
	 * The OMP arbiter that would normally own this transition is gone once the call has ended — there
	 * is no session left to write a proper `expired` journal record — so the daemon makes the
	 * honest local call itself: every decision still `open`/`awaiting-confirmation` for this channel
	 * transitions to `expired` in the mutable overlay, and mints the SAME terminal-card shape a real
	 * journaled expiry would (`cardKind: "terminal"`), via the SAME `onDecisionCard` callback — so a
	 * card reading "Never answered" is indistinguishable, to a reader, from one the arbiter itself
	 * produced. Idempotent: a decision already terminal is left untouched, and calling this twice for
	 * the same channel is a no-op the second time.
	 */
	async expireActiveDecisions(channelId: string, callId: string): Promise<JournalDecisionSnapshot[]> {
		const state = this.stateFor(channelId);
		const expired: JournalDecisionSnapshot[] = [];
		for (const decision of Object.values(state.decisions)) {
			if (decision.state !== "open" && decision.state !== "awaiting-confirmation") continue;
			const updated: JournalDecisionSnapshot = { ...decision, state: "expired", updatedAt: this.now() };
			state.decisions[decision.id] = updated;
			expired.push(updated);
		}
		if (expired.length) this.persist(channelId);
		for (const decision of expired) await this.onDecisionCard?.({ channelId, callId, decision, cardKind: "terminal" });
		return expired;
	}

	lastAppliedSeq(channelId: string, callId: string): number | undefined {
		return this.stateFor(channelId).lastAppliedSeq[callId];
	}

	/** Full transcript for one call, oldest-first, collapsed by `(role, turn)` (latest write per turn
	 *  wins — defensive against a journal that ever carries a streaming update rather than only
	 *  finals; see the module doc). Reads directly from disk: transcripts can be long-lived and are
	 *  never held fully in memory. */
	async transcript(callId: string): Promise<StoredTranscriptEntry[]> {
		let text: string | undefined;
		try {
			text = await getStorageBackend().readText(transcriptPath(this.stateDir, callId));
		} catch (err) {
			this.log(`voice-transcripts/${callId}.jsonl unreadable: ${errText(err)}`);
			return [];
		}
		if (!text) return [];
		const byTurn = new Map<string, StoredTranscriptEntry>();
		const order: string[] = [];
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as StoredTranscriptEntry;
				const key = `${entry.role}\0${entry.turn}`;
				if (!byTurn.has(key)) order.push(key);
				byTurn.set(key, entry);
			} catch {
				/* skip a torn line */
			}
		}
		return order.map((key) => byTurn.get(key)!);
	}

	/**
	 * Apply one journal envelope for `callId` (bound to `channelId`), gated on `(callId, seq)`.
	 * Returns `{status:"duplicate"}` for a seq at or below the already-applied cursor — no state
	 * mutation, no card. A gap (seq more than one past the cursor) is recorded before the record
	 * itself is applied, so the gap is visible even if this envelope's own application then fails.
	 *
	 * The durable cursor (`state.lastAppliedSeq[callId]`) only advances past `envelope.seq` once this
	 * envelope's own application has actually SUCCEEDED — for `transcript`, that means the append to
	 * disk itself, not merely "we decided what to write". Advancing it unconditionally would mark a
	 * failed write "already applied" forever: this class's own idempotent-re-tail contract (module
	 * doc) means a restarted tailer re-reading the SAME journal from byte 0 is the only real retry a
	 * transcript append ever gets, and a cursor that already claims this seq is done would make that
	 * retry a silent no-op `{status:"duplicate"}` — the turn is gone for good, with no record it was
	 * ever lost. `decision`/`artifact`/`terminal` records only ever mutate an in-memory map (nothing
	 * that can fail the way a filesystem append can), so their cursor advance stays unconditional.
	 */
	async applyEnvelope(channelId: string, callId: string, envelope: JournalEnvelope, retention: VoiceCallRetention): Promise<ApplyOutcome> {
		const state = this.stateFor(channelId);
		const cursor = state.lastAppliedSeq[callId];
		if (cursor !== undefined && envelope.seq <= cursor) return { status: "duplicate" };
		let gap: JournalGap | undefined;
		if (cursor !== undefined && envelope.seq > cursor + 1) {
			gap = { callId, atSeq: envelope.seq, missingCount: envelope.seq - cursor - 1, detectedAt: this.now() };
			state.gaps.push(gap);
		}

		if (envelope.record.type === "transcript") {
			const appended = await this.appendTranscript(callId, envelope.record.transcript, envelope.at, retention, gap);
			if (!appended.ok) {
				// Cursor NOT advanced — see this method's doc. The gap (if any) is still worth keeping.
				this.persist(channelId);
				return { status: "transcript-append-failed", entry: appended.entry };
			}
			state.lastAppliedSeq[callId] = envelope.seq;
			this.persist(channelId);
			return { status: "applied-transcript", entry: appended.entry };
		}

		state.lastAppliedSeq[callId] = envelope.seq;

		if (envelope.record.type === "decision") {
			const decision = envelope.record.decision;
			state.decisions[decision.id] = decision;
			this.persist(channelId);
			const cardKind: "mint" | "terminal" | "none" = decision.state === "open" ? "mint" : DECISION_TERMINAL_STATES.has(decision.state) ? "terminal" : "none";
			if (cardKind !== "none") await this.onDecisionCard?.({ channelId, callId, decision, cardKind });
			return { status: "applied-decision", decision, cardKind };
		}

		if (envelope.record.type === "artifact") {
			this.persist(channelId);
			return { status: "applied-artifact", artifact: envelope.record.artifact };
		}

		if (envelope.record.type === "idle-warning") {
			this.persist(channelId);
			return { status: "applied-idle-warning" };
		}

		// terminal
		this.persist(channelId);
		return { status: "applied-terminal", error: envelope.record.error, ...(envelope.record.reason === undefined ? {} : { reason: envelope.record.reason }) };
	}

	private async appendTranscript(callId: string, transcript: JournalTranscript, at: number, retention: VoiceCallRetention, gap: JournalGap | undefined): Promise<{ ok: boolean; entry: StoredTranscriptEntry }> {
		const entry: StoredTranscriptEntry =
			retention === "off"
				? { callId, turn: transcript.turn, role: transcript.role, final: transcript.final, at, redacted: true }
				: { callId, turn: transcript.turn, role: transcript.role, final: transcript.final, at, text: transcript.text };
		if (gap) entry.gapBefore = { missingCount: gap.missingCount };
		try {
			await getStorageBackend().appendDurable(transcriptPath(this.stateDir, callId), `${JSON.stringify(entry)}\n`);
			return { ok: true, entry };
		} catch (err) {
			this.log(`voice-transcripts/${callId}.jsonl append failed: ${errText(err)}`);
			return { ok: false, entry };
		}
	}
}
