#!/usr/bin/env bun
/**
 * Backfill machine-readable, unattributable-reason annotations onto HISTORICAL `RunReceipt` rows
 * missing `harness`/`model` (glance#331).
 *
 * The write-time gap this ticket originally described is already fixed on main (f3294d58,
 * "fix(receipts): stamp harness + backfilled model onto receipts at write time", landed
 * 2026-07-07, tests/receipt-attribution.test.ts): `RunAccumulator.snapshot()` has stamped
 * `harness: rec.harness?.name ?? actualUnitHarness(rec.options)` unconditionally since
 * commit 390bf610 (2026-07-02), and `finalizeRun` re-syncs `seed.model` from
 * `applyState`'s poll-backfilled `rec.dto.model` before every snapshot. This script exists
 * ONLY to annotate rows already on disk from before that fix — it never touches the write path.
 *
 * THIS SCRIPT IS AN ANNOTATOR, NOT AN ATTRIBUTOR. After two gauntlet rounds it never writes a
 * `harness` or `model` VALUE — it only ever stamps a durable, machine-readable REASON explaining
 * why the value can't be determined. That is the deliberate final shape, not a stepping stone:
 * every value-attribution path tried so far (blind-stamp-from-absence, roster cross-reference,
 * task-outcomes cross-reference) turned out to be a fabrication risk under some real scenario in
 * this codebase, and none of the durable, agentId-keyed records available anywhere in the state
 * dir are RUN-scoped (see Finding 2 below) — so there is no source left to attribute from without
 * guessing.
 *
 * GAUNTLET ROUND 1 (PR #342 blind cross-lineage review — block verdict, adjudicated) fixed:
 * fabricating `harness:"omp"` from mere absence (pre-fix ACP units also predate the stamp);
 * cross-referencing `task-outcomes.jsonl` for `model` (agentId-keyed, no runId, stale-row risk);
 * no schema guard at the JSON.parse trust boundary; opening the source file with `"w"` (crash =
 * truncation); no defense against a concurrent daemon append during read→rewrite.
 *
 * GAUNTLET ROUND 2 (fresh blind codex, executed counterexamples — block verdict, adjudicated):
 *
 *   Finding 1 (CRITICAL): round 1's daemon-lock PROBE (read-only) cannot provide mutual
 *   exclusion — a daemon starting right after the probe still appends through its own
 *   already-open `O_APPEND` file descriptor to the SAME inode this script's rename unlinks;
 *   that write is silently discarded when the daemon's fd closes, and the pre-rename re-stat
 *   can't see it (the daemon's write lands on the OLD inode, which this script's `fs.stat`
 *   never looks at again once it has its own snapshot). Fix: `runBackfill` now ACQUIRES AND
 *   HOLDS the real single-writer lock (`state-lock.ts`'s `acquireStateLock` — the SAME
 *   mechanism `up.sh` calls before a daemon touches its state dir) for the ENTIRE pass,
 *   released in a `finally`. A daemon that tries to start mid-pass now blocks on THIS lock at
 *   its own startup instead of racing an open fd against a rename — genuine mutual exclusion,
 *   not a best-effort snapshot comparison. `probeDaemonLock` (fast, no lock-file I/O) and the
 *   per-file re-stat both stay as defense in depth on top of the real lock, not instead of it.
 *   Also fixed in this finding: a file the pre-rename re-stat aborted was still being counted
 *   in the summary as if its rows had been backfilled/annotated — it now counts ONLY toward
 *   `filesAbortedConcurrentWrite`, since nothing on disk actually changed for that file.
 *
 *   Finding 2 (HIGH → SIMPLIFICATION): round 1's `state.json` roster cross-reference for
 *   `harness` was dropped ENTIRELY, not narrowed further. `state.json` evidence is
 *   AGENT-scoped, not RUN-scoped — and `squad-manager.ts`'s `create()` (~line 6894) explicitly
 *   documents that a caller-supplied deterministic id (`deriveBranchAgentId`, a pure function
 *   of runId/branchKey/nodeId) is a LEGITIMATE RESURRECTION target: an authorized re-create
 *   clears any removal tombstone and reuses the same `agentId`. A workflow-resumed unit
 *   recreated under a DIFFERENT harness, reusing an old id, would make this script stamp the
 *   NEW harness onto an OLD receipt that ran under a different one entirely — exactly the
 *   fabrication class Finding 3 of round 1 already removed for the "absence" case, reappearing
 *   one layer down for the "roster join" case. The live fixture already yielded ZERO
 *   roster-attributable rows even before this fix (state.json is a rolling snapshot that had
 *   long since rotated past every historical agentId), so removing the code path costs nothing
 *   in practice and removes a real hazard in principle. Final behavior: `harness`/`model` are
 *   NEVER written by this script, full stop — every missing-`harness` row gets
 *   `harnessUnattributableReason` (`"no_run_scoped_harness_evidence"` or the more specific
 *   `"agent_id_prefix_ambiguous"`), and every missing-`model` row gets
 *   `modelUnattributableReason` (`"no_run_scoped_model_evidence"`, unchanged from round 1).
 *
 *   Finding 3 (HIGH): `guardReceiptShape` validated a SUBSET of fields — `{"agentId":"a"}`
 *   passed and got rewritten; a wrong-typed `startedAt`/`filesTouched`/any other known field
 *   also passed silently. Fixed: every REQUIRED `RunReceipt` field's presence AND type is now
 *   checked, and every PRESENT optional field's type is checked too (including nested shapes
 *   `tokens`'s five numeric sub-fields, and the fixed enums for `status`/`lane`/`tier`).
 *   Unknown top-level keys still fail the whole file, as before.
 *
 *   Finding 4 (MEDIUM): an empty-string `harness` was treated as ABSENT by `classifyReceipt`
 *   (`=== undefined || === null` only) but as PRESENT by the old `applyClassification`'s
 *   `harnessPresent` check (`!== ""` — so a `""` value was excluded from being "missing" there
 *   too, inconsistently with the schema guard's stricter checks elsewhere). Fixed: one shared
 *   `isAbsent`/`hasValue` predicate (`undefined`/`null`/`""` are ALL absent) used everywhere
 *   `harness`/`model` presence is checked.
 *
 *   Finding 5 (MEDIUM): `fs.open(tmp, "wx")` creates the temp file under the PROCESS's current
 *   umask, which can widen a `0600` receipt to `0644` — the rename would then silently loosen
 *   the original file's permissions. Fixed: `writeIfUnchanged` `chmod`s the temp file to
 *   `before.mode & 0o777` (the SOURCE file's own permission bits) before it's renamed into
 *   place — round 3 widens this mask further, see below.
 *
 * GAUNTLET ROUND 3 (fresh blind codex — invariant-only findings, no CRITICAL survived this round
 * except one that's PRE-EXISTING `state-lock.ts` code, split off as glance#345 and NOT fixed here
 * per that ticket's scope):
 *
 *   Finding 1: `guardReceiptShape` checked `toolTally`'s and `tokens`'s OUTER shape but not their
 *   VALUES or extra keys — codex's failing row `{"toolTally":{"bash":"one"}}` passed and got
 *   rewritten. Fixed: `toolTally` values must all be finite numbers; `tokens` rejects any key
 *   outside its five known fields; `spans[]` and `validation` are now recursively validated —
 *   every `Span` field/enum (`guardSpan`), every `ValidationRecord` field/enum including nested
 *   `perCriterion[]`/`lensAdvisory[]`/`lensVerify` (`guardValidationRecord`) — and any unrecognized
 *   nested key fails the row (and so the whole file) exactly like an unrecognized top-level key.
 *
 *   Finding 2: `readdir`/`readFile` failures OTHER than `ENOENT` (EACCES, EIO, a `receipts` path
 *   that's a plain file → ENOTDIR) were caught by the same bare `catch { names = [] }` as a
 *   genuinely-missing directory, silently reporting "0 files scanned" — success-shaped output for
 *   a state dir this script couldn't actually read. Fixed: only `ENOENT` degrades to an empty
 *   scan; every other error throws {@link ReceiptsDirUnreadable}, which the CLI surfaces and exits
 *   non-zero (3) for, naming the underlying error.
 *
 *   Finding 3: `KNOWN_RECEIPT_KEYS` was a plain runtime `Set` built by hand from `RunReceipt`'s
 *   fields — nothing forced it to stay in sync if `RunReceipt` gained a new optional field later.
 *   Fixed: it's now built from `RECEIPT_KEY_RECORD`, a `satisfies Record<keyof RunReceipt, true>`
 *   literal — TypeScript now REJECTS this file at compile time if `RunReceipt` gains a field this
 *   record doesn't list (or loses one this record still lists). This only holds because
 *   `scripts/backfill-receipt-attribution.ts` is itself part of the `tsc --noEmit` program now
 *   (tsconfig.json's `include`, alongside the existing `scripts/skills-verify.ts` precedent) — bun
 *   runs this file directly and strips types at runtime, so without that `include` entry the
 *   ratchet would silently never fire. The same `satisfies` pattern is applied to every OTHER
 *   fixed-vocabulary field this guard checks that has a real exported union type to ratchet
 *   against (`AgentStatus`, `WorkLane`, `ComplexityTier`, `SpanKind`, `SpanStatus`,
 *   `ModelLineage`, `LensId`) — the handful of enums defined only as INLINE literal unions inside
 *   `ValidationRecord` itself (`verdict`, `lensAdvisory[].disposition/.severity`) have no
 *   importable type name to ratchet against and stay plain `Set`s, noted where they appear.
 *
 *   Finding 4: mode preservation only masked `& 0o777` (permission bits), dropping the special
 *   bits (setuid/setgid/sticky, `0o7000`). Fixed: `before.mode & 0o7777`.
 *
 *   Finding 5: `parseArgs` accepted ANY token after `--state-dir`, including one that looks like
 *   another flag — `--state-dir --dry-run` silently set `stateDir` to the literal string
 *   `"--dry-run"` and left `dryRun` false, rather than erroring. Fixed: a token starting with
 *   `--` immediately after `--state-dir` is rejected as almost certainly a misplaced flag, not a
 *   real path.
 *
 *   Finding 6 (test gap): the round-2 "acquires and releases" test only proved the lock was ABSENT
 *   before the run and ABSENT after — a version with the real `acquireStateLock` call deleted
 *   entirely would pass that test too. Fixed: a test-only `onLockHeld` hook (never used outside
 *   tests) lets a test await a barrier WHILE `runBackfill` is inside its locked section, and prove
 *   a concurrent `acquireStateLock` attempt genuinely FAILS during that window.
 *
 *   Finding 7 (test gap): nothing pinned that the write path replaces the file via `rename` rather
 *   than an in-place overwrite (which would reopen the same crash-truncation window Finding 1
 *   round 1 fixed). Fixed: a minimal assertion that the file's inode NUMBER changes across a
 *   rewrite — cheap and sufficient to distinguish rename-based replacement from in-place write,
 *   without a full syscall-spy harness (adjudicated overkill for what this needs to prove).
 *
 * Usage:
 *   bun scripts/backfill-receipt-attribution.ts --state-dir <dir> [--dry-run]
 *   bun scripts/backfill-receipt-attribution.ts --help
 *
 * --dry-run reports attributable/unattributable counts and touches NO receipt data — but BOTH
 * modes acquire (and release) the real state-dir lock for the duration of the pass, and both
 * REFUSE to run (exit 2) if a live daemon already holds it. This is the OPERATOR's call against
 * a live state dir; nothing in the repo invokes this automatically and it is never run here
 * against ~/.glance.
 */

import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkLane } from "../src/lane.ts";
import type { LensId } from "../src/lens-select.ts";
import type { ModelLineage } from "../src/model-lineage.ts";
import type { ComplexityTier } from "../src/model-outcomes.ts";
import type { RunReceipt } from "../src/receipts.ts";
import type { SpanKind, SpanStatus } from "../src/spans.ts";
import { acquireStateLock, type LockRecord, probeDaemonLock, type StateLock, StateLockError } from "../src/state-lock.ts";
import type { AgentStatus } from "../src/types.ts";

/** Prefixes an external ingester's own `agentId` always carries (src/ingest/claude-code.ts's
 *  `cc-${short}`, codex.ts's `codex-${short}`, openrouter.ts's `or-${date}-${slug}`) — used ONLY
 *  to pick a more specific unattributable reason code, never to attribute anything. */
const INGESTED_AGENT_ID_PREFIXES = ["cc-", "codex-", "or-"];

/** Refusing to run because a live daemon holds (or started holding, between the fast probe and
 *  the real acquire attempt) the state dir's single-writer lock (Findings 1+2, round 1; Finding
 *  1, round 2). */
export class DaemonLockRefusal extends Error {
	constructor(public readonly owner: LockRecord) {
		super(
			`refusing to run: a live glance daemon (pid ${owner.pid} on ${owner.host}) currently holds ` +
				`this state dir's single-writer lock (state-lock.ts's daemon.lock — the same lock ` +
				`acquireStateLock takes, and this script now holds for its ENTIRE pass). Stop it first, ` +
				`or point --state-dir at a quiesced copy. See --help for the residual race this still ` +
				`narrows but does not eliminate.`,
		);
		this.name = "DaemonLockRefusal";
	}
}

/** Refusing to report success because the receipts directory couldn't actually be read — round 3
 *  Finding 2: a bare `catch { names = [] }` around `readdir` used to treat EACCES/EIO/ENOTDIR
 *  (e.g. `receipts` existing as a plain FILE, not a directory) exactly like a genuinely-missing
 *  directory, silently printing "0 files scanned" for a state dir this script couldn't actually
 *  read. Only `ENOENT` (truly nothing there yet) still degrades to an empty scan; every other
 *  error surfaces as this, which the CLI exits non-zero for, naming the underlying cause. */
export class ReceiptsDirUnreadable extends Error {
	constructor(
		public readonly dir: string,
		public readonly cause: unknown,
	) {
		super(`refusing to report success: could not read receipts dir "${dir}": ${cause instanceof Error ? cause.message : String(cause)}`);
		this.name = "ReceiptsDirUnreadable";
	}
}

/** Machine-readable, durable reason codes for a `harnessUnattributableReason` stamp — a small
 *  fixed vocabulary, never free prose. `model` is never attributed either (Finding 2, round 2),
 *  so it gets exactly one fixed code, `MODEL_UNATTRIBUTABLE_REASON` below. */
export type HarnessUnattributableReason = "no_run_scoped_harness_evidence" | "agent_id_prefix_ambiguous";

/** The single fixed reason code for `model` — never attributed by this script. */
export const MODEL_UNATTRIBUTABLE_REASON = "no_run_scoped_model_evidence" as const;

export interface ClassifyResult {
	harnessUnattributableReason?: HarnessUnattributableReason;
	modelUnattributableReason?: typeof MODEL_UNATTRIBUTABLE_REASON;
}

/** `undefined`/`null`/`""` are ALL "absent" — used identically for both `harness` and `model`
 *  everywhere presence is checked (Finding 4, round 2: the two fields disagreed on this before). */
function isAbsent(v: string | undefined | null): boolean {
	return v === undefined || v === null || v === "";
}

/** Pure classification: given one parsed (and already schema-guarded) receipt, decide which
 *  unattributable-reason codes (if any) belong on it. `harness`/`model` VALUES are never
 *  attributed — see the module doc's "annotator, not attributor" note. Never mutates `receipt`;
 *  the caller applies the result. */
export function classifyReceipt(receipt: RunReceipt): ClassifyResult {
	const result: ClassifyResult = {};

	if (isAbsent(receipt.harness)) {
		const suspect = INGESTED_AGENT_ID_PREFIXES.some((p) => receipt.agentId.startsWith(p));
		result.harnessUnattributableReason = suspect ? "agent_id_prefix_ambiguous" : "no_run_scoped_harness_evidence";
	}

	if (isAbsent(receipt.model)) result.modelUnattributableReason = MODEL_UNATTRIBUTABLE_REASON;

	return result;
}

/** Apply a `ClassifyResult` onto a receipt, returning a NEW object only when a final field VALUE
 *  actually differs from the input — so re-auditing an already-reasoned row (same code
 *  recomputed every pass) is a true no-op: same reference back, nothing to rewrite. Never
 *  mutates the input, and never touches `harness`/`model` themselves (only their `*
 *  UnattributableReason` siblings). */
export function applyClassification(receipt: RunReceipt, result: ClassifyResult): RunReceipt {
	const harnessAbsent = isAbsent(receipt.harness);
	const nextHarnessReason = harnessAbsent ? (result.harnessUnattributableReason ?? receipt.harnessUnattributableReason) : undefined;

	const modelAbsent = isAbsent(receipt.model);
	const nextModelReason = modelAbsent ? (result.modelUnattributableReason ?? receipt.modelUnattributableReason) : undefined;

	const harnessReasonChanged = nextHarnessReason !== receipt.harnessUnattributableReason;
	const modelReasonChanged = nextModelReason !== receipt.modelUnattributableReason;
	if (!harnessReasonChanged && !modelReasonChanged) return receipt;

	const next: RunReceipt = { ...receipt };
	if (harnessReasonChanged) {
		if (nextHarnessReason === undefined) delete next.harnessUnattributableReason;
		else next.harnessUnattributableReason = nextHarnessReason;
	}
	if (modelReasonChanged) {
		if (nextModelReason === undefined) delete next.modelUnattributableReason;
		else next.modelUnattributableReason = nextModelReason;
	}
	return next;
}

// ── Schema guard (round 1 Finding 5; round 2 Finding 3; round 3 Finding 1+3 — nested + ratcheted) ─

/** Every top-level key this version of `RunReceipt` (src/receipts.ts) can carry — a COMPILE-TIME
 *  exhaustive record over `keyof RunReceipt` (round 3, Finding 3): a `RunReceipt` field this
 *  object doesn't list (added, renamed, or removed) fails `satisfies Record<keyof RunReceipt,
 *  true>` at typecheck time, so the guard's key set can never silently drift from the real type.
 *  This only fires because this file is itself part of the `tsc --noEmit` program — see
 *  tsconfig.json's `include`. */
const RECEIPT_KEY_RECORD = {
	agentId: true,
	name: true,
	repo: true,
	branch: true,
	model: true,
	runId: true,
	startedAt: true,
	endedAt: true,
	durationMs: true,
	status: true,
	toolCalls: true,
	toolTally: true,
	tokens: true,
	costUsd: true,
	filesTouched: true,
	traceId: true,
	spans: true,
	sampled: true,
	featureId: true,
	parentId: true,
	harness: true,
	harnessUnattributableReason: true,
	modelUnattributableReason: true,
	validation: true,
	confidence: true,
	efficiencyFlags: true,
	lane: true,
	tier: true,
} satisfies Record<keyof RunReceipt, true>;
const KNOWN_RECEIPT_KEYS = new Set<string>(Object.keys(RECEIPT_KEY_RECORD));

/** Fixed-vocabulary fields ratcheted the SAME way, against a real exported union type. */
const AGENT_STATUS_RECORD = { starting: true, working: true, idle: true, input: true, error: true, stopped: true } satisfies Record<AgentStatus, true>;
const AGENT_STATUSES = new Set<string>(Object.keys(AGENT_STATUS_RECORD));
const WORK_LANE_RECORD = { hotfix: true, feature: true, chore: true } satisfies Record<WorkLane, true>;
const WORK_LANES = new Set<string>(Object.keys(WORK_LANE_RECORD));
const COMPLEXITY_TIER_RECORD = { light: true, mid: true, heavy: true } satisfies Record<ComplexityTier, true>;
const COMPLEXITY_TIERS = new Set<string>(Object.keys(COMPLEXITY_TIER_RECORD));
const SPAN_KIND_RECORD = { run: true, node: true, tool: true, subagent: true, verify: true, spawn: true, validate: true, land: true, resolve: true } satisfies Record<SpanKind, true>;
const SPAN_KINDS = new Set<string>(Object.keys(SPAN_KIND_RECORD));
const SPAN_STATUS_RECORD = { ok: true, error: true, running: true } satisfies Record<SpanStatus, true>;
const SPAN_STATUSES = new Set<string>(Object.keys(SPAN_STATUS_RECORD));
const MODEL_LINEAGE_RECORD = { anthropic: true, openai: true, google: true, xai: true, unknown: true } satisfies Record<ModelLineage, true>;
const MODEL_LINEAGES = new Set<string>(Object.keys(MODEL_LINEAGE_RECORD));
const LENS_ID_RECORD = { regression: true } satisfies Record<LensId, true>;
const LENS_IDS = new Set<string>(Object.keys(LENS_ID_RECORD));
/** `ValidationRecord.verdict`/`lensAdvisory[].disposition`/`.severity` are INLINE literal unions
 *  inside `types.ts` (no exported type name to `satisfies` against) — plain Sets, not ratcheted.
 *  If one of these ever grows a value, this guard rejects the new value as unrecognized until a
 *  human updates it here, same failure MODE as before round 3, just now for a smaller surface. */
const VALIDATION_VERDICTS = new Set(["pass", "veto", "abstain", "skipped", "inconclusive"]);
const LENS_DISPOSITIONS = new Set(["accept", "object"]);
const LENS_SEVERITIES = new Set(["low", "high"]);

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
const TOKENS_KEYS = new Set<string>(TOKEN_FIELDS);
const SPAN_KEYS = new Set(["traceId", "spanId", "parentSpanId", "name", "kind", "startedAt", "endedAt", "status", "attrs"]);
const VALIDATION_KEYS = new Set(["verdict", "agreement", "confidence", "perCriterion", "rationale", "model", "authorLineage", "reviewerLineage", "sameLineage", "lensAdvisory", "lensVerify", "gateLogPaths", "ranAt"]);
const PER_CRITERION_KEYS = new Set(["id", "satisfied", "note"]);
const LENS_VERDICT_KEYS = new Set(["lens", "disposition", "severity", "claim"]);
const LENS_VERIFY_KEYS = new Set(["lens", "claim", "confirmed"]);

export interface SchemaGuardFailure {
	reason: "not_an_object" | "unknown_keys" | "invalid_field_type";
	detail: string;
}

function isFiniteNumber(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}
function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.length > 0;
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}
/** Top-level keys of `obj` that aren't in `allowed` — empty when the object is closed over that set. */
function extraKeys(obj: Record<string, unknown>, allowed: Set<string>): string[] {
	return Object.keys(obj).filter((k) => !allowed.has(k));
}

/** `Span` (src/spans.ts), fully validated: closed key set, every required field's type, every
 *  present optional field's type, `kind`/`status` against their real enum. Returns a failure
 *  detail string (dotted/indexed path) or `undefined` when recognized. */
function guardSpan(value: unknown, index: number): string | undefined {
	if (!isPlainObject(value)) return `spans[${index}]`;
	const extra = extraKeys(value, SPAN_KEYS);
	if (extra.length > 0) return `spans[${index}].{${extra.join(",")}}`;
	if (!isNonEmptyString(value.traceId)) return `spans[${index}].traceId`;
	if (!isNonEmptyString(value.spanId)) return `spans[${index}].spanId`;
	if (value.parentSpanId !== undefined && typeof value.parentSpanId !== "string") return `spans[${index}].parentSpanId`;
	if (!isNonEmptyString(value.name)) return `spans[${index}].name`;
	if (typeof value.kind !== "string" || !SPAN_KINDS.has(value.kind)) return `spans[${index}].kind`;
	if (!isFiniteNumber(value.startedAt)) return `spans[${index}].startedAt`;
	if (value.endedAt !== undefined && !isFiniteNumber(value.endedAt)) return `spans[${index}].endedAt`;
	if (typeof value.status !== "string" || !SPAN_STATUSES.has(value.status)) return `spans[${index}].status`;
	if (value.attrs !== undefined) {
		if (!isPlainObject(value.attrs)) return `spans[${index}].attrs`;
		for (const v of Object.values(value.attrs)) if (typeof v !== "string") return `spans[${index}].attrs value`;
	}
	return undefined;
}

function guardPerCriterion(value: unknown, index: number): string | undefined {
	if (!isPlainObject(value)) return `validation.perCriterion[${index}]`;
	const extra = extraKeys(value, PER_CRITERION_KEYS);
	if (extra.length > 0) return `validation.perCriterion[${index}].{${extra.join(",")}}`;
	if (!isNonEmptyString(value.id)) return `validation.perCriterion[${index}].id`;
	if (typeof value.satisfied !== "boolean") return `validation.perCriterion[${index}].satisfied`;
	if (value.note !== undefined && typeof value.note !== "string") return `validation.perCriterion[${index}].note`;
	return undefined;
}

function guardLensVerdict(value: unknown, index: number): string | undefined {
	if (!isPlainObject(value)) return `validation.lensAdvisory[${index}]`;
	const extra = extraKeys(value, LENS_VERDICT_KEYS);
	if (extra.length > 0) return `validation.lensAdvisory[${index}].{${extra.join(",")}}`;
	if (typeof value.lens !== "string" || !LENS_IDS.has(value.lens)) return `validation.lensAdvisory[${index}].lens`;
	if (typeof value.disposition !== "string" || !LENS_DISPOSITIONS.has(value.disposition)) return `validation.lensAdvisory[${index}].disposition`;
	if (typeof value.severity !== "string" || !LENS_SEVERITIES.has(value.severity)) return `validation.lensAdvisory[${index}].severity`;
	if (typeof value.claim !== "string") return `validation.lensAdvisory[${index}].claim`;
	return undefined;
}

/** `ValidationRecord` (src/types.ts), fully validated: closed key set, every required field's
 *  type, every present optional field's type (recursing into `perCriterion[]`, `lensAdvisory[]`,
 *  `lensVerify`), and every enum against its real vocabulary where one exists. */
function guardValidationRecord(value: unknown): string | undefined {
	if (!isPlainObject(value)) return "validation";
	const extra = extraKeys(value, VALIDATION_KEYS);
	if (extra.length > 0) return `validation.{${extra.join(",")}}`;
	if (typeof value.verdict !== "string" || !VALIDATION_VERDICTS.has(value.verdict)) return "validation.verdict";
	if (!isFiniteNumber(value.agreement)) return "validation.agreement";
	if (!isFiniteNumber(value.confidence)) return "validation.confidence";
	if (!Array.isArray(value.perCriterion)) return "validation.perCriterion";
	for (let i = 0; i < value.perCriterion.length; i++) {
		const failure = guardPerCriterion(value.perCriterion[i], i);
		if (failure) return failure;
	}
	if (typeof value.rationale !== "string") return "validation.rationale";
	if (value.model !== undefined && typeof value.model !== "string") return "validation.model";
	if (value.authorLineage !== undefined && (typeof value.authorLineage !== "string" || !MODEL_LINEAGES.has(value.authorLineage))) return "validation.authorLineage";
	if (value.reviewerLineage !== undefined && (typeof value.reviewerLineage !== "string" || !MODEL_LINEAGES.has(value.reviewerLineage))) return "validation.reviewerLineage";
	if (value.sameLineage !== undefined && typeof value.sameLineage !== "boolean") return "validation.sameLineage";
	if (value.lensAdvisory !== undefined) {
		if (!Array.isArray(value.lensAdvisory)) return "validation.lensAdvisory";
		for (let i = 0; i < value.lensAdvisory.length; i++) {
			const failure = guardLensVerdict(value.lensAdvisory[i], i);
			if (failure) return failure;
		}
	}
	if (value.lensVerify !== undefined) {
		if (!isPlainObject(value.lensVerify)) return "validation.lensVerify";
		const extraLv = extraKeys(value.lensVerify, LENS_VERIFY_KEYS);
		if (extraLv.length > 0) return `validation.lensVerify.{${extraLv.join(",")}}`;
		if (typeof value.lensVerify.lens !== "string" || !LENS_IDS.has(value.lensVerify.lens)) return "validation.lensVerify.lens";
		if (typeof value.lensVerify.claim !== "string") return "validation.lensVerify.claim";
		if (typeof value.lensVerify.confirmed !== "boolean") return "validation.lensVerify.confirmed";
	}
	if (value.gateLogPaths !== undefined && !isStringArray(value.gateLogPaths)) return "validation.gateLogPaths";
	if (!isFiniteNumber(value.ranAt)) return "validation.ranAt";
	return undefined;
}

/** Structural guard (deliberately NOT Effect `Schema.Struct` — `src/schema/http-body.ts`'s own
 *  doc notes `Schema.Struct` SILENTLY STRIPS excess keys, the opposite of what a trust boundary
 *  here needs). Validates: the value is a plain object; every top-level key is recognized
 *  (ratcheted against `keyof RunReceipt`, round 3); every REQUIRED field is present with the
 *  right type; every PRESENT optional field has the right type — recursing FULLY into `tokens`
 *  (closed key set, all five values numeric), `toolTally` (every value numeric), `spans[]`
 *  (every `Span` fully validated), and `validation` (every `ValidationRecord` field/enum fully
 *  validated, round 3 Finding 1). Returns `undefined` when the row is fully recognized. */
export function guardReceiptShape(value: unknown): SchemaGuardFailure | undefined {
	if (!isPlainObject(value)) return { reason: "not_an_object", detail: typeof value };
	const obj = value;

	const unknown = extraKeys(obj, KNOWN_RECEIPT_KEYS);
	if (unknown.length > 0) return { reason: "unknown_keys", detail: unknown.join(",") };

	const invalid = (detail: string): SchemaGuardFailure => ({ reason: "invalid_field_type", detail });

	// Required: presence AND type.
	if (!isNonEmptyString(obj.agentId)) return invalid("agentId");
	if (!isNonEmptyString(obj.name)) return invalid("name");
	if (!isNonEmptyString(obj.repo)) return invalid("repo");
	if (!isNonEmptyString(obj.runId)) return invalid("runId");
	if (!isFiniteNumber(obj.startedAt)) return invalid("startedAt");
	if (typeof obj.status !== "string" || !AGENT_STATUSES.has(obj.status)) return invalid("status");
	if (!isFiniteNumber(obj.toolCalls)) return invalid("toolCalls");
	if (!isPlainObject(obj.toolTally)) return invalid("toolTally");
	for (const v of Object.values(obj.toolTally)) if (!isFiniteNumber(v)) return invalid("toolTally value");
	if (!Array.isArray(obj.filesTouched) || !obj.filesTouched.every((x) => typeof x === "string")) return invalid("filesTouched");

	// Optional: type only when present.
	if (obj.branch !== undefined && typeof obj.branch !== "string") return invalid("branch");
	if (obj.model !== undefined && typeof obj.model !== "string") return invalid("model");
	if (obj.endedAt !== undefined && !isFiniteNumber(obj.endedAt)) return invalid("endedAt");
	if (obj.durationMs !== undefined && !isFiniteNumber(obj.durationMs)) return invalid("durationMs");
	if (obj.tokens !== undefined) {
		if (!isPlainObject(obj.tokens)) return invalid("tokens");
		const extraTokens = extraKeys(obj.tokens, TOKENS_KEYS);
		if (extraTokens.length > 0) return invalid(`tokens.{${extraTokens.join(",")}}`);
		for (const k of TOKEN_FIELDS) if (!isFiniteNumber(obj.tokens[k])) return invalid(`tokens.${k}`);
	}
	if (obj.costUsd !== undefined && !isFiniteNumber(obj.costUsd)) return invalid("costUsd");
	if (obj.traceId !== undefined && typeof obj.traceId !== "string") return invalid("traceId");
	if (obj.spans !== undefined) {
		if (!Array.isArray(obj.spans)) return invalid("spans");
		for (let i = 0; i < obj.spans.length; i++) {
			const failure = guardSpan(obj.spans[i], i);
			if (failure) return invalid(failure);
		}
	}
	if (obj.sampled !== undefined && typeof obj.sampled !== "boolean") return invalid("sampled");
	if (obj.featureId !== undefined && typeof obj.featureId !== "string") return invalid("featureId");
	if (obj.parentId !== undefined && typeof obj.parentId !== "string") return invalid("parentId");
	if (obj.harness !== undefined && typeof obj.harness !== "string") return invalid("harness");
	if (obj.harnessUnattributableReason !== undefined && typeof obj.harnessUnattributableReason !== "string") return invalid("harnessUnattributableReason");
	if (obj.modelUnattributableReason !== undefined && typeof obj.modelUnattributableReason !== "string") return invalid("modelUnattributableReason");
	if (obj.validation !== undefined) {
		const failure = guardValidationRecord(obj.validation);
		if (failure) return invalid(failure);
	}
	if (obj.confidence !== undefined && !isFiniteNumber(obj.confidence)) return invalid("confidence");
	if (obj.efficiencyFlags !== undefined && !isStringArray(obj.efficiencyFlags)) return invalid("efficiencyFlags");
	if (obj.lane !== undefined && (typeof obj.lane !== "string" || !WORK_LANES.has(obj.lane))) return invalid("lane");
	if (obj.tier !== undefined && (typeof obj.tier !== "string" || !COMPLEXITY_TIERS.has(obj.tier))) return invalid("tier");

	return undefined;
}

// ── Per-file planning ─────────────────────────────────────────────────────────────────────────

export interface FileReport {
	file: string;
	lines: number;
	harnessUnattributable: number;
	modelUnattributable: number;
	parseErrors: number;
	/** True ⇒ the WHOLE file was left byte-identical because at least one row wasn't a recognized
	 *  RunReceipt shape — nothing in it was touched, including rows that would otherwise have
	 *  been annotated. */
	skippedUnknownSchema: boolean;
	skippedUnknownSchemaDetail: string[];
	/** True ⇒ this file HAD changes to write, but the pre-rename re-stat found the original had
	 *  drifted since it was read — nothing was written; safe to retry later. When this is true,
	 *  `harnessUnattributable`/`modelUnattributable` above are zeroed (Finding 1, round 2): they
	 *  must never read as "done" when nothing was actually written to disk. */
	abortedConcurrentWrite: boolean;
	changed: boolean;
}

/** Process one `<agentId>.jsonl` file's raw text into a report + the (possibly unchanged)
 *  rewritten text. Two passes: (1) parse + schema-guard every row — any failure anywhere in the
 *  file means the file is returned byte-identical; (2) only once every row is recognized,
 *  classify and (maybe) annotate each one. Never sets `harness`/`model` — see the module doc. */
export function planFile(file: string, text: string): { report: FileReport; outLines: string[] } {
	const rawLines = text.split("\n").filter((l) => l.trim().length > 0);
	const report: FileReport = {
		file,
		lines: rawLines.length,
		harnessUnattributable: 0,
		modelUnattributable: 0,
		parseErrors: 0,
		skippedUnknownSchema: false,
		skippedUnknownSchemaDetail: [],
		abortedConcurrentWrite: false,
		changed: false,
	};

	const parsed: RunReceipt[] = [];
	let unrecognized = false;
	for (let i = 0; i < rawLines.length; i++) {
		let value: unknown;
		try {
			value = JSON.parse(rawLines[i]);
		} catch {
			report.parseErrors++;
			unrecognized = true;
			report.skippedUnknownSchemaDetail.push(`line ${i + 1}: unparseable JSON`);
			continue;
		}
		const failure = guardReceiptShape(value);
		if (failure) {
			unrecognized = true;
			report.skippedUnknownSchemaDetail.push(`line ${i + 1}: ${failure.reason} (${failure.detail})`);
			continue;
		}
		parsed.push(value as RunReceipt);
	}

	if (unrecognized) {
		report.skippedUnknownSchema = true;
		return { report, outLines: rawLines }; // byte-identical passthrough — nothing in this file is touched
	}

	const outLines: string[] = [];
	for (const receipt of parsed) {
		const result = classifyReceipt(receipt);
		if (result.harnessUnattributableReason) report.harnessUnattributable++;
		if (result.modelUnattributableReason) report.modelUnattributable++;
		const next = applyClassification(receipt, result);
		if (next !== receipt) report.changed = true;
		outLines.push(JSON.stringify(next));
	}
	return { report, outLines };
}

// ── Durable, crash-safe write path ───────────────────────────────────────────────────────────

async function statOrNull(file: string): Promise<Stats | null> {
	try {
		return await fs.stat(file);
	} catch {
		return null;
	}
}

/** Marks a file's report as aborted-by-concurrent-write: nothing was actually written to disk
 *  for it, so its speculatively-computed `harnessUnattributable`/`modelUnattributable` counts
 *  (computed by `planFile` before the write was even attempted) must not read as "done" in the
 *  aggregate totals (Finding 1, round 2 — this used to still count toward "backfilled"). Pure
 *  and side-effect-free on anything but `report` itself, so it's directly unit-testable without
 *  needing to actually race a concurrent writer. */
export function markAborted(report: FileReport): void {
	report.abortedConcurrentWrite = true;
	report.changed = false;
	report.harnessUnattributable = 0;
	report.modelUnattributable = 0;
}

/** Read a file's content AND its stat as of that read, via one open fd — ties the two together
 *  so "before" reflects the exact bytes just parsed, not a separately-raced stat call. */
async function readFileWithStat(file: string): Promise<{ text: string; stat: Stats } | null> {
	let fh: fs.FileHandle;
	try {
		fh = await fs.open(file, "r");
	} catch {
		return null;
	}
	try {
		const stat = await fh.stat();
		const text = await fh.readFile("utf8");
		return { text, stat };
	} finally {
		await fh.close();
	}
}

/** Apply `mode`'s full permission+special bits (`& 0o7777`) to `path` by shelling out to the real
 *  `chmod(1)` binary rather than `fs.chmod`/`FileHandle.chmod` — Bun 1.3.14's chmod binding
 *  silently DROPS the setgid bit even when the calling process is a member of the file's own
 *  group and a real `chmod(2)` syscall (confirmed via both the `chmod(1)` shell command and
 *  Node's `fs.promises.chmod` under identical conditions) would succeed. This is a Bun runtime
 *  bug, not a POSIX permission restriction — the workaround is mechanical (spawn the real
 *  binary) rather than reimplementing the syscall. */
async function chmodLikeSource(target: string, mode: number): Promise<void> {
	const octal = (mode & 0o7777).toString(8).padStart(4, "0");
	const proc = Bun.spawn(["chmod", octal, target], { stdout: "ignore", stderr: "pipe" });
	const code = await proc.exited;
	if (code !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`chmod ${octal} ${target} failed (exit ${code}): ${stderr.trim()}`);
	}
}

/** Write `content` for `file` durably: temp file in the SAME directory (so the final rename is
 *  same-filesystem-atomic) → `chmod` it to the SOURCE file's own mode bits (Finding 5, round 2 —
 *  a bare `"wx"` create picks up the process umask, which can widen e.g. a `0600` receipt to
 *  `0644`; round 3 Finding 4 widens the preserved mask from `0o777` to `0o7777` so the special
 *  setuid/setgid/sticky bits survive too, via `chmodLikeSource` — see its own doc for why that's
 *  a real `chmod(1)` shell-out rather than the JS binding) → fsync the temp file → re-`stat`
 *  `file` immediately before the rename and abort (unlinking the temp file, touching `file` not
 *  at all) if its mtime/size has drifted from `before` → rename → fsync the containing
 *  directory. NEVER opens `file` itself with a truncating mode — the source is only ever read
 *  (by the caller) or atomically replaced by a completed rename, never opened "w". This is
 *  defense in depth UNDER the real state-dir lock `runBackfill` now holds for the whole pass
 *  (Finding 1, round 2) — the re-stat here narrows the residual window further, it is not the
 *  primary guard. */
export async function writeIfUnchanged(file: string, content: string, before: Stats | null): Promise<{ written: boolean; drifted: boolean }> {
	const dir = path.dirname(file);
	const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
	const fh = await fs.open(tmp, "wx");
	try {
		await fh.writeFile(content, "utf8");
		await fh.sync();
	} finally {
		await fh.close();
	}
	if (before) await chmodLikeSource(tmp, before.mode);
	const now = await statOrNull(file);
	const drifted = !before || !now || now.mtimeMs !== before.mtimeMs || now.size !== before.size;
	if (drifted) {
		await fs.unlink(tmp).catch(() => {});
		return { written: false, drifted: true };
	}
	await fs.rename(tmp, file);
	const dirFh = await fs.open(dir, "r");
	try {
		await dirFh.sync();
	} finally {
		await dirFh.close();
	}
	return { written: true, drifted: false };
}

// ── Full pass ─────────────────────────────────────────────────────────────────────────────────

export interface RunOpts {
	stateDir: string;
	dryRun: boolean;
	/** TEST-ONLY (round 3 Finding 6): if provided, awaited immediately after the real lock is
	 *  acquired and BEFORE any file work begins — lets a test prove the lock is genuinely HELD for
	 *  the whole pass (a concurrent `acquireStateLock` attempt must fail while this hook is
	 *  pending) rather than merely acquired-then-immediately-released. Never used outside tests;
	 *  never set by the CLI. */
	onLockHeld?: () => Promise<void>;
}

export interface BackfillReport {
	stateDir: string;
	dryRun: boolean;
	filesScanned: number;
	totalLines: number;
	harnessUnattributable: number;
	modelUnattributable: number;
	parseErrors: number;
	filesSkippedUnknownSchema: number;
	filesAbortedConcurrentWrite: number;
	filesWritten: number;
	perFile: FileReport[];
}

function receiptsDir(stateDir: string): string {
	return path.join(stateDir, "receipts");
}

/** Full pass: refuse if a live daemon holds `stateDir` (fast probe first, then the REAL lock —
 *  see Finding 1, round 2), else read every `receipts/*.jsonl` file, classify every recognized
 *  row, and (unless `dryRun`) durably annotate each file that changed via `writeIfUnchanged`.
 *  Throws {@link DaemonLockRefusal} instead of running when the daemon is live — in EITHER mode,
 *  and whether the probe or the real acquire attempt is what catches it. The real lock is held
 *  for the WHOLE pass and released in a `finally`, so it's dropped even if a file read/write
 *  throws partway through. */
export async function runBackfill(opts: RunOpts): Promise<BackfillReport> {
	// Layer 1 (defense in depth): fast, read-only pre-check — avoids the lock-file I/O of a real
	// acquire attempt when a live owner is obviously already there.
	const probe = probeDaemonLock(opts.stateDir);
	if (probe.live && probe.owner) throw new DaemonLockRefusal(probe.owner);

	// Layer 2 (the REAL guard, Finding 1 round 2): acquire and HOLD the daemon's own
	// single-writer lock for the entire pass. A daemon that starts mid-pass now blocks on THIS
	// lock at its own startup (acquireStateLock is the SAME mechanism `up.sh` calls before
	// touching the state dir) instead of racing an already-open O_APPEND descriptor against our
	// rename. `handoffMs: 0` — the probe above already ruled out "obviously live"; no need to
	// also wait through the upgrade-handoff window a second time.
	let lock: StateLock;
	try {
		lock = await acquireStateLock(opts.stateDir, { handoffMs: 0 });
	} catch (err) {
		if (err instanceof StateLockError) throw new DaemonLockRefusal(err.owner);
		throw err;
	}

	try {
		if (opts.onLockHeld) await opts.onLockHeld();

		const dir = receiptsDir(opts.stateDir);
		let names: string[];
		try {
			names = (await fs.readdir(dir)).filter((n) => n.endsWith(".jsonl")).sort();
		} catch (err) {
			// ENOENT (round 3 Finding 2): genuinely nothing there yet — a fresh/never-used state dir
			// is not an error. Anything else (EACCES, EIO, ENOTDIR from `receipts` existing as a
			// plain file, …) means this script could NOT actually read the directory, and reporting
			// "0 files scanned" for that would be success-shaped output for a failure.
			if ((err as NodeJS.ErrnoException).code === "ENOENT") names = [];
			else throw new ReceiptsDirUnreadable(dir, err);
		}

		const perFile: FileReport[] = [];
		let filesWritten = 0;
		for (const name of names) {
			const full = path.join(dir, name);
			const opened = await readFileWithStat(full);
			if (!opened) continue; // vanished between readdir and open — nothing to report on
			const { text, stat } = opened;
			const { report, outLines } = planFile(name, text);
			perFile.push(report);
			if (!opts.dryRun && report.changed && !report.skippedUnknownSchema) {
				// Layer 3 (defense in depth): re-stat immediately before the rename.
				const result = await writeIfUnchanged(full, `${outLines.join("\n")}\n`, stat);
				if (result.written) filesWritten++;
				else markAborted(report);
			}
		}

		const totals = perFile.reduce(
			(acc, r) => {
				acc.totalLines += r.lines;
				acc.harnessUnattributable += r.harnessUnattributable;
				acc.modelUnattributable += r.modelUnattributable;
				acc.parseErrors += r.parseErrors;
				if (r.skippedUnknownSchema) acc.filesSkippedUnknownSchema++;
				if (r.abortedConcurrentWrite) acc.filesAbortedConcurrentWrite++;
				return acc;
			},
			{ totalLines: 0, harnessUnattributable: 0, modelUnattributable: 0, parseErrors: 0, filesSkippedUnknownSchema: 0, filesAbortedConcurrentWrite: 0 },
		);

		return {
			stateDir: opts.stateDir,
			dryRun: opts.dryRun,
			filesScanned: names.length,
			...totals,
			filesWritten,
			perFile,
		};
	} finally {
		lock.release();
	}
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────

const HELP_TEXT = `bun scripts/backfill-receipt-attribution.ts --state-dir <dir> [--dry-run]

Annotates HISTORICAL RunReceipt rows (missing harness/model, predating the write-time fix at
f3294d58) already on disk with a durable, machine-readable reason they can't be attributed.
Never touches the write path. Never writes a harness or model VALUE, ever — see the module doc's
"annotator, not attributor" note for why.

  --state-dir <dir>   the glance state dir to operate on (e.g. ~/.glance). Required.
  --dry-run           report unattributable counts; write nothing. STILL acquires and releases
                      the real state-dir lock for the duration of the check (see below) — it
                      writes no receipt data, but it is not lock-free.
  --help, -h          this text.

Exit codes: 0 = ran (see printed counts for what it did/skipped); 2 = REFUSED to run because a
live daemon holds --state-dir's single-writer lock (state-lock.ts's daemon.lock — see
DaemonLockRefusal). This script ACQUIRES AND HOLDS that same lock for its entire pass (both
modes), so a daemon trying to start while this script is running blocks at ITS OWN startup
instead of racing an open append descriptor against this script's rename. 3 = the receipts
directory could not actually be read (permissions, I/O error, a "receipts" path that's a plain
file — anything other than it simply not existing yet) — see ReceiptsDirUnreadable; this is
NEVER silently reported as "0 files scanned".

Rules (see the module doc at the top of this file for the full two-round gauntlet rationale):
  - harness/model VALUES are NEVER written by this script. Every missing-harness row gets
    harnessUnattributableReason ("no_run_scoped_harness_evidence" or the more specific
    "agent_id_prefix_ambiguous"); every missing-model row gets modelUnattributableReason
    ("no_run_scoped_model_evidence"). No cross-referencing, no roster join, no heuristics — every
    durable agentId-keyed record available in a state dir turned out to be agent-scoped or
    otherwise unable to prove which specific RUN a value belongs to.
  - Any row with an unrecognized shape (unknown key, a required field missing or wrong-typed, a
    present optional field wrong-typed, or unparseable JSON) leaves its WHOLE FILE byte-identical,
    reported as skipped.

Residual race (not eliminated, only narrowed further): holding the real lock for the whole pass
closes the "daemon starts mid-pass" race this script itself can control. It does NOT protect
against a writer that ALREADY held an open file descriptor before this script ever started (a
daemon crash-looping with a wedged fd, or a separate non-daemon process bypassing the lock
entirely) — the per-file re-stat immediately before each rename catches drift from THAT class of
writer since the file was first read, and drops that file's write rather than risk losing it. A
file dropped for drift is safe to re-run once the concurrent writer settles; this pass is
idempotent.
`;

function parseArgs(argv: string[]): RunOpts | "help" {
	if (argv.includes("--help") || argv.includes("-h")) return "help";
	let stateDir: string | undefined;
	let dryRun = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--state-dir") {
			const next = argv[i + 1];
			// Round 3 Finding 5: `--state-dir --dry-run` used to silently set stateDir to the LITERAL
			// string "--dry-run" (and leave dryRun false) instead of erroring — a token that looks
			// like another flag right after --state-dir is almost certainly a misplaced flag, not a
			// real directory name worth supporting at the cost of this footgun.
			if (next === undefined || next.startsWith("--")) {
				throw new Error(`--state-dir requires a directory path, not ${next === undefined ? "(nothing)" : `"${next}"`} — a value starting with "--" is almost certainly a misplaced flag. usage: bun scripts/backfill-receipt-attribution.ts --state-dir <dir> [--dry-run]`);
			}
			stateDir = next;
			i++;
		} else if (a === "--dry-run") dryRun = true;
	}
	if (!stateDir) throw new Error("usage: bun scripts/backfill-receipt-attribution.ts --state-dir <dir> [--dry-run]  (--help for details)");
	return { stateDir, dryRun };
}

export function printReport(report: BackfillReport): void {
	const mode = report.dryRun ? "DRY RUN — no receipt data was changed" : "LIVE — files with changes were rewritten in place";
	console.log(`Receipt attribution backfill (${mode})`);
	console.log(`  state dir:        ${report.stateDir}`);
	console.log(`  files scanned:    ${report.filesScanned}`);
	console.log(`  total rows:       ${report.totalLines}`);
	console.log(`  parse errors:     ${report.parseErrors} (counted toward "files skipped: unrecognized shape" below)`);
	console.log(`  files skipped (unrecognized row shape, left byte-identical): ${report.filesSkippedUnknownSchema}`);
	if (!report.dryRun) console.log(`  files aborted (concurrent write detected before rename):     ${report.filesAbortedConcurrentWrite}`);
	console.log("");
	console.log(`  harness unattributable (reason stamped; harness is never attributed by this script): ${report.harnessUnattributable}`);
	console.log(`  model unattributable (reason stamped; model is never attributed by this script):     ${report.modelUnattributable}`);
	if (!report.dryRun) console.log(`\n  files rewritten: ${report.filesWritten}`);
}

if (import.meta.main) {
	const opts = parseArgs(process.argv.slice(2));
	if (opts === "help") {
		console.log(HELP_TEXT);
		process.exit(0);
	}
	try {
		const report = await runBackfill(opts);
		printReport(report);
	} catch (err) {
		if (err instanceof DaemonLockRefusal) {
			console.error(err.message);
			process.exit(2);
		}
		if (err instanceof ReceiptsDirUnreadable) {
			console.error(err.message);
			process.exit(3);
		}
		throw err;
	}
}
