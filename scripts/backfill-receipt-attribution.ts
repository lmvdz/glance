#!/usr/bin/env bun
/**
 * Backfill `RunReceipt.harness`/`.model` on HISTORICAL receipts (glance#331).
 *
 * The write-time gap this once described is already fixed on main (f3294d58,
 * "fix(receipts): stamp harness + backfilled model onto receipts at write time", landed
 * 2026-07-07, tests/receipt-attribution.test.ts): `RunAccumulator.snapshot()` has stamped
 * `harness: rec.harness?.name ?? actualUnitHarness(rec.options)` unconditionally since
 * commit 390bf610 (2026-07-02), and `finalizeRun` re-syncs `seed.model` from
 * `applyState`'s poll-backfilled `rec.dto.model` before every snapshot. This script exists
 * ONLY to repair rows already on disk from before that fix — it never touches the write path.
 *
 * GAUNTLET ROUND 1 (PR #342 blind cross-lineage review — block verdict, adjudicated):
 *
 *   Finding 3 (HIGH): the round-1 version of this script treated "harness absent" as PROOF the
 *   omp lane wrote the row and blind-stamped `"omp"`. That is false — pre-fix DAEMON-MANAGED
 *   ACP units (claude-code, grok, legacy `runtime:"acp"` → auggie, resolved through
 *   `harness-registry.ts`'s `runtimeToHarness`) also predate the write-time harness stamp and
 *   wrote receipts with `harness` absent too. "Absence of harness" only narrows the field down
 *   to "written before 2026-07-03"; it says nothing about WHICH pre-fix writer produced it.
 *   Fix: harness is now attributed ONLY from POSITIVE, row-scoped evidence — a `state.json`
 *   roster entry (`src/dal/store.ts`'s `FileStore`, `StateSnapshot.agents: PersistedAgent[]`)
 *   whose `id` matches the receipt's `agentId` AND which itself carries an explicit `harness`
 *   field, or a legacy `runtime` field mapped through the SAME `runtimeToHarness` the daemon
 *   itself uses (`"acp"` → `"auggie"`, `"omp"` → `"omp"`). Deliberately NOT
 *   `resolveHarnessName`/`globalDefaultHarness` — that falls through to today's
 *   `GLANCE_HARNESS`/`"omp"` default when a record carries neither field, which for an OLD
 *   record is exactly the same fabrication-from-absence this fix removes, just one level
 *   down. A record with neither field is "no evidence", full stop. In practice `state.json` is
 *   a rolling roster snapshot (overwritten on every persist, not an append-only ledger), so it
 *   almost never still holds an agentId from a month-old receipt — expect the attributable
 *   count to be small or zero. That shrinkage is the honest answer, not a script bug.
 *
 *   Finding 4 (HIGH): `model` backfill is DROPPED ENTIRELY, not narrowed. The round-1 version
 *   cross-referenced `task-outcomes.jsonl` by `agentId` when a receipt's file held exactly one
 *   line — codex constructed the counterexample: a unit whose CURRENT single receipt line is a
 *   fresh restart with no task-outcome row of its own yet, while `task-outcomes.jsonl` still
 *   holds a STALE row from an earlier, already-deleted receipt line for the same agentId (the
 *   ledger is agentId-keyed with no `runId` — nothing proves the stale row describes THIS run).
 *   The "exactly one line today" check cannot rule that out; it only proves today's file has one
 *   line, not that it always did. Fix: every missing-`model` row gets the single fixed reason
 *   code `"no_run_scoped_model_evidence"` — never a value, and never prose asserting which
 *   runtime signals did or didn't occur (this script can't prove that; see
 *   `RunReceipt.modelUnattributableReason`'s doc in `src/receipts.ts`).
 *
 *   Finding 5 (HIGH): no bare `JSON.parse(line) as RunReceipt`. Every parsed row is preflighted
 *   by `guardReceiptShape` — an explicit structural guard (not Effect `Schema`; the codebase's
 *   own `src/schema/http-body.ts` notes `Schema.Struct` SILENTLY STRIPS excess keys, which is
 *   the opposite of what a trust boundary here needs) against the closed set of keys this
 *   version of `RunReceipt` actually has. ANY row with an unrecognized key (e.g. a future
 *   `schemaVersion`) or a wrong-typed known field means the row might carry semantics a NEWER
 *   or OLDER schema repurposed — rather than guess, the ENTIRE FILE is left byte-identical and
 *   reported as skipped. A torn/unparseable JSON line does the same (stricter than round 1,
 *   which rewrote the rest of a file around a torn line — collapsed here into one "don't touch
 *   a file with anything unrecognized in it" rule, simpler to audit and to reason about).
 *
 *   Findings 1+2 (CRITICAL): round 1 opened the SOURCE file with `"w"` — a kill between open and
 *   write leaves a truncated/empty JSONL, and a concurrent daemon append during the read→rewrite
 *   window is silently lost even with an atomic rename. Fix: `writeIfUnchanged` NEVER opens the
 *   source with `"w"`. It writes a same-directory temp file, fsyncs it, re-`stat`s the ORIGINAL
 *   file immediately before the rename and aborts (unlinking the temp file, touching nothing)
 *   on any mtime/size drift from the stat taken when the file was first read, then renames and
 *   fsyncs the containing directory. Before any of that, `runBackfill` REFUSES to run at all
 *   (dry-run included) when a live daemon holds the state dir — probed via
 *   `state-lock.ts`'s `probeDaemonLock`, the SAME `daemon.lock` single-writer check
 *   `acquireStateLock` uses (recorded pid/host, Linux `/proc` start-time to rule out pid reuse).
 *   Residual race, undocumented no longer: the daemon-lock refusal only proves no daemon was
 *   live at the moment of the check — one could still start and append between that check and
 *   any individual file's write. The per-file re-stat-before-rename narrows that window to
 *   "between this script's own stat call and its own rename call" (no OS-level file lock is
 *   taken), and DROPS that file's write rather than risk losing a concurrent append; it does not
 *   close the window to zero. A file dropped for this reason is safe to re-run once the
 *   concurrent writer settles — the pass is idempotent.
 *
 *   Finding 6 (MEDIUM): harness-unattributable reasons are now durable, machine-readable codes
 *   (`HarnessUnattributableReason`) stamped directly on the row's own
 *   `harnessUnattributableReason` field — not transient CLI-only text — so a future reader can
 *   distinguish WHY a row is unattributable (`"no_state_json_evidence"` vs the stronger
 *   `"agent_id_prefix_ambiguous"` signal) without re-running this script.
 *
 * Usage:
 *   bun scripts/backfill-receipt-attribution.ts --state-dir <dir> [--dry-run]
 *   bun scripts/backfill-receipt-attribution.ts --help
 *
 * --dry-run reports attributable/unattributable counts and touches NOTHING on disk. Without it,
 * every file with at least one changed row is rewritten via the atomic write-then-rename path
 * above. Both modes REFUSE to run (exit 2) while a live daemon holds the state dir. This is the
 * OPERATOR's call against a live state dir; nothing in the repo invokes this automatically and
 * it is never run here against ~/.glance.
 */

import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runtimeToHarness } from "../src/harness-registry.ts";
import type { RunReceipt } from "../src/receipts.ts";
import { type LockRecord, probeDaemonLock } from "../src/state-lock.ts";

/** Prefixes an external ingester's own `agentId` always carries (src/ingest/claude-code.ts's
 *  `cc-${short}`, codex.ts's `codex-${short}`, openrouter.ts's `or-${date}-${slug}`) — used ONLY
 *  to pick a more specific unattributable reason code, never to attribute anything (see the
 *  Finding 3 note above: absence of harness is not, by itself, proof of anything). */
const INGESTED_AGENT_ID_PREFIXES = ["cc-", "codex-", "or-"];

/** Refusing to run because a live daemon holds the state dir's single-writer lock (Findings 1+2). */
export class DaemonLockRefusal extends Error {
	constructor(public readonly owner: LockRecord) {
		super(
			`refusing to run: a live glance daemon (pid ${owner.pid} on ${owner.host}) currently holds ` +
				`this state dir's single-writer lock (state-lock.ts's daemon.lock — the same check ` +
				`acquireStateLock uses). Stop it first, or point --state-dir at a quiesced copy. See --help ` +
				`for the residual race this check narrows but does not eliminate.`,
		);
		this.name = "DaemonLockRefusal";
	}
}

/** Machine-readable, durable reason codes for a `harnessUnattributableReason` stamp (Finding 6) —
 *  a small fixed vocabulary, never free prose. */
export type HarnessUnattributableReason = "no_state_json_evidence" | "agent_id_prefix_ambiguous";

/** The single fixed reason code for a dropped model backfill (Finding 4) — model is never
 *  attributed by this script; every missing-model row gets exactly this code. */
export const MODEL_UNATTRIBUTABLE_REASON = "no_run_scoped_model_evidence" as const;

export interface ClassifyResult {
	/** Positive-evidence harness to stamp, when found. Any registry harness name, not just "omp" —
	 *  see `PositiveEvidenceEntry`. */
	harness?: string;
	harnessUnattributableReason?: HarnessUnattributableReason;
	modelUnattributableReason?: typeof MODEL_UNATTRIBUTABLE_REASON;
}

/** Positive, row-scoped harness evidence for one `agentId`, sourced from a `state.json` roster
 *  entry — never the daemon's CURRENT global default (Finding 3: that reflects today's config,
 *  not what a historical run actually used). */
export interface PositiveEvidenceEntry {
	harness?: string;
	runtime?: string;
}

export interface ClassifyContext {
	/** `state.json` roster evidence for this exact `agentId`, if any. */
	evidence?: PositiveEvidenceEntry;
}

/** Positive harness evidence from a roster entry — explicit `harness` field wins, else the SAME
 *  legacy `runtime` → harness mapping the daemon itself uses (`runtimeToHarness`). Deliberately
 *  does NOT fall through to `resolveHarnessName`/`globalDefaultHarness`: a record with neither
 *  field is "no evidence", not "today's default". */
export function positiveHarnessFrom(evidence: PositiveEvidenceEntry | undefined): string | undefined {
	if (!evidence) return undefined;
	if (evidence.harness) return evidence.harness;
	if (evidence.runtime) return runtimeToHarness(evidence.runtime);
	return undefined;
}

/** Pure classification: given one parsed (and already schema-guarded) receipt and its context,
 *  decide what — if anything — to backfill. Never mutates `receipt`; the caller applies it. */
export function classifyReceipt(receipt: RunReceipt, ctx: ClassifyContext): ClassifyResult {
	const result: ClassifyResult = {};

	const harnessMissing = receipt.harness === undefined || receipt.harness === null;
	if (harnessMissing) {
		const positive = positiveHarnessFrom(ctx.evidence);
		if (positive) {
			result.harness = positive;
		} else {
			const suspect = INGESTED_AGENT_ID_PREFIXES.some((p) => receipt.agentId.startsWith(p));
			result.harnessUnattributableReason = suspect ? "agent_id_prefix_ambiguous" : "no_state_json_evidence";
		}
	}

	const modelMissing = receipt.model === undefined || receipt.model === null || receipt.model === "";
	if (modelMissing) result.modelUnattributableReason = MODEL_UNATTRIBUTABLE_REASON;

	return result;
}

/** Apply a `ClassifyResult` onto a receipt, returning a NEW object only when a final field VALUE
 *  actually differs from the input — so re-auditing an already-reasoned row (same code
 *  recomputed every pass) is a true no-op: same reference back, nothing to rewrite. Never
 *  mutates the input. */
export function applyClassification(receipt: RunReceipt, result: ClassifyResult): RunReceipt {
	const nextHarness = result.harness ?? receipt.harness;
	const harnessPresent = nextHarness !== undefined && nextHarness !== null && nextHarness !== "";
	const nextHarnessReason = harnessPresent ? undefined : (result.harnessUnattributableReason ?? receipt.harnessUnattributableReason);

	const modelPresent = receipt.model !== undefined && receipt.model !== null && receipt.model !== "";
	const nextModelReason = modelPresent ? undefined : (result.modelUnattributableReason ?? receipt.modelUnattributableReason);

	const harnessChanged = nextHarness !== receipt.harness;
	const harnessReasonChanged = nextHarnessReason !== receipt.harnessUnattributableReason;
	const modelReasonChanged = nextModelReason !== receipt.modelUnattributableReason;
	if (!harnessChanged && !harnessReasonChanged && !modelReasonChanged) return receipt;

	const next: RunReceipt = { ...receipt };
	if (harnessChanged) next.harness = nextHarness;
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

// ── Schema guard (Finding 5) ─────────────────────────────────────────────────────────────────

/** Every top-level key this version of `RunReceipt` (src/receipts.ts) can carry. A row with ANY
 *  key outside this set predates or postdates a shape this script understands. */
const KNOWN_RECEIPT_KEYS = new Set<string>([
	"agentId",
	"name",
	"repo",
	"branch",
	"model",
	"runId",
	"startedAt",
	"endedAt",
	"durationMs",
	"status",
	"toolCalls",
	"toolTally",
	"tokens",
	"costUsd",
	"filesTouched",
	"traceId",
	"spans",
	"sampled",
	"featureId",
	"parentId",
	"harness",
	"harnessUnattributableReason",
	"modelUnattributableReason",
	"validation",
	"confidence",
	"efficiencyFlags",
	"lane",
	"tier",
]);

export interface SchemaGuardFailure {
	reason: "not_an_object" | "unknown_keys" | "invalid_field_type";
	detail: string;
}

/** Structural guard (deliberately NOT Effect `Schema.Struct` — see the module doc's Finding 5
 *  note on silent excess-key stripping). Checks: value is a plain object; every top-level key is
 *  recognized; the handful of fields this script actually reads or writes have the right
 *  primitive type. Returns `undefined` when the row is fully recognized. */
export function guardReceiptShape(value: unknown): SchemaGuardFailure | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { reason: "not_an_object", detail: typeof value };
	}
	const obj = value as Record<string, unknown>;
	const unknown = Object.keys(obj).filter((k) => !KNOWN_RECEIPT_KEYS.has(k));
	if (unknown.length > 0) return { reason: "unknown_keys", detail: unknown.join(",") };
	if (typeof obj.agentId !== "string" || obj.agentId.length === 0) return { reason: "invalid_field_type", detail: "agentId" };
	if (obj.harness !== undefined && typeof obj.harness !== "string") return { reason: "invalid_field_type", detail: "harness" };
	if (obj.model !== undefined && typeof obj.model !== "string") return { reason: "invalid_field_type", detail: "model" };
	if (obj.harnessUnattributableReason !== undefined && typeof obj.harnessUnattributableReason !== "string") return { reason: "invalid_field_type", detail: "harnessUnattributableReason" };
	if (obj.modelUnattributableReason !== undefined && typeof obj.modelUnattributableReason !== "string") return { reason: "invalid_field_type", detail: "modelUnattributableReason" };
	return undefined;
}

// ── state.json positive-evidence roster (Finding 3) ──────────────────────────────────────────

/** Best-effort, read-only load of `state.json`'s persisted-agent roster (file-mode state dirs —
 *  DB-mode installs keep their roster in a database this script doesn't touch, so this yields an
 *  empty map there, which is correct, not an error). A missing file, unparseable JSON, or an
 *  `agents` array whose entries don't loosely match `{id: string, harness?: string, runtime?:
 *  string}` is treated as "no evidence" for those entries — this NEVER throws. Every OTHER field
 *  on a roster entry (there are dozens — see `PersistedAgent` in src/types.ts) is ignored; this
 *  is a read-only lookup, not something this script rewrites, so it doesn't need the closed-set
 *  guard `guardReceiptShape` applies to receipts. */
export async function loadPositiveEvidence(stateDir: string): Promise<Map<string, PositiveEvidenceEntry>> {
	const map = new Map<string, PositiveEvidenceEntry>();
	let raw: unknown;
	try {
		raw = JSON.parse(await fs.readFile(path.join(stateDir, "state.json"), "utf8"));
	} catch {
		return map;
	}
	if (typeof raw !== "object" || raw === null) return map;
	const agents = (raw as Record<string, unknown>).agents;
	if (!Array.isArray(agents)) return map;
	for (const entry of agents) {
		if (typeof entry !== "object" || entry === null) continue;
		const e = entry as Record<string, unknown>;
		if (typeof e.id !== "string" || e.id.length === 0) continue;
		const harness = typeof e.harness === "string" && e.harness.length > 0 ? e.harness : undefined;
		const runtime = typeof e.runtime === "string" && e.runtime.length > 0 ? e.runtime : undefined;
		if (harness || runtime) map.set(e.id, { harness, runtime });
	}
	return map;
}

// ── Per-file planning ─────────────────────────────────────────────────────────────────────────

export interface FileReport {
	file: string;
	lines: number;
	harnessBackfilled: number;
	harnessUnattributable: number;
	modelUnattributable: number;
	parseErrors: number;
	/** True ⇒ the WHOLE file was left byte-identical because at least one row wasn't a recognized
	 *  RunReceipt shape (Finding 5) — nothing in it was touched, including rows that would
	 *  otherwise have been attributable. */
	skippedUnknownSchema: boolean;
	skippedUnknownSchemaDetail: string[];
	/** True ⇒ this file HAD changes to write, but the pre-rename re-stat found the original had
	 *  drifted since it was read (Findings 1+2) — nothing was written; safe to retry later. */
	abortedConcurrentWrite: boolean;
	changed: boolean;
}

/** Process one `<agentId>.jsonl` file's raw text into a report + the (possibly unchanged)
 *  rewritten text. Two passes: (1) parse + schema-guard every row — any failure anywhere in the
 *  file means the file is returned byte-identical; (2) only once every row is recognized,
 *  classify and (maybe) rewrite each one. */
export function planFile(file: string, text: string, positiveEvidence: Map<string, PositiveEvidenceEntry>): { report: FileReport; outLines: string[] } {
	const rawLines = text.split("\n").filter((l) => l.trim().length > 0);
	const report: FileReport = {
		file,
		lines: rawLines.length,
		harnessBackfilled: 0,
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
		const ctx: ClassifyContext = { evidence: positiveEvidence.get(receipt.agentId) };
		const result = classifyReceipt(receipt, ctx);
		if (result.harness) report.harnessBackfilled++;
		if (result.harnessUnattributableReason) report.harnessUnattributable++;
		if (result.modelUnattributableReason) report.modelUnattributable++;
		const next = applyClassification(receipt, result);
		if (next !== receipt) report.changed = true;
		outLines.push(JSON.stringify(next));
	}
	return { report, outLines };
}

// ── Durable, crash-safe write path (Findings 1+2) ────────────────────────────────────────────

async function statOrNull(file: string): Promise<Stats | null> {
	try {
		return await fs.stat(file);
	} catch {
		return null;
	}
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

/** Write `content` for `file` durably: temp file in the SAME directory (so the final rename is
 *  same-filesystem-atomic) → fsync the temp file → re-`stat` `file` immediately before the
 *  rename and abort (unlinking the temp file, touching `file` not at all) if its mtime/size has
 *  drifted from `before` → rename → fsync the containing directory. NEVER opens `file` itself
 *  with a truncating mode — the source is only ever read (by the caller) or atomically replaced
 *  by a completed rename, never opened "w". */
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
}

export interface BackfillReport {
	stateDir: string;
	dryRun: boolean;
	filesScanned: number;
	totalLines: number;
	harnessBackfilled: number;
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

/** Full pass: refuse if a live daemon holds `stateDir` (Findings 1+2), else read every
 *  `receipts/*.jsonl` file plus the `state.json` roster, classify every recognized row, and
 *  (unless `dryRun`) durably rewrite each file that changed via `writeIfUnchanged`. Throws
 *  {@link DaemonLockRefusal} instead of running when the daemon is live — in EITHER mode. */
export async function runBackfill(opts: RunOpts): Promise<BackfillReport> {
	const probe = probeDaemonLock(opts.stateDir);
	if (probe.live && probe.owner) throw new DaemonLockRefusal(probe.owner);

	const dir = receiptsDir(opts.stateDir);
	let names: string[];
	try {
		names = (await fs.readdir(dir)).filter((n) => n.endsWith(".jsonl")).sort();
	} catch {
		names = [];
	}

	const positiveEvidence = await loadPositiveEvidence(opts.stateDir);

	const perFile: FileReport[] = [];
	let filesWritten = 0;
	for (const name of names) {
		const full = path.join(dir, name);
		const opened = await readFileWithStat(full);
		if (!opened) continue; // vanished between readdir and open — nothing to report on
		const { text, stat } = opened;
		const { report, outLines } = planFile(name, text, positiveEvidence);
		perFile.push(report);
		if (!opts.dryRun && report.changed && !report.skippedUnknownSchema) {
			const result = await writeIfUnchanged(full, `${outLines.join("\n")}\n`, stat);
			if (result.written) filesWritten++;
			else {
				report.abortedConcurrentWrite = true;
				report.changed = false;
			}
		}
	}

	const totals = perFile.reduce(
		(acc, r) => {
			acc.totalLines += r.lines;
			acc.harnessBackfilled += r.harnessBackfilled;
			acc.harnessUnattributable += r.harnessUnattributable;
			acc.modelUnattributable += r.modelUnattributable;
			acc.parseErrors += r.parseErrors;
			if (r.skippedUnknownSchema) acc.filesSkippedUnknownSchema++;
			if (r.abortedConcurrentWrite) acc.filesAbortedConcurrentWrite++;
			return acc;
		},
		{ totalLines: 0, harnessBackfilled: 0, harnessUnattributable: 0, modelUnattributable: 0, parseErrors: 0, filesSkippedUnknownSchema: 0, filesAbortedConcurrentWrite: 0 },
	);

	return {
		stateDir: opts.stateDir,
		dryRun: opts.dryRun,
		filesScanned: names.length,
		...totals,
		filesWritten,
		perFile,
	};
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────

const HELP_TEXT = `bun scripts/backfill-receipt-attribution.ts --state-dir <dir> [--dry-run]

Repairs HISTORICAL RunReceipt rows (missing harness/model, predating the write-time fix at
f3294d58) already on disk. Never touches the write path. Never guesses:

  --state-dir <dir>   the glance state dir to operate on (e.g. ~/.glance). Required.
  --dry-run           report attributable/unattributable counts; write nothing.
  --help, -h          this text.

Exit codes: 0 = ran (see printed counts for what it did/skipped); 2 = REFUSED to run because a
live daemon holds --state-dir's single-writer lock (state-lock.ts's daemon.lock check — see
DaemonLockRefusal).

Attribution rules (see the module doc at the top of this file for the full gauntlet-round-1
rationale):
  - harness: attributed ONLY from a state.json roster entry (same agentId) carrying an explicit
    harness field or a legacy runtime field mapped via harness-registry.ts's runtimeToHarness.
    NEVER from absence alone, and NEVER from today's global default. Everything else gets a
    durable harnessUnattributableReason code on the row.
  - model: NEVER attributed. Every missing-model row gets the fixed
    modelUnattributableReason "no_run_scoped_model_evidence" — no cross-referencing, no
    heuristics. No durable, run-scoped source exists in this codebase to attribute it from.
  - Any row with an unrecognized shape (unknown key, wrong-typed known field, or unparseable
    JSON) leaves its WHOLE FILE byte-identical, reported as skipped.

Residual race (not eliminated, only narrowed): the daemon-lock refusal only proves no daemon was
live at the moment of the check. Between that check and any individual file's write, a daemon
(or any other process) could still start appending. The per-file re-stat taken immediately
before each atomic rename catches drift since the file was first read and drops that file's
write rather than risk losing a concurrent append — but no OS-level file lock (flock) is taken,
so the window between the re-stat and the rename itself is not literally zero. A file dropped
for drift is safe to re-run once the concurrent writer settles; this pass is idempotent.
`;

function parseArgs(argv: string[]): RunOpts | "help" {
	if (argv.includes("--help") || argv.includes("-h")) return "help";
	let stateDir: string | undefined;
	let dryRun = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--state-dir") stateDir = argv[++i];
		else if (a === "--dry-run") dryRun = true;
	}
	if (!stateDir) throw new Error("usage: bun scripts/backfill-receipt-attribution.ts --state-dir <dir> [--dry-run]  (--help for details)");
	return { stateDir, dryRun };
}

export function printReport(report: BackfillReport): void {
	const mode = report.dryRun ? "DRY RUN — nothing on disk was changed" : "LIVE — files with changes were rewritten in place";
	console.log(`Receipt attribution backfill (${mode})`);
	console.log(`  state dir:        ${report.stateDir}`);
	console.log(`  files scanned:    ${report.filesScanned}`);
	console.log(`  total rows:       ${report.totalLines}`);
	console.log(`  parse errors:     ${report.parseErrors} (counted toward "files skipped: unrecognized shape" below)`);
	console.log(`  files skipped (unrecognized row shape, left byte-identical): ${report.filesSkippedUnknownSchema}`);
	if (!report.dryRun) console.log(`  files aborted (concurrent write detected before rename):     ${report.filesAbortedConcurrentWrite}`);
	console.log("");
	console.log(`  harness backfilled (positive state.json evidence): ${report.harnessBackfilled}`);
	console.log(`  harness unattributable (reason stamped):            ${report.harnessUnattributable}`);
	console.log("");
	console.log(`  model unattributable (reason stamped; model is never attributed by this script): ${report.modelUnattributable}`);
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
		throw err;
	}
}
