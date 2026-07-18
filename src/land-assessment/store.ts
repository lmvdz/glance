/**
 * Land Assessment event store — the durable append-only writer. Per-repo, month-sharded JSONL that
 * can never tear its own replay consumer and never stalls a land (`plans/land-assessment/07-event-store-writer.md`).
 *
 * Layout: `<stateDir>/land-assessment/<repoHash16>/events-<YYYY-MM>.jsonl` — `repoHash16` mirrors
 * `proof.ts#fileFor`'s convention (sha1 of the resolved repo path, first 16 hex chars), computed here
 * from the record's OWN `repositoryId` (already `path.resolve`d per `id.ts#computeRepositoryId` —
 * every record this store accepts already carries that identity, so this module never re-resolves a
 * path itself). The month a record shards into is derived from the record's OWN timestamp
 * (`observedAt`/`createdAt`), never wall-clock write time — so replay is reproducible regardless of
 * queuing delay, and a test never has to freeze `Date.now()`.
 *
 * Files are append-only: never rotated-with-clobber, never rewritten, no retention policy in v0
 * (documented as a later-phase decision — ADR.md's Consequences). Every line is
 * `<crc32-hex>:<json>` (`formatStoredLine`/`parseStoredLine`) so a reader can distinguish a torn line
 * from valid data without guessing; the store also stamps a per-file monotonic `seq` at append time,
 * so a reader can additionally detect a whole line having gone missing (a gap in `seq`), not just a
 * torn one. This module's own line-parsing (`parseStoredLine`, used by shard priming below) is
 * deliberately NOT the authoritative reader: it silently skips a torn line because losing at most one
 * in-flight write's contribution to this process's next-seq/dedup bookkeeping is harmless — the byte
 * range itself is never touched, so `store-reader.ts` (concern 06)'s strict-with-accounting reader
 * still sees it and still counts it. Writer and reader disciplines stay separate and separately
 * testable; concern 06 should reuse `parseStoredLine`/`formatStoredLine`/`StoredRecordEnvelope` rather
 * than re-deriving the wire format, so the two never drift apart.
 *
 * Single-writer discipline: one in-process async-chain mutex per shard file path (`enqueue` below,
 * the same "chain onto a settled promise" idiom `jsonl-log.ts`/`automation-log.ts` use for their
 * spool) serializes EVERY append to that file — hook writes, background analysis completions, and
 * invalidations alike — independent of `withRepoLandLock` (background analyses finish outside that
 * lock). Multi-KB events under concurrent `O_APPEND` tear because Node splits a large `write()` into
 * multiple syscalls; the mutex removes the concurrency entirely rather than trying to make individual
 * syscalls atomic.
 *
 * Off-hot-path durability: `getStorageBackend().appendDurable` fsyncs the bytes before returning, but
 * this module never lets that latency reach the land thread's control flow as a thrown failure — a
 * write failure emits high-severity telemetry (`AutomationRecorder`, mirroring `land-pr.ts`'s
 * `record?: AutomationRecorder` convention) and resolves with a `"write-failed"` outcome instead of
 * rejecting. The land proceeds either way: best-effort per BRIEF §10.7, but never silent.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import { crc32 } from "node:zlib";
import type { AutomationRecorder } from "../automation-log.ts";
import { getStorageBackend } from "../dal/storage.ts";
import { errText } from "../err-text.ts";
import { checkOutputHash } from "./id.ts";
import type { LandAssessmentSnapshot, LandAttemptEvent } from "./schema.ts";

// ── Wire format: one line per record, CRC-guarded, store-stamped seq ───────────────────────────────

export type StoredRecordKind = "attempt-event" | "assessment-snapshot";

/** One JSONL line's parsed content. `seq` is stamped by THIS module at append time — a per-shard-file
 *  monotonic counter, distinct from `LandAttemptEvent.seq` (which is per-attempt, not per-file). Total
 *  cross-event order is `(lexical shard filename, in-file line index)` per SCHEMA-V0.md; this `seq`
 *  exists so a reader can additionally notice an entire line missing, which line-index alone cannot. */
export type StoredRecordEnvelope = { kind: "attempt-event"; seq: number; record: LandAttemptEvent } | { kind: "assessment-snapshot"; seq: number; record: LandAssessmentSnapshot };

function isStoredRecordEnvelopeShape(v: unknown): v is StoredRecordEnvelope {
	if (!v || typeof v !== "object") return false;
	const e = v as Partial<StoredRecordEnvelope>;
	if (e.kind !== "attempt-event" && e.kind !== "assessment-snapshot") return false;
	if (typeof e.seq !== "number" || !Number.isInteger(e.seq) || e.seq < 0) return false;
	return !!e.record && typeof e.record === "object";
}

/** Format one line as `<crc32-hex>:<json>` — the JSON is stringified once so the CRC and the persisted
 *  bytes are computed over the exact same content. `JSON.stringify` escapes embedded newlines inside
 *  string values, so the `\n` line separator this module appends is always safe as a delimiter.
 *  @substrate No production caller within this concern (07) -- concern 08's land hook and concern 06's
 *  store-reader.ts both need this exact wire format and import it directly once they land; a
 *  co-located test consumer is not a real reference (dead-exports.ts's own carve-out). */
export function formatStoredLine(envelope: StoredRecordEnvelope): string {
	const json = JSON.stringify(envelope);
	const crc = (crc32(json) >>> 0).toString(16);
	return `${crc}:${json}`;
}

/** Parse one line written by `formatStoredLine`. Returns `undefined` for anything that isn't a
 *  well-formed, CRC-verified `StoredRecordEnvelope` line — a torn write, a hand-corrupted fixture, or
 *  garbage. Never throws: a malformed line is data to skip, not a caller bug.
 *  @substrate No production caller within this concern (07) -- this module's own `primeIfNeeded` uses
 *  it internally, but concern 06's store-reader.ts is the intended external caller (reuse this rather
 *  than re-deriving the wire format); a co-located test consumer is not a real reference. */
export function parseStoredLine(line: string): StoredRecordEnvelope | undefined {
	const sep = line.indexOf(":");
	if (sep <= 0) return undefined;
	const crcHex = line.slice(0, sep);
	const json = line.slice(sep + 1);
	if (!/^[0-9a-f]+$/i.test(crcHex)) return undefined;
	const expectedCrc = Number.parseInt(crcHex, 16);
	if (!Number.isFinite(expectedCrc)) return undefined;
	if ((crc32(json) >>> 0) !== expectedCrc) return undefined; // torn/corrupt — CRC over the exact stored bytes disagrees
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return undefined;
	}
	return isStoredRecordEnvelopeShape(parsed) ? parsed : undefined;
}

// ── Shard addressing ─────────────────────────────────────────────────────────────────────────────────

/** sha1(repositoryId).slice(0,16) — mirrors `proof.ts#fileFor`'s directory-hash convention exactly,
 *  except the input is already the resolved identity every land-assessment record carries
 *  (`id.ts#computeRepositoryId`), so this never re-resolves a filesystem path itself. Exported for
 *  `store-reader.ts` (concern 06), which must locate the same per-repo directory to enumerate shards.
 *  @substrate No production caller within this concern (07) -- this module's own shard-path helpers use
 *  it internally, but concern 06's store-reader.ts is the intended external caller; a co-located test
 *  consumer is not a real reference (dead-exports.ts's own carve-out). */
export function repoHash16(repositoryId: string): string {
	return createHash("sha1").update(repositoryId).digest("hex").slice(0, 16);
}

/** `YYYY-MM` (UTC) from a record's own ISO timestamp — the month a record shards into is a property of
 *  the record's content, never of when the async write queue happened to flush it. */
function monthKeyOf(isoTimestamp: string, context: string): string {
	const d = new Date(isoTimestamp);
	if (Number.isNaN(d.getTime())) throw new Error(`land-assessment store: ${context} is not a parseable timestamp for month-sharding: ${JSON.stringify(isoTimestamp)}`);
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function shardDir(stateDir: string, repositoryId: string): string {
	return path.join(stateDir, "land-assessment", repoHash16(repositoryId));
}

function shardPath(stateDir: string, repositoryId: string, monthKey: string): string {
	return path.join(shardDir(stateDir, repositoryId), `events-${monthKey}.jsonl`);
}

// ── Per-shard-file state: single-writer queue, monotonic seq, snapshot dedup index ─────────────────

interface ShardState {
	/** The async-chain mutex: each append `.then`s onto this, replacing it, so appends to the SAME
	 *  shard file are always fully serialized regardless of caller concurrency. */
	queue: Promise<void>;
	nextSeq: number;
	/** assessmentKey -> most-recently-appended outputHash for THIS shard, primed from disk on first
	 *  touch. Scoped per shard (per concern 07: "already exists in the CURRENT shard") — a snapshot
	 *  whose month rolls over starts a fresh dedup scope, matching the file it lives in. */
	dedup: Map<string, string>;
	primed: boolean;
}

// Module-level so every caller in this process shares the same per-file serialization — required for
// the single-writer guarantee to hold across independent call sites (hook writes vs background
// completions), not just within one caller's own sequential code.
const shardStates = new Map<string, ShardState>();

function stateFor(file: string): ShardState {
	let s = shardStates.get(file);
	if (!s) {
		s = { queue: Promise.resolve(), nextSeq: 0, dedup: new Map(), primed: false };
		shardStates.set(file, s);
	}
	return s;
}

/** Chain `task` onto the shard's queue so it runs strictly after every previously-enqueued task has
 *  settled (success or failure) — the mutex. A prior task's rejection must never wedge the chain for
 *  everyone after it, so the chain itself always continues on `undefined` regardless of outcome; only
 *  the caller's own returned promise carries `task`'s result/rejection. */
function enqueue<T>(state: ShardState, task: () => Promise<T>): Promise<T> {
	const run = state.queue.then(task, task);
	state.queue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/** Best-effort scan of whatever is already on disk for this shard, once per shard per process:
 *  advances `nextSeq` past the highest `seq` any (CRC-valid) line claims, and seeds the dedup map from
 *  every `assessment-snapshot` line's `(assessmentKey, outputHash)`. A torn/corrupt line is silently
 *  skipped here (see the module doc: this is priming, not the authoritative reader) — worst case this
 *  process re-derives a `nextSeq` one lower than truth, which the CRC/seq-gap-aware reader still
 *  reconciles from the bytes on disk regardless of what any single writer process believed. */
async function primeIfNeeded(file: string, state: ShardState): Promise<void> {
	if (state.primed) return;
	const text = await getStorageBackend().readText(file);
	if (text) {
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			const envelope = parseStoredLine(line);
			if (!envelope) continue;
			if (envelope.seq + 1 > state.nextSeq) state.nextSeq = envelope.seq + 1;
			if (envelope.kind === "assessment-snapshot") state.dedup.set(envelope.record.assessmentKey, envelope.record.outputHash);
		}
	}
	state.primed = true;
}

function safeRecord(record: AutomationRecorder | undefined, report: Parameters<AutomationRecorder>[0]): void {
	if (!record) return;
	try {
		record(report);
	} catch {
		/* recording must never break the store it observes */
	}
}

// ── Public append API ────────────────────────────────────────────────────────────────────────────────

export type AppendEventOutcome = "written" | "write-failed";

/** Append one `LandAttemptEvent` to its shard. An underlying I/O WRITE failure surfaces via `record`
 *  (high severity) and resolves `"write-failed"` — the caller (concern 08's land hook) proceeds with the
 *  land regardless (best-effort append). NOTE (cross-lineage review): the shard-key derivation
 *  (`monthKeyOf` on `observedAt`) runs BEFORE the try boundary, so a malformed/non-ISO timestamp — a
 *  programming error, not an I/O failure — still throws synchronously. Before concern 08 wires this onto
 *  the live land path, that derivation must move inside the catch (return `"write-failed"`) so a bad
 *  record can never throw into a land; today's only callers (offline replay + tests) pass validated
 *  timestamps, so it is bounded to a loud test-time failure.
 *  @substrate No production caller within this concern (07) -- concern 08's observe-only land hook
 *  wires this in; a co-located test consumer is not a real reference (dead-exports.ts's own carve-out). */
export async function appendLandAttemptEvent(stateDir: string, event: LandAttemptEvent, record?: AutomationRecorder): Promise<AppendEventOutcome> {
	const file = shardPath(stateDir, event.repositoryId, monthKeyOf(event.observedAt, `LandAttemptEvent ${event.eventId}.observedAt`));
	const state = stateFor(file);
	return enqueue(state, async () => {
		await primeIfNeeded(file, state);
		const seq = state.nextSeq;
		const line = formatStoredLine({ kind: "attempt-event", seq, record: event });
		try {
			await getStorageBackend().appendDurable(file, `${line}\n`);
		} catch (err) {
			safeRecord(record, { level: "error", detail: `land-assessment store: append FAILED for ${file} (event ${event.eventId}, attempt ${event.attemptId}, stage ${event.stage}): ${errText(err)} — write dropped, land proceeds` });
			return "write-failed";
		}
		state.nextSeq = seq + 1;
		return "written";
	});
}

export type AppendSnapshotOutcome = "written" | "duplicate" | "nondeterminism" | "write-failed";

/**
 * Append one `LandAssessmentSnapshot` to its shard, applying concern 01's dedup rule: an
 * `(assessmentKey, outputHash)` pair already present in the current shard is dropped (`"duplicate"` —
 * exact re-run no-op, never written twice). A DIFFERENT `outputHash` for an already-seen
 * `assessmentKey` is analyzer nondeterminism (`id.ts#checkOutputHash`'s throwing rule) — but unlike
 * `checkOutputHash` used standalone, this store does NOT propagate that as a thrown rejection: the
 * record is still appended (append-only history must not drop evidence of the disagreement) and
 * `record` gets a loud high-severity diagnostic, so the caller can observe `"nondeterminism"` without
 * the store ever throwing to it.
 *
 * Sharded/dedup-scoped by `state.candidate.repositoryId`/`createdAt` — the candidate is the state
 * being assessed (schema.ts's C-not-R integrity assumption), so it is the identity this store keys on.
 *
 * @substrate No production caller within this concern (07) -- concern 08's observe-only land hook wires
 * this in; a co-located test consumer is not a real reference (dead-exports.ts's own carve-out).
 */
export async function appendLandAssessmentSnapshot(stateDir: string, snapshot: LandAssessmentSnapshot, record?: AutomationRecorder): Promise<AppendSnapshotOutcome> {
	const repositoryId = snapshot.state.candidate.repositoryId;
	const file = shardPath(stateDir, repositoryId, monthKeyOf(snapshot.createdAt, `LandAssessmentSnapshot ${snapshot.assessmentKey}.createdAt`));
	const state = stateFor(file);
	return enqueue(state, async () => {
		await primeIfNeeded(file, state);
		const previousHash = state.dedup.get(snapshot.assessmentKey);
		let dedupOutcome: "new" | "duplicate" | "nondeterminism";
		try {
			dedupOutcome = checkOutputHash(snapshot.assessmentKey, snapshot.outputHash, previousHash !== undefined ? { outputHash: previousHash } : undefined);
		} catch {
			dedupOutcome = "nondeterminism";
		}
		if (dedupOutcome === "duplicate") return "duplicate";

		const seq = state.nextSeq;
		const line = formatStoredLine({ kind: "assessment-snapshot", seq, record: snapshot });
		try {
			await getStorageBackend().appendDurable(file, `${line}\n`);
		} catch (err) {
			safeRecord(record, { level: "error", detail: `land-assessment store: append FAILED for ${file} (assessmentKey ${snapshot.assessmentKey}): ${errText(err)} — write dropped, land proceeds` });
			return "write-failed";
		}
		state.nextSeq = seq + 1;
		state.dedup.set(snapshot.assessmentKey, snapshot.outputHash);

		if (dedupOutcome === "nondeterminism") {
			safeRecord(record, {
				level: "error",
				detail: `land-assessment store: NONDETERMINISM — assessmentKey ${snapshot.assessmentKey} previously produced outputHash ${previousHash}, now ${snapshot.outputHash}; both appended (append-only, never absorbed) — see SCHEMA-V0.md's outputHash contract`,
			});
			return "nondeterminism";
		}
		return "written";
	});
}

/** Test-only escape hatch: forget this process's in-memory shard state (queue/seq/dedup) so a test can
 *  reuse a shard path across independent scenarios without cross-contamination. Production callers
 *  never need this — shard state is meant to live for the process's lifetime.
 *  @substrate Deliberately test-only by design -- never expected to gain a production caller; kept
 *  exported (not test-file-local) so every future test file in this plan can reuse it. */
export function __resetShardStateForTests(): void {
	shardStates.clear();
}
