#!/usr/bin/env bun
/**
 * Backfill `RunReceipt.harness`/`.model` on HISTORICAL receipts (glance#331).
 *
 * The write-time gap this once described is already fixed on main (f3294d58,
 * "fix(receipts): stamp harness + backfilled model onto receipts at write time", landed
 * 2026-07-07, tests/receipt-attribution.test.ts): `RunAccumulator.snapshot()` has stamped
 * `harness: rec.harness?.name ?? actualUnitHarness(rec.options)` unconditionally since
 * commit 390bf610 (2026-07-02), and `finalizeRun` re-syncs `seed.model` from
 * `applyState`'s poll-backfilled `rec.dto.model` before every snapshot. A live audit of
 * ~/.glance/receipts (2026-08-04, 734 rows) found ZERO rows missing `harness` written
 * after 2026-07-03 — every one of the 430 missing-harness rows predates the fix. `model`
 * is similar but not identical: 385 of the 447 missing-model rows are the SAME pre-fix
 * legacy rows, and the remaining ~62 are post-fix rows from units that crashed within a
 * few seconds of `agent_start` (status "working", zero tool calls, zero tokens) — no
 * assistant usage frame or `applyState` poll ever arrived, so there was never a model
 * signal to capture. That is not a write-time bug; it is an honestly unknown model.
 *
 * This script exists to repair the HISTORICAL rows already on disk — it does not touch
 * the write path (already fixed) and it never invents a value:
 *
 *   - `harness`: every external ingester (src/ingest/claude-code.ts, codex.ts,
 *     openrouter.ts) stamps its own harness as an unconditional literal on every receipt
 *     it ever writes — "claude-code" / "codex" / "openrouter" respectively, never
 *     omitted. A receipt with `harness` absent can therefore ONLY have come from the
 *     omp-lane writer (receipts.ts's `RunAccumulator`), which left the field unset
 *     entirely before the field existed. Backfilling `harness: "omp"` on every such row
 *     is not a guess — it is the one harness that specific writer could ever have
 *     produced. `classifyReceipt` still cross-checks the ingested-lane agentId prefixes
 *     ("cc-", "codex-", "or-") as a belt-and-suspenders guard: if one of THOSE ever
 *     turned up with no harness (meaning the invariant above broke somewhere), the row is
 *     flagged unattributable instead of silently mislabeled.
 *   - `model`: only cross-referenced from `task-outcomes.jsonl` (src/task-outcomes.ts),
 *     an INDEPENDENT durable record keyed by the same `agentId`, written by `land()` /
 *     the PR reconciler / a sweep — never derived from the receipt itself, never priced,
 *     never averaged. Applied only when (a) a matching row exists, (b) it carries a
 *     model, and (c) the receipt's own `<agentId>.jsonl` file holds exactly one line —
 *     a restarted unit can change harness/model across runs, so a multi-run file's
 *     task-outcome (which is itself last-terminal-wins, one row total) cannot be pinned
 *     to any ONE of its several receipts without risking a cross-run guess. Every other
 *     missing-model row is left alone and gets `modelUnattributableReason` instead,
 *     so a future reader can tell "audited, genuinely unknown" apart from "never
 *     looked at" without re-running this script.
 *
 * Usage:
 *   bun scripts/backfill-receipt-attribution.ts --state-dir <dir> [--dry-run]
 *
 * --dry-run reports attributable/unattributable counts and touches NOTHING on disk.
 * Without it, every file with at least one attributable/newly-classified row is
 * rewritten in place (one JSON object per line, same line order, fsync'd) — this is the
 * OPERATOR's call against a live state dir; nothing in the repo invokes this
 * automatically and it is never run here against ~/.glance.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RunReceipt } from "../src/receipts.ts";
import { readTaskOutcomes } from "../src/task-outcomes.ts";

/** Prefixes an external ingester's own `agentId` always carries (src/ingest/claude-code.ts's
 *  `cc-${short}`, codex.ts's `codex-${short}`, openrouter.ts's `or-${date}-${slug}`) — a
 *  belt-and-suspenders check that the "missing harness ⇒ omp lane" invariant hasn't quietly
 *  broken for one of those writers. */
const INGESTED_AGENT_ID_PREFIXES = ["cc-", "codex-", "or-"];

export interface ClassifyResult {
	/** Value to stamp on `harness` when it was missing and is attributable — always "omp" in
	 *  practice (see module doc); absent when `harness` was already present, or (defensively)
	 *  when the agentId prefix contradicts the omp-lane invariant. */
	harness?: "omp";
	/** Value to stamp on `model` when it was missing and cross-referenced with certainty from
	 *  task-outcomes.jsonl. */
	model?: string;
	/** Reason to stamp on `modelUnattributableReason` when `model` was missing and could NOT be
	 *  attributed. Absent when model was already present or was just attributed above. */
	modelUnattributableReason?: string;
	/** True when the agentId prefix contradicts the "missing harness ⇒ omp" invariant — the row
	 *  is left untouched on `harness` and this is surfaced as an anomaly, never silently stamped. */
	harnessAnomaly?: boolean;
}

export interface ClassifyContext {
	/** `task-outcomes.jsonl`'s model for this exact `agentId`, if any (readTaskOutcomes() already
	 *  collapses to last-terminal-wins per agentId). */
	taskOutcomeModel?: string;
	/** True when this receipt's own `<agentId>.jsonl` file holds MORE than one line — a restarted
	 *  unit, whose single task-outcome row (if any) can't be pinned to one specific run. */
	multiRunAgent: boolean;
}

/** Pure classification: given one parsed receipt and its context, decide what (if anything) to
 *  backfill. Never mutates `receipt` — the caller applies the result. */
export function classifyReceipt(receipt: RunReceipt, ctx: ClassifyContext): ClassifyResult {
	const result: ClassifyResult = {};

	const harnessMissing = receipt.harness === undefined || receipt.harness === null;
	if (harnessMissing) {
		const suspect = INGESTED_AGENT_ID_PREFIXES.some((p) => receipt.agentId.startsWith(p));
		if (suspect) result.harnessAnomaly = true;
		else result.harness = "omp";
	}

	const modelMissing = receipt.model === undefined || receipt.model === null || receipt.model === "";
	if (modelMissing) {
		if (ctx.multiRunAgent) {
			result.modelUnattributableReason =
				"unit has multiple receipt lines (restarted run) — a single task-outcomes.jsonl row can't be pinned to one specific run without risking a cross-run guess";
		} else if (ctx.taskOutcomeModel) {
			result.model = ctx.taskOutcomeModel;
		} else {
			result.modelUnattributableReason =
				"no model was ever observed at write time (no explicit spawn model, no assistant usage frame, no applyState poll backfill) and no independent task-outcomes.jsonl record exists for this agentId";
		}
	}

	return result;
}

/** Apply a `ClassifyResult` onto a receipt, returning a NEW object only when something actually
 *  changes — compares final field VALUES against the input, not just whether `classifyReceipt`
 *  produced a non-empty result, so re-running the script over an already-audited row (same
 *  unattributable reason recomputed every pass) is a true no-op: same reference back, nothing to
 *  rewrite. Never mutates the input. */
export function applyClassification(receipt: RunReceipt, result: ClassifyResult): RunReceipt {
	const nextHarness = result.harness ?? receipt.harness;
	const nextModel = result.model ?? receipt.model;
	const modelPresent = nextModel !== undefined && nextModel !== null && nextModel !== "";
	// A stamped model always wins over any reason, whether the model arrived just now or was
	// already there — an unattributable reason must never linger next to a real value.
	const nextReason = modelPresent ? undefined : (result.modelUnattributableReason ?? receipt.modelUnattributableReason);

	const harnessChanged = nextHarness !== receipt.harness;
	const modelChanged = nextModel !== receipt.model;
	const reasonChanged = nextReason !== receipt.modelUnattributableReason;
	if (!harnessChanged && !modelChanged && !reasonChanged) return receipt;

	const next: RunReceipt = { ...receipt };
	if (harnessChanged) next.harness = nextHarness;
	if (modelChanged) next.model = nextModel;
	if (reasonChanged) {
		if (nextReason === undefined) delete next.modelUnattributableReason;
		else next.modelUnattributableReason = nextReason;
	}
	return next;
}

export interface FileReport {
	file: string;
	lines: number;
	harnessBackfilled: number;
	harnessAnomalies: string[]; // agentIds
	modelAttributed: number;
	modelUnattributable: number;
	parseErrors: number;
	changed: boolean;
}

export interface BackfillReport {
	stateDir: string;
	dryRun: boolean;
	filesScanned: number;
	totalLines: number;
	harnessBackfilled: number;
	harnessAnomalies: string[];
	modelAttributed: number;
	modelUnattributable: number;
	parseErrors: number;
	filesWritten: number;
	perFile: FileReport[];
}

function receiptsDir(stateDir: string): string {
	return path.join(stateDir, "receipts");
}

/** Process one `<agentId>.jsonl` file's raw text into a report + (if not dry-run) the rewritten
 *  text. Preserves line order; unparseable lines are left byte-for-byte untouched (mirrors
 *  receipts.ts's own per-line-tolerant read path — this script never discards a torn line). */
export function planFile(file: string, text: string, taskOutcomes: Map<string, string>): { report: FileReport; outLines: string[] } {
	const rawLines = text.split("\n").filter((l) => l.trim().length > 0);
	const parsed: (RunReceipt | undefined)[] = rawLines.map((line) => {
		try {
			return JSON.parse(line) as RunReceipt;
		} catch {
			return undefined;
		}
	});
	const multiRunAgent = rawLines.length > 1;
	const report: FileReport = {
		file,
		lines: rawLines.length,
		harnessBackfilled: 0,
		harnessAnomalies: [],
		modelAttributed: 0,
		modelUnattributable: 0,
		parseErrors: 0,
		changed: false,
	};
	const outLines: string[] = [];
	for (let i = 0; i < rawLines.length; i++) {
		const receipt = parsed[i];
		if (!receipt) {
			report.parseErrors++;
			outLines.push(rawLines[i]); // torn/corrupt line — pass through untouched
			continue;
		}
		const ctx: ClassifyContext = { taskOutcomeModel: taskOutcomes.get(receipt.agentId), multiRunAgent };
		const result = classifyReceipt(receipt, ctx);
		if (result.harness) report.harnessBackfilled++;
		if (result.harnessAnomaly) report.harnessAnomalies.push(receipt.agentId);
		if (result.model) report.modelAttributed++;
		if (result.modelUnattributableReason) report.modelUnattributable++;
		const next = applyClassification(receipt, result);
		if (next !== receipt) report.changed = true;
		outLines.push(JSON.stringify(next));
	}
	return { report, outLines };
}

export interface RunOpts {
	stateDir: string;
	dryRun: boolean;
}

/** Full pass: read every `receipts/*.jsonl` file plus `task-outcomes.jsonl`, classify every line,
 *  and (unless `dryRun`) rewrite each file that changed. Never writes when `dryRun` is true. */
export async function runBackfill(opts: RunOpts): Promise<BackfillReport> {
	const dir = receiptsDir(opts.stateDir);
	let names: string[];
	try {
		names = (await fs.readdir(dir)).filter((n) => n.endsWith(".jsonl")).sort();
	} catch {
		names = [];
	}

	const outcomes = await readTaskOutcomes(opts.stateDir);
	const taskOutcomes = new Map<string, string>();
	for (const row of outcomes) if (row.model) taskOutcomes.set(row.agentId, row.model);

	const perFile: FileReport[] = [];
	let filesWritten = 0;
	for (const name of names) {
		const full = path.join(dir, name);
		const text = await fs.readFile(full, "utf8");
		const { report, outLines } = planFile(name, text, taskOutcomes);
		perFile.push(report);
		if (!opts.dryRun && report.changed) {
			// Durable rewrite (mirrors receipts.ts's appendReceipt / task-outcomes.ts's recordTaskOutcome):
			// fsync before moving to the next file so a mid-batch crash leaves already-processed files
			// genuinely committed rather than sitting in a page-cache limbo the next run would re-derive
			// identically anyway (this pass is idempotent) but shouldn't have to.
			const fh = await fs.open(full, "w");
			try {
				await fh.writeFile(`${outLines.join("\n")}\n`);
				await fh.sync();
			} finally {
				await fh.close();
			}
			filesWritten++;
		}
	}

	const totals = perFile.reduce(
		(acc, r) => {
			acc.totalLines += r.lines;
			acc.harnessBackfilled += r.harnessBackfilled;
			acc.harnessAnomalies.push(...r.harnessAnomalies);
			acc.modelAttributed += r.modelAttributed;
			acc.modelUnattributable += r.modelUnattributable;
			acc.parseErrors += r.parseErrors;
			return acc;
		},
		{ totalLines: 0, harnessBackfilled: 0, harnessAnomalies: [] as string[], modelAttributed: 0, modelUnattributable: 0, parseErrors: 0 },
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

function parseArgs(argv: string[]): RunOpts {
	let stateDir: string | undefined;
	let dryRun = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--state-dir") stateDir = argv[++i];
		else if (a === "--dry-run") dryRun = true;
	}
	if (!stateDir) throw new Error("usage: bun scripts/backfill-receipt-attribution.ts --state-dir <dir> [--dry-run]");
	return { stateDir, dryRun };
}

export function printReport(report: BackfillReport): void {
	const mode = report.dryRun ? "DRY RUN — nothing on disk was changed" : "LIVE — files with changes were rewritten in place";
	console.log(`Receipt attribution backfill (${mode})`);
	console.log(`  state dir:        ${report.stateDir}`);
	console.log(`  files scanned:    ${report.filesScanned}`);
	console.log(`  total rows:       ${report.totalLines}`);
	console.log(`  parse errors:     ${report.parseErrors} (torn/corrupt lines — left untouched)`);
	console.log("");
	console.log(`  harness backfilled (attributable, stamped "omp"): ${report.harnessBackfilled}`);
	if (report.harnessAnomalies.length > 0) {
		console.log(`  harness ANOMALIES (ingested-lane agentId with no harness — NOT stamped, needs manual review): ${report.harnessAnomalies.length}`);
		for (const id of report.harnessAnomalies) console.log(`    ${id}`);
	}
	console.log("");
	console.log(`  model attributed (cross-referenced from task-outcomes.jsonl): ${report.modelAttributed}`);
	console.log(`  model unattributable (left absent, reason stamped):           ${report.modelUnattributable}`);
	if (!report.dryRun) console.log(`\n  files rewritten: ${report.filesWritten}`);
}

if (import.meta.main) {
	const opts = parseArgs(process.argv.slice(2));
	const report = await runBackfill(opts);
	printReport(report);
}
