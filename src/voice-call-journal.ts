/**
 * voice-call-journal.ts — continuous tailing of one call's OMP journal (concern 02).
 *
 * Mirrors the shape of `~/src/oh-my-pi`'s `LiveJournal`/`JournalEnvelope`
 * (packages/coding-agent/src/live/journal.ts) without importing it — the daemon and the OMP
 * checkout are separate builds/processes that only agree on the JSONL wire shape, exactly like the
 * Coven Bridge protocol itself.
 *
 * `JournalTailer` is deliberately dumb: it polls a file for new COMPLETE lines (a partial trailing
 * line — a write still in flight — is never parsed, and stays unconsumed until the next poll makes it
 * whole) and hands each parsed envelope to a callback, once, in file order. It tracks a byte offset
 * only to avoid re-parsing lines within ONE process's lifetime; it holds no durable memory of what a
 * PRIOR process already applied. Idempotent re-tailing across a daemon restart is therefore the
 * CONSUMER's job (`CallProjectionStore.applyEnvelope`, keyed on `(callId, seq)`), not this class's —
 * a tailer restarted after a crash reads the file from byte 0 again and re-emits everything, exactly
 * as it must for the consumer's own seq-keyed idempotency to be exercised at all.
 */

import { errText } from "./err-text.ts";

export interface JournalDecisionOption {
	index: number;
	label: string;
	consequence: string;
}

export interface JournalDecisionResolution {
	optionIndex: number;
	label: string;
	source: "voice" | "ui";
}

export interface JournalDecisionSnapshot {
	id: string;
	prompt: string;
	options: JournalDecisionOption[];
	requiresConfirmation: boolean;
	state: "open" | "awaiting-confirmation" | "answered" | "expired" | "cancelled" | "failed";
	createdAt: number;
	updatedAt: number;
	resolution?: JournalDecisionResolution;
}

export interface JournalArtifact {
	path: string;
	status: "ready" | "failed";
}

export interface JournalTranscript {
	role: "user" | "assistant";
	text: string;
	turn: number;
	final: boolean;
}

export type JournalRecord =
	| { type: "decision"; decision: JournalDecisionSnapshot }
	| { type: "transcript"; transcript: JournalTranscript }
	| { type: "artifact"; artifact: JournalArtifact }
	| { type: "terminal"; error: string | null };

export interface JournalEnvelope {
	seq: number;
	at: number;
	sessionId: string;
	record: JournalRecord;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Structural narrowing of one parsed JSON line into a `JournalEnvelope` — a malformed/foreign line
 *  (a torn write, a future record shape this daemon doesn't know yet) is dropped rather than trusted,
 *  mirroring every other "corrupt on disk ⇒ skip, never crash" reader in this codebase. Returns
 *  `undefined` on anything that doesn't structurally match. */
export function parseJournalLine(line: string): JournalEnvelope | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isPlainRecord(parsed)) return undefined;
	const { seq, at, sessionId, record } = parsed;
	if (typeof seq !== "number" || !Number.isFinite(seq)) return undefined;
	if (typeof at !== "number" || typeof sessionId !== "string" || !isPlainRecord(record)) return undefined;
	const type = record.type;
	if (type === "decision") {
		if (!isPlainRecord(record.decision)) return undefined;
		return { seq, at, sessionId, record: { type: "decision", decision: record.decision as unknown as JournalDecisionSnapshot } };
	}
	if (type === "transcript") {
		if (!isPlainRecord(record.transcript)) return undefined;
		return { seq, at, sessionId, record: { type: "transcript", transcript: record.transcript as unknown as JournalTranscript } };
	}
	if (type === "artifact") {
		if (!isPlainRecord(record.artifact)) return undefined;
		return { seq, at, sessionId, record: { type: "artifact", artifact: record.artifact as unknown as JournalArtifact } };
	}
	if (type === "terminal") {
		const error = record.error;
		if (error !== null && typeof error !== "string") return undefined;
		return { seq, at, sessionId, record: { type: "terminal", error } };
	}
	return undefined;
}

export interface JournalTailerOptions {
	path: string;
	onEnvelope: (envelope: JournalEnvelope) => void | Promise<void>;
	onError?: (err: unknown) => void;
	/**
	 * Fired when the journal path is found absent AFTER having been observed to exist at least once
	 * (`~/src/oh-my-pi`'s `LiveJournal#defaultWriter` creates the file lazily, on its first successful
	 * `append()` — a brand-new call can legitimately have no file on disk yet for a while, e.g. a live
	 * session nobody has spoken to and that has minted no decision, so "never seen it yet" is NOT a
	 * signal on its own). Once seen, a later disappearance IS the honest "journal-end" fact: the
	 * process's own call directory was removed, or it died in a way that took the file with it.
	 */
	onMissing?: () => void;
	intervalMs?: number;
	/** Injectable for tests: reads the file from `offset` bytes, returning the bytes read (empty
	 *  string if nothing new) or `undefined` if the file does not exist (a call whose journal path
	 *  hasn't been created yet, or has been removed — see `pollOnce`'s `missing` return). */
	readFrom?: (path: string, offset: number) => Promise<string | undefined>;
}

async function defaultReadFrom(path: string, offset: number): Promise<string | undefined> {
	const fs = await import("node:fs/promises");
	let handle: import("node:fs/promises").FileHandle;
	try {
		handle = await fs.open(path, "r");
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
		throw err;
	}
	try {
		const stat = await handle.stat();
		if (stat.size <= offset) return "";
		const length = stat.size - offset;
		const buf = Buffer.alloc(length);
		await handle.read(buf, 0, length, offset);
		return buf.toString("utf8");
	} finally {
		await handle.close();
	}
}

export type PollOutcome = { status: "ok"; applied: number } | { status: "missing" };

/**
 * Tails one journal file. `poll()` is exposed directly so tests (and a coordinator that wants a
 * deterministic first read right after connecting, before the interval fires) never depend on real
 * timers.
 */
export class JournalTailer {
	private readonly path: string;
	private readonly onEnvelope: (envelope: JournalEnvelope) => void | Promise<void>;
	private readonly onError: (err: unknown) => void;
	private readonly onMissing: (() => void) | undefined;
	private readonly intervalMs: number;
	private readonly readFrom: (path: string, offset: number) => Promise<string | undefined>;
	private offset = 0;
	/** True once a poll has ever found the file present — see `onMissing`'s doc for why absence
	 *  alone, before this is true, is never itself a signal. */
	private everExisted = false;
	/** Bytes of a trailing PARTIAL line held back across polls until it's whole. */
	private carry = "";
	private timer: ReturnType<typeof setInterval> | undefined;
	private polling = false;

	constructor(opts: JournalTailerOptions) {
		this.path = opts.path;
		this.onEnvelope = opts.onEnvelope;
		this.onError = opts.onError ?? (() => {});
		this.onMissing = opts.onMissing;
		this.intervalMs = opts.intervalMs ?? 500;
		this.readFrom = opts.readFrom ?? defaultReadFrom;
	}

	/** One tail cycle: read whatever is new past the current offset, parse complete lines, apply
	 *  them in order, and advance the offset past only what was actually consumed. Never throws —
	 *  a read failure (other than "file doesn't exist yet") is reported via `onError` and leaves the
	 *  offset unchanged so the next poll retries from the same place. */
	async poll(): Promise<PollOutcome> {
		if (this.polling) return { status: "ok", applied: 0 }; // one cycle at a time; a slow onEnvelope must not overlap the next timer tick
		this.polling = true;
		try {
			let chunk: string | undefined;
			try {
				chunk = await this.readFrom(this.path, this.offset);
			} catch (err) {
				this.onError(err);
				return { status: "ok", applied: 0 };
			}
			if (chunk === undefined) {
				if (this.everExisted) this.onMissing?.();
				return { status: "missing" };
			}
			this.everExisted = true;
			if (chunk === "") return { status: "ok", applied: 0 };
			const combined = this.carry + chunk;
			const lastNewline = combined.lastIndexOf("\n");
			if (lastNewline < 0) {
				// No complete line yet — hold everything back, advance nothing.
				this.carry = combined;
				return { status: "ok", applied: 0 };
			}
			const completeText = combined.slice(0, lastNewline + 1);
			this.carry = combined.slice(lastNewline + 1);
			this.offset += Buffer.byteLength(chunk, "utf8");
			// The offset must reflect bytes actually consumed FROM THE FILE, not from `combined` (which
			// also contains the previously-uncounted carry) — chunk is exactly the newly-read bytes, all
			// of which are now either applied or re-carried, so advancing by chunk's byte length is exact.
			let applied = 0;
			for (const line of completeText.split("\n")) {
				if (!line.trim()) continue;
				const envelope = parseJournalLine(line);
				if (!envelope) {
					this.onError(new Error(`unparseable journal line at ${this.path}: ${line.slice(0, 200)}`));
					continue;
				}
				try {
					await this.onEnvelope(envelope);
					applied++;
				} catch (err) {
					this.onError(err);
				}
			}
			return { status: "ok", applied };
		} catch (err) {
			this.onError(err);
			return { status: "ok", applied: 0 };
		} finally {
			this.polling = false;
		}
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.poll().catch((err) => this.onError(err)), this.intervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
}
