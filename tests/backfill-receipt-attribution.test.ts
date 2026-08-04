/**
 * scripts/backfill-receipt-attribution.ts — the historical-repair pass for glance#331's
 * missing harness/model on omp-lane receipts. The write-time gap this ticket describes was
 * already fixed at f3294d58 (tests/receipt-attribution.test.ts covers that write path); this
 * script only repairs rows already on disk from before that fix, and must NEVER guess:
 *   - `harness` is attributable whenever missing — every external ingester stamps its own
 *     harness unconditionally (src/ingest/*.ts), so absence can only mean the omp lane.
 *   - `model` is attributable ONLY via an exact `agentId` match in `task-outcomes.jsonl`, and
 *     only when that agentId's receipt file has exactly one line (no restart ambiguity).
 *     Everything else stays unstamped with `modelUnattributableReason` explaining why.
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyClassification, classifyReceipt, planFile, printReport, runBackfill } from "../scripts/backfill-receipt-attribution.ts";
import { readReceipts, receiptPath } from "../src/receipts.ts";
import { recordTaskOutcome } from "../src/task-outcomes.ts";
import type { RunReceipt } from "../src/types.ts";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function tmpStateDir(): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), "backfill-state-"));
	tmps.push(d);
	await fs.mkdir(path.join(d, "receipts"), { recursive: true });
	return d;
}

function baseReceipt(overrides: Partial<RunReceipt> = {}): RunReceipt {
	return {
		agentId: "ag1",
		name: "alpha",
		repo: "/repo",
		runId: "r1",
		startedAt: 1000,
		status: "idle",
		toolCalls: 0,
		toolTally: {},
		filesTouched: [],
		...overrides,
	};
}

async function writeRawLines(stateDir: string, agentId: string, lines: unknown[]): Promise<void> {
	const text = `${lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`;
	await fs.writeFile(receiptPath(stateDir, agentId), text);
}

// ── classifyReceipt (pure) ────────────────────────────────────────────────────────────────────

test("classifyReceipt: missing harness on a plain agentId is attributable to omp", () => {
	const r = baseReceipt({ harness: undefined });
	const result = classifyReceipt(r, { multiRunAgent: false });
	expect(result.harness).toBe("omp");
	expect(result.harnessAnomaly).toBeUndefined();
});

test("classifyReceipt: present harness is left alone", () => {
	const r = baseReceipt({ harness: "pi" });
	const result = classifyReceipt(r, { multiRunAgent: false });
	expect(result.harness).toBeUndefined();
});

test("classifyReceipt: missing harness on an ingested-lane agentId prefix is an ANOMALY, never blind-stamped", () => {
	for (const agentId of ["cc-abc12345", "codex-abc12345", "or-2026-08-04-opus"]) {
		const r = baseReceipt({ agentId, harness: undefined });
		const result = classifyReceipt(r, { multiRunAgent: false });
		expect(result.harness).toBeUndefined();
		expect(result.harnessAnomaly).toBe(true);
	}
});

test("classifyReceipt: missing model with a single-run task-outcome match is attributed", () => {
	const r = baseReceipt({ model: undefined });
	const result = classifyReceipt(r, { multiRunAgent: false, taskOutcomeModel: "anthropic/claude-opus-4-8" });
	expect(result.model).toBe("anthropic/claude-opus-4-8");
	expect(result.modelUnattributableReason).toBeUndefined();
});

test("classifyReceipt: missing model with no task-outcome match is unattributable with a reason", () => {
	const r = baseReceipt({ model: undefined });
	const result = classifyReceipt(r, { multiRunAgent: false });
	expect(result.model).toBeUndefined();
	expect(result.modelUnattributableReason).toMatch(/no model was ever observed/);
});

test("classifyReceipt: missing model on a multi-run agent is unattributable EVEN with a task-outcome match — never a cross-run guess", () => {
	const r = baseReceipt({ model: undefined });
	const result = classifyReceipt(r, { multiRunAgent: true, taskOutcomeModel: "anthropic/claude-opus-4-8" });
	expect(result.model).toBeUndefined();
	expect(result.modelUnattributableReason).toMatch(/multiple receipt lines/);
});

test("classifyReceipt: present model is left alone regardless of task-outcome data", () => {
	const r = baseReceipt({ model: "opus" });
	const result = classifyReceipt(r, { multiRunAgent: false, taskOutcomeModel: "sonnet" });
	expect(result.model).toBeUndefined();
	expect(result.modelUnattributableReason).toBeUndefined();
});

// ── applyClassification (pure) ───────────────────────────────────────────────────────────────

test("applyClassification: stamps harness and model, never mutates the input", () => {
	const r = baseReceipt({ harness: undefined, model: undefined });
	const next = applyClassification(r, { harness: "omp", model: "opus" });
	expect(next.harness).toBe("omp");
	expect(next.model).toBe("opus");
	expect(next.modelUnattributableReason).toBeUndefined();
	expect(r.harness).toBeUndefined(); // original untouched
});

test("applyClassification: stamps the unattributable reason without touching model", () => {
	const r = baseReceipt({ model: undefined });
	const next = applyClassification(r, { modelUnattributableReason: "no model was ever observed" });
	expect(next.model).toBeUndefined();
	expect(next.modelUnattributableReason).toBe("no model was ever observed");
});

test("applyClassification: a no-op classification returns the SAME reference (no spurious rewrite)", () => {
	const r = baseReceipt({ harness: "pi", model: "opus" });
	const next = applyClassification(r, {});
	expect(next).toBe(r);
});

// ── planFile (per-file, pure over text) ──────────────────────────────────────────────────────

test("planFile: preserves line order and count, backfills harness on every missing row", () => {
	const rows = [baseReceipt({ agentId: "a1", runId: "r1", harness: undefined, model: "opus" }), baseReceipt({ agentId: "a1", runId: "r2", harness: "codex", model: "gpt" })];
	const text = rows.map((r) => JSON.stringify(r)).join("\n");
	const { report, outLines } = planFile("a1.jsonl", text, new Map());
	expect(report.lines).toBe(2);
	expect(report.harnessBackfilled).toBe(1);
	expect(report.changed).toBe(true);
	expect(outLines.length).toBe(2);
	expect(JSON.parse(outLines[0]).harness).toBe("omp");
	expect(JSON.parse(outLines[1]).harness).toBe("codex"); // untouched
});

test("planFile: torn/corrupt lines pass through byte-for-byte and count as parse errors", () => {
	const good = JSON.stringify(baseReceipt({ harness: undefined }));
	const text = `${good}\n{not valid json`;
	const { report, outLines } = planFile("torn.jsonl", text, new Map());
	expect(report.parseErrors).toBe(1);
	expect(report.lines).toBe(2);
	expect(outLines[1]).toBe("{not valid json");
});

test("planFile: a file with no attributable/unattributable changes reports changed=false", () => {
	const text = JSON.stringify(baseReceipt({ harness: "pi", model: "opus" }));
	const { report } = planFile("clean.jsonl", text, new Map());
	expect(report.changed).toBe(false);
	expect(report.harnessBackfilled).toBe(0);
	expect(report.modelAttributed).toBe(0);
	expect(report.modelUnattributable).toBe(0);
});

// ── runBackfill (end-to-end over a fixture state dir) ────────────────────────────────────────

test("runBackfill --dry-run: reports counts and writes NOTHING to disk", async () => {
	const stateDir = await tmpStateDir();
	await writeRawLines(stateDir, "legacy1", [baseReceipt({ agentId: "legacy1", harness: undefined, model: undefined })]);
	await writeRawLines(stateDir, "cc-abcd1234", [baseReceipt({ agentId: "cc-abcd1234", harness: undefined, model: "claude-sonnet" })]);

	const beforeLegacy = await fs.readFile(receiptPath(stateDir, "legacy1"), "utf8");
	const beforeCc = await fs.readFile(receiptPath(stateDir, "cc-abcd1234"), "utf8");

	const report = await runBackfill({ stateDir, dryRun: true });

	expect(report.filesScanned).toBe(2);
	expect(report.totalLines).toBe(2);
	expect(report.harnessBackfilled).toBe(1); // legacy1 only — cc-abcd1234 is the anomaly guard
	expect(report.harnessAnomalies).toEqual(["cc-abcd1234"]);
	expect(report.modelUnattributable).toBe(1); // legacy1's model, no task-outcome match
	expect(report.filesWritten).toBe(0);

	// Untouched on disk.
	expect(await fs.readFile(receiptPath(stateDir, "legacy1"), "utf8")).toBe(beforeLegacy);
	expect(await fs.readFile(receiptPath(stateDir, "cc-abcd1234"), "utf8")).toBe(beforeCc);

	// printReport should not throw over either shape (dry-run and live) — smoke coverage for the
	// CLI's console output path.
	printReport(report);
});

test("runBackfill live: rewrites only changed files, cross-references task-outcomes for a single-run agent, and is idempotent", async () => {
	const stateDir = await tmpStateDir();
	// legacy2: single run, missing harness AND model, WITH a matching task-outcome row.
	await writeRawLines(stateDir, "legacy2", [baseReceipt({ agentId: "legacy2", harness: undefined, model: undefined })]);
	await recordTaskOutcome(stateDir, { agentId: "legacy2", routing: { mode: "auto", tier: "medium" }, model: "anthropic/claude-opus-4-8", outcome: "landed", source: "land", ts: Date.now() });

	// restarted: two receipt lines for the same agentId, missing model on both — even though a
	// task-outcome row exists, it must NOT be cross-referenced (ambiguous which run it describes).
	await writeRawLines(stateDir, "restarted", [baseReceipt({ agentId: "restarted", runId: "r1", harness: "omp", model: undefined }), baseReceipt({ agentId: "restarted", runId: "r2", harness: "omp", model: undefined })]);
	await recordTaskOutcome(stateDir, { agentId: "restarted", routing: { mode: "auto", tier: "medium" }, model: "sonnet", outcome: "landed", source: "land", ts: Date.now() });

	// clean: already fully attributed — must be left byte-identical (no spurious rewrite).
	await writeRawLines(stateDir, "clean", [baseReceipt({ agentId: "clean", harness: "pi", model: "opus" })]);
	const cleanBefore = await fs.readFile(receiptPath(stateDir, "clean"), "utf8");

	const report = await runBackfill({ stateDir, dryRun: false });

	expect(report.harnessBackfilled).toBe(1); // legacy2
	expect(report.modelAttributed).toBe(1); // legacy2, via task-outcomes
	expect(report.modelUnattributable).toBe(2); // restarted's two lines
	expect(report.filesWritten).toBe(2); // legacy2 + restarted; NOT clean

	const legacy2 = await readReceipts(stateDir, "legacy2");
	expect(legacy2[0].harness).toBe("omp");
	expect(legacy2[0].model).toBe("anthropic/claude-opus-4-8");
	expect(legacy2[0].modelUnattributableReason).toBeUndefined();

	const restarted = await readReceipts(stateDir, "restarted");
	for (const r of restarted) {
		expect(r.model).toBeUndefined();
		expect(r.modelUnattributableReason).toMatch(/multiple receipt lines/);
	}

	expect(await fs.readFile(receiptPath(stateDir, "clean"), "utf8")).toBe(cleanBefore);

	// Idempotent: a second pass over the now-rewritten files finds nothing left to do.
	const second = await runBackfill({ stateDir, dryRun: false });
	expect(second.harnessBackfilled).toBe(0);
	expect(second.modelAttributed).toBe(0);
	expect(second.filesWritten).toBe(0);
	// The still-unattributable rows keep reporting (re-audited, same reason) but don't rewrite —
	// planFile only marks `changed` when the applied object differs from the input, and re-applying
	// the SAME reason string to a row that already carries it is a no-op.
	expect(second.modelUnattributable).toBe(2);
});

test("runBackfill: an empty/missing receipts dir reports zero scanned, never throws", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "backfill-empty-"));
	tmps.push(stateDir);
	const report = await runBackfill({ stateDir, dryRun: true });
	expect(report.filesScanned).toBe(0);
	expect(report.totalLines).toBe(0);
});
