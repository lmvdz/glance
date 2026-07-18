/**
 * Land Assessment event store reader — STRICT-WITH-ACCOUNTING (concern 06,
 * `plans/land-assessment/06-replay-cli-and-report.md`). The authoritative consumer of the wire format
 * `store.ts` (concern 07) writes: every shard line is either a successfully parsed `StoredRecordEnvelope`
 * or a COUNTED malformed diagnostic — never silently skipped uncounted. This is the opposite discipline
 * from `store.ts#primeIfNeeded` (that read is best-effort, priming an in-memory writer's own seq/dedup
 * state — see its own doc for why silently skipping there is harmless); this module is the reader every
 * consumer that actually reports on store content must go through, per SCHEMA-V0.md's "a mismatch is
 * surfaced loudly, never absorbed" ethos applied to the store's own integrity.
 *
 * Total order = `(lexical shard filename, in-file line index)` (SCHEMA-V0.md, restated in `schema.ts`'s
 * `LandAttemptEvent` doc) — never `createdAt`/`observedAt`/`seq` alone. `listShardFiles` sorts
 * lexically; `readRepositoryStore` preserves that file order and, within a file, line order.
 *
 * `reconstructRepositoryStore` folds the flat record stream into per-`attemptId` event sequences
 * (SCHEMA-V0.md's identity model: "events need unique identity, assessments need content identity") and
 * a store-wide `assessmentKey -> LandAssessmentSnapshot` index. A terminal-less attempt (no
 * `rejected`/`landed`/`post-merge-verified`/`incomplete` stage seen) classifies as `"incomplete"` — the
 * concern's explicit instruction: exclude these from metric denominators rather than let a crash-mid-land
 * attempt masquerade as either a pass or a fail.
 *
 * `run.ts` (this concern) is today's only production caller, and only for the malformed-line count that
 * drives its own `incomplete` flag over whatever the store already durably holds — the store will
 * typically be near-empty until concern 08's observe-only land hook starts appending. Per the concern's
 * own doc comment, this module is written to be reused by "Phase-2+ consumers" beyond that one call site.
 */

import * as path from "node:path";
import { getStorageBackend } from "../dal/storage.ts";
import { parseStoredLine, repoHash16, type StoredRecordEnvelope } from "./store.ts";
import type { LandAssessmentSnapshot, LandAttemptEvent, LandAttemptStage } from "./schema.ts";

// ── Shard enumeration + strict-with-accounting line read ───────────────────────────────────────────

function shardDir(stateDir: string, repositoryId: string): string {
	return path.join(stateDir, "land-assessment", repoHash16(repositoryId));
}

/** Lexical filename order (SCHEMA-V0.md's total-order rule) — `events-YYYY-MM.jsonl` names sort
 *  chronologically as a side effect of that lexical rule, but the ordering itself is defined as
 *  lexical, never parsed-and-compared-as-dates. `[]` when the repo has no shard directory yet (a repo
 *  the store has never seen a record for — not an error, just nothing to read).
 *  @substrate Only `readRepositoryStore` (same file) calls this today -- exported so a future
 *  Phase-2+ consumer that only needs the file listing (not a full parsed read) doesn't have to
 *  re-derive the shard-directory convention. */
export async function listShardFiles(stateDir: string, repositoryId: string): Promise<string[]> {
	const dir = shardDir(stateDir, repositoryId);
	const names = await getStorageBackend().readdir(dir);
	return names
		.filter((n) => n.startsWith("events-") && n.endsWith(".jsonl"))
		.sort()
		.map((n) => path.join(dir, n));
}

/** One malformed line's location — enough for a human to go find it (`file:lineIndex`, 0-based). */
export interface MalformedLine {
	file: string;
	lineIndex: number;
}

/** One successfully parsed line, tagged with its store-total-order coordinates. */
export interface StoredRecordAtPosition {
	file: string;
	lineIndex: number;
	envelope: StoredRecordEnvelope;
}

export interface StoreReadResult {
	/** In store total order: `(lexical file, in-file line index)`. */
	records: StoredRecordAtPosition[];
	malformed: MalformedLine[];
}

/**
 * Strict-with-accounting read of every shard file for one repository. A blank final line (the trailing
 * `\n` every `formatStoredLine` append leaves) is never counted as malformed — it is not a record slot
 * at all, just the file's own line terminator; only a non-blank line that fails `parseStoredLine` counts.
 *  @substrate Only `reconstructRepositoryStore` (same file) and `run.test.ts` call this directly
 *  today -- `reconstructRepositoryStore` is `run.ts`'s real production entry point; this lower-level
 *  read is kept exported for a future consumer that wants the flat record stream without the
 *  attempt-folding above it.
 */
export async function readRepositoryStore(stateDir: string, repositoryId: string): Promise<StoreReadResult> {
	const files = await listShardFiles(stateDir, repositoryId);
	const records: StoredRecordAtPosition[] = [];
	const malformed: MalformedLine[] = [];
	for (const file of files) {
		const text = await getStorageBackend().readText(file);
		if (!text) continue;
		const lines = text.split("\n");
		lines.forEach((line, lineIndex) => {
			if (!line.trim()) return; // trailing terminator, not a record
			const envelope = parseStoredLine(line);
			if (!envelope) {
				malformed.push({ file, lineIndex });
				return;
			}
			records.push({ file, lineIndex, envelope });
		});
	}
	return { records, malformed };
}

// ── Attempt reconstruction (SCHEMA-V0.md's identity model) ─────────────────────────────────────────

/** Stages that end an attempt's lifecycle — a `LandAttemptEvent` stream with none of these seen is
 *  "still open" from the store's point of view: a crash, a still-in-flight land, or (for a replay CLI
 *  reading mid-write) a race with an in-progress append. Classified `"incomplete"`, per the concern's
 *  explicit instruction to exclude these from metric denominators rather than guess at an outcome. */
const TERMINAL_STAGES: ReadonlySet<LandAttemptStage> = new Set(["rejected", "landed", "post-merge-verified", "incomplete"]);

export type AttemptTerminalStage = "rejected" | "landed" | "post-merge-verified" | "incomplete";

export interface ReconstructedAttempt {
	attemptId: string;
	/** In store total order — the events this attempt actually produced, however many. */
	events: LandAttemptEvent[];
	terminal: AttemptTerminalStage;
	/** The most recent `assessmentKey` any of this attempt's events referenced (via `assessmentKey` or,
	 *  failing that, `previousAssessmentKey`) — `undefined` when no event in this attempt ever attached
	 *  an assessment (e.g. a `rejected` attempt that failed before analysis ran). */
	finalAssessmentKey?: string;
}

export interface ReconstructedStore {
	/** Sorted by `attemptId` for deterministic report output. */
	attempts: ReconstructedAttempt[];
	snapshotsByAssessmentKey: Map<string, LandAssessmentSnapshot>;
	malformed: MalformedLine[];
}

/**
 * Fold one repository's raw record stream into per-attempt event sequences plus a store-wide snapshot
 * index. `records` from `readRepositoryStore` is ALREADY in store total order, so grouping by
 * `attemptId` while iterating preserves that order within each attempt's own event list without a
 * separate sort — `seq` (per-attempt, stamped at mint) is never used for cross-event ordering here,
 * matching `schema.ts`'s own documented rule.
 */
export async function reconstructRepositoryStore(stateDir: string, repositoryId: string): Promise<ReconstructedStore> {
	const { records, malformed } = await readRepositoryStore(stateDir, repositoryId);
	const byAttempt = new Map<string, LandAttemptEvent[]>();
	const snapshotsByAssessmentKey = new Map<string, LandAssessmentSnapshot>();
	for (const { envelope } of records) {
		if (envelope.kind === "attempt-event") {
			const list = byAttempt.get(envelope.record.attemptId);
			if (list) list.push(envelope.record);
			else byAttempt.set(envelope.record.attemptId, [envelope.record]);
		} else {
			snapshotsByAssessmentKey.set(envelope.record.assessmentKey, envelope.record);
		}
	}
	const attempts: ReconstructedAttempt[] = [];
	for (const [attemptId, events] of byAttempt) {
		let terminal: AttemptTerminalStage = "incomplete";
		let finalAssessmentKey: string | undefined;
		for (const e of events) {
			if (TERMINAL_STAGES.has(e.stage)) terminal = e.stage as AttemptTerminalStage;
			if (e.assessmentKey) finalAssessmentKey = e.assessmentKey;
			else if (e.previousAssessmentKey && !finalAssessmentKey) finalAssessmentKey = e.previousAssessmentKey;
		}
		attempts.push({ attemptId, events, terminal, finalAssessmentKey });
	}
	attempts.sort((a, b) => a.attemptId.localeCompare(b.attemptId));
	return { attempts, snapshotsByAssessmentKey, malformed };
}
