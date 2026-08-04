/**
 * scripts/backfill-receipt-attribution.ts — the historical-repair pass for glance#331's missing
 * harness/model on receipts. Two gauntlet rounds (PR #342 blind cross-lineage review, both block
 * verdicts, both fully adjudicated) converged the script to its final shape: an ANNOTATOR, not an
 * attributor. It never writes a `harness` or `model` VALUE — only a durable, machine-readable
 * reason explaining why one can't be determined. This file covers that final shape:
 *   - harness/model are NEVER attributed. Every missing-harness row gets
 *     `harnessUnattributableReason` (`no_run_scoped_harness_evidence` /
 *     `agent_id_prefix_ambiguous`); every missing-model row gets `modelUnattributableReason`
 *     (`no_run_scoped_model_evidence`). No roster join, no task-outcomes cross-reference — round
 *     2 removed the roster join entirely (agent-scoped evidence, not run-scoped — deterministic
 *     agent ids are a legitimate resurrection target and can get reused under a different
 *     harness).
 *   - `""` is treated identically to `undefined`/`null` for BOTH fields everywhere presence is
 *     checked (round 2 finding 4).
 *   - `guardReceiptShape` validates every required field's presence+type and every present
 *     optional field's type — not just a subset (round 2 finding 3); an unrecognized row leaves
 *     its WHOLE FILE untouched, byte-identical.
 *   - the write path never opens the source with "w", preserves the source file's permission
 *     bits on the replacement (round 2 finding 5), and re-stats the original immediately before
 *     rename, aborting on drift (round 1) — WITHOUT ever double-counting an aborted file's rows
 *     as done (round 2 finding 1).
 *   - the whole script ACQUIRES AND HOLDS the real state-dir lock for its entire pass (round 2
 *     finding 1) — not just a read-only probe — released in a `finally`.
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyClassification,
	classifyReceipt,
	DaemonLockRefusal,
	guardReceiptShape,
	markAborted,
	MODEL_UNATTRIBUTABLE_REASON,
	planFile,
	printReport,
	runBackfill,
	writeIfUnchanged,
} from "../scripts/backfill-receipt-attribution.ts";
import { readReceipts, receiptPath } from "../src/receipts.ts";
import type { RunReceipt } from "../src/types.ts";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

const spawned: import("bun").Subprocess[] = [];
afterEach(() => {
	for (const p of spawned.splice(0)) {
		try {
			p.kill();
		} catch {
			/* already gone */
		}
	}
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

async function exists(file: string): Promise<boolean> {
	return fs.stat(file).then(
		() => true,
		() => false,
	);
}

/** Writes a daemon.lock recording a genuinely LIVE, different-from-this-test-process pid (a real
 *  spawned child) — `ownerAlive` special-cases `rec.pid === process.pid` as "our own stale
 *  record", so the probe/acquire needs an actually distinct alive process to prove the "live"
 *  path. */
async function writeLiveDaemonLock(stateDir: string): Promise<void> {
	const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
	spawned.push(child);
	await fs.writeFile(path.join(stateDir, "daemon.lock"), JSON.stringify({ pid: child.pid, host: os.hostname(), startedAt: Date.now() }));
}

/** Writes a daemon.lock recording a pid that (almost certainly) does not exist — the stale-lock
 *  path must NOT treat as live, and acquireStateLock must reclaim it. */
async function writeStaleDaemonLock(stateDir: string): Promise<void> {
	await fs.writeFile(path.join(stateDir, "daemon.lock"), JSON.stringify({ pid: 999_999_999, host: os.hostname(), startedAt: Date.now() }));
}

// ── classifyReceipt / applyClassification (pure — final "annotator, not attributor" shape) ──────

test("classifyReceipt: NEVER attributes a harness or model value — only reason codes exist on the result", () => {
	const r = baseReceipt({ harness: undefined, model: undefined });
	const result = classifyReceipt(r);
	expect((result as Record<string, unknown>).harness).toBeUndefined();
	expect((result as Record<string, unknown>).model).toBeUndefined();
	expect(result.harnessUnattributableReason).toBe("no_run_scoped_harness_evidence");
	expect(result.modelUnattributableReason).toBe(MODEL_UNATTRIBUTABLE_REASON);
});

test("classifyReceipt: an ingested-lane agentId prefix gets the more specific ambiguous code", () => {
	for (const agentId of ["cc-abc12345", "codex-abc12345", "or-2026-08-04-opus"]) {
		const result = classifyReceipt(baseReceipt({ agentId, harness: undefined }));
		expect(result.harnessUnattributableReason).toBe("agent_id_prefix_ambiguous");
	}
});

test("classifyReceipt: present harness/model (non-empty string) get no reason at all", () => {
	const result = classifyReceipt(baseReceipt({ harness: "pi", model: "opus" }));
	expect(result.harnessUnattributableReason).toBeUndefined();
	expect(result.modelUnattributableReason).toBeUndefined();
});

test("classifyReceipt: an EMPTY STRING harness/model is treated as absent, same as undefined/null (Finding 4, round 2)", () => {
	const result = classifyReceipt(baseReceipt({ harness: "", model: "" }));
	expect(result.harnessUnattributableReason).toBe("no_run_scoped_harness_evidence");
	expect(result.modelUnattributableReason).toBe(MODEL_UNATTRIBUTABLE_REASON);

	const resultNull = classifyReceipt(baseReceipt({ harness: null as unknown as undefined, model: null as unknown as undefined }));
	expect(resultNull.harnessUnattributableReason).toBe("no_run_scoped_harness_evidence");
	expect(resultNull.modelUnattributableReason).toBe(MODEL_UNATTRIBUTABLE_REASON);
});

test("applyClassification: stamps unattributable reasons for both fields independently, never touches harness/model themselves", () => {
	const r = baseReceipt({ harness: undefined, model: undefined });
	const next = applyClassification(r, { harnessUnattributableReason: "no_run_scoped_harness_evidence", modelUnattributableReason: MODEL_UNATTRIBUTABLE_REASON });
	expect(next.harness).toBeUndefined();
	expect(next.model).toBeUndefined();
	expect(next.harnessUnattributableReason).toBe("no_run_scoped_harness_evidence");
	expect(next.modelUnattributableReason).toBe(MODEL_UNATTRIBUTABLE_REASON);
	expect(r.harnessUnattributableReason).toBeUndefined(); // original untouched
});

test("applyClassification: an empty-string harness also gets its reason stamped (Finding 4, round 2)", () => {
	const r = baseReceipt({ harness: "" });
	const next = applyClassification(r, { harnessUnattributableReason: "no_run_scoped_harness_evidence" });
	expect(next.harness).toBe(""); // value itself is never touched — only the reason sibling
	expect(next.harnessUnattributableReason).toBe("no_run_scoped_harness_evidence");
});

test("applyClassification: a no-op classification returns the SAME reference (no spurious rewrite) — idempotency at the unit level", () => {
	const r = baseReceipt({ harness: "pi", model: "opus" });
	expect(applyClassification(r, {})).toBe(r);

	const unattributed = baseReceipt({ harness: undefined, harnessUnattributableReason: "no_run_scoped_harness_evidence" });
	const reapplied = applyClassification(unattributed, { harnessUnattributableReason: "no_run_scoped_harness_evidence" });
	expect(reapplied).toBe(unattributed);
});

// ── markAborted (Finding 1, round 2 — aborted files must not count as done) ──────────────────

test("markAborted: zeroes the speculative counts and flips changed/abortedConcurrentWrite — the exact bug round 2 found", () => {
	const report = {
		file: "a.jsonl",
		lines: 3,
		harnessUnattributable: 2,
		modelUnattributable: 3,
		parseErrors: 0,
		skippedUnknownSchema: false,
		skippedUnknownSchemaDetail: [] as string[],
		abortedConcurrentWrite: false,
		changed: true,
	};
	markAborted(report);
	expect(report.abortedConcurrentWrite).toBe(true);
	expect(report.changed).toBe(false);
	expect(report.harnessUnattributable).toBe(0);
	expect(report.modelUnattributable).toBe(0);
});

// ── guardReceiptShape (round 2 Finding 3 — full field coverage, codex's exact counterexamples) ──

test("guardReceiptShape: a fully recognized receipt passes", () => {
	expect(guardReceiptShape(baseReceipt())).toBeUndefined();
});

test('guardReceiptShape: codex counterexample {"agentId":"a"} — missing every other required field — now FAILS', () => {
	const failure = guardReceiptShape({ agentId: "a" });
	expect(failure?.reason).toBe("invalid_field_type");
});

test('guardReceiptShape: codex counterexample {"startedAt":"future"} — wrong type on a required field — FAILS', () => {
	const failure = guardReceiptShape({ ...baseReceipt(), startedAt: "future" });
	expect(failure?.reason).toBe("invalid_field_type");
	expect(failure?.detail).toBe("startedAt");
});

test('guardReceiptShape: codex counterexample {"filesTouched":{}} — wrong type on a required field — FAILS', () => {
	const failure = guardReceiptShape({ ...baseReceipt(), filesTouched: {} });
	expect(failure?.reason).toBe("invalid_field_type");
	expect(failure?.detail).toBe("filesTouched");
});

test("guardReceiptShape: every required field is checked individually, not just agentId", () => {
	for (const field of ["name", "repo", "runId", "startedAt", "status", "toolCalls", "toolTally", "filesTouched"]) {
		const bad = { ...baseReceipt() } as Record<string, unknown>;
		delete bad[field];
		const failure = guardReceiptShape(bad);
		expect(failure?.reason).toBe("invalid_field_type");
	}
});

test("guardReceiptShape: a present optional field with the wrong type fails, including nested tokens sub-fields and fixed enums", () => {
	expect(guardReceiptShape({ ...baseReceipt(), harness: 123 })?.detail).toBe("harness");
	expect(guardReceiptShape({ ...baseReceipt(), model: true })?.detail).toBe("model");
	expect(guardReceiptShape({ ...baseReceipt(), status: "not-a-real-status" })?.detail).toBe("status");
	expect(guardReceiptShape({ ...baseReceipt(), tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: "oops" } })?.detail).toBe("tokens.total");
	expect(guardReceiptShape({ ...baseReceipt(), lane: "not-a-lane" })?.detail).toBe("lane");
	expect(guardReceiptShape({ ...baseReceipt(), tier: "not-a-tier" })?.detail).toBe("tier");
	expect(guardReceiptShape({ ...baseReceipt(), efficiencyFlags: [1, 2] })?.detail).toBe("efficiencyFlags");
});

test("guardReceiptShape: an unknown top-level key still fails closed", () => {
	const failure = guardReceiptShape({ ...baseReceipt(), schemaVersion: 2 });
	expect(failure?.reason).toBe("unknown_keys");
	expect(failure?.detail).toBe("schemaVersion");
});

test("guardReceiptShape: a non-object value fails closed", () => {
	expect(guardReceiptShape(null)?.reason).toBe("not_an_object");
	expect(guardReceiptShape("a string")?.reason).toBe("not_an_object");
	expect(guardReceiptShape([1, 2])?.reason).toBe("not_an_object");
});

// ── planFile: codex's exact counterexamples must leave the file byte-identical ──────────────────

test('planFile: codex counterexample {"agentId":"a"} leaves the WHOLE FILE byte-identical', () => {
	const line = JSON.stringify({ agentId: "a" });
	const { report, outLines } = planFile("weird.jsonl", line);
	expect(report.skippedUnknownSchema).toBe(true);
	expect(outLines).toEqual([line]);
});

test('planFile: codex counterexample {"startedAt":"future"} (mixed with an otherwise-fine row) leaves the WHOLE FILE byte-identical', () => {
	const good = JSON.stringify(baseReceipt({ agentId: "a1", harness: undefined }));
	const bad = JSON.stringify({ ...baseReceipt({ agentId: "a2" }), startedAt: "future" });
	const text = [good, bad].join("\n");
	const { report, outLines } = planFile("mixed.jsonl", text);
	expect(report.skippedUnknownSchema).toBe(true);
	expect(report.harnessUnattributable).toBe(0); // the good row was NOT touched either
	expect(outLines).toEqual([good, bad]);
});

test('planFile: codex counterexample {"filesTouched":{}} leaves the WHOLE FILE byte-identical', () => {
	const line = JSON.stringify({ ...baseReceipt(), filesTouched: {} });
	const { report, outLines } = planFile("weird2.jsonl", line);
	expect(report.skippedUnknownSchema).toBe(true);
	expect(outLines).toEqual([line]);
});

test("planFile: preserves line order and count, annotates reasons only — never a harness/model VALUE", () => {
	const rows = [baseReceipt({ agentId: "a1", runId: "r1", harness: undefined, model: "opus" }), baseReceipt({ agentId: "a1", runId: "r2", harness: "codex", model: "gpt" })];
	const text = rows.map((r) => JSON.stringify(r)).join("\n");
	const { report, outLines } = planFile("a1.jsonl", text);
	expect(report.lines).toBe(2);
	expect(report.harnessUnattributable).toBe(1);
	expect(report.changed).toBe(true);
	const out0 = JSON.parse(outLines[0]);
	expect(out0.harness).toBeUndefined();
	expect(out0.harnessUnattributableReason).toBe("no_run_scoped_harness_evidence");
	const out1 = JSON.parse(outLines[1]);
	expect(out1.harness).toBe("codex"); // untouched
});

test("planFile: an unparseable line leaves the WHOLE FILE byte-identical, including otherwise-annotatable rows", () => {
	const good = JSON.stringify(baseReceipt({ agentId: "a1", harness: undefined }));
	const text = `${good}\n{not valid json`;
	const { report, outLines } = planFile("torn.jsonl", text);
	expect(report.skippedUnknownSchema).toBe(true);
	expect(report.parseErrors).toBe(1);
	expect(report.harnessUnattributable).toBe(0);
	expect(outLines).toEqual([good, "{not valid json"]);
});

test("planFile: a file with no changes reports changed=false", () => {
	const text = JSON.stringify(baseReceipt({ harness: "pi", model: "opus" }));
	const { report } = planFile("clean.jsonl", text);
	expect(report.changed).toBe(false);
	expect(report.harnessUnattributable).toBe(0);
	expect(report.modelUnattributable).toBe(0);
});

// ── writeIfUnchanged (crash safety + mode preservation, round 2 Finding 5) ───────────────────────

test("writeIfUnchanged: writes via temp+rename when the stat matches, and fsyncs — no leftover temp files", async () => {
	const stateDir = await tmpStateDir();
	await writeRawLines(stateDir, "a1", [baseReceipt({ agentId: "a1" })]);
	const file = receiptPath(stateDir, "a1");
	const before = await fs.stat(file);

	const result = await writeIfUnchanged(file, `${JSON.stringify(baseReceipt({ agentId: "a1", harnessUnattributableReason: "no_run_scoped_harness_evidence" }))}\n`, before);
	expect(result).toEqual({ written: true, drifted: false });

	const [receipt] = await readReceipts(stateDir, "a1");
	expect(receipt.harnessUnattributableReason).toBe("no_run_scoped_harness_evidence");

	const entries = await fs.readdir(path.join(stateDir, "receipts"));
	expect(entries.every((e) => !e.includes(".tmp"))).toBe(true);
});

test("writeIfUnchanged: preserves the SOURCE file's permission bits on the replacement (Finding 5, round 2)", async () => {
	const stateDir = await tmpStateDir();
	await writeRawLines(stateDir, "a1", [baseReceipt({ agentId: "a1" })]);
	const file = receiptPath(stateDir, "a1");
	await fs.chmod(file, 0o600);
	const before = await fs.stat(file);
	expect(before.mode & 0o777).toBe(0o600);

	const result = await writeIfUnchanged(file, `${JSON.stringify(baseReceipt({ agentId: "a1", harnessUnattributableReason: "no_run_scoped_harness_evidence" }))}\n`, before);
	expect(result.written).toBe(true);

	const after = await fs.stat(file);
	expect(after.mode & 0o777).toBe(0o600); // NOT widened to the process umask's default (e.g. 0644)
});

test("writeIfUnchanged: a stale `before` stat (simulating a concurrent writer) aborts — original file untouched, temp file cleaned up", async () => {
	const stateDir = await tmpStateDir();
	const original = `${JSON.stringify(baseReceipt({ agentId: "a1" }))}\n`;
	await writeRawLines(stateDir, "a1", [baseReceipt({ agentId: "a1" })]);
	const file = receiptPath(stateDir, "a1");

	const fakeBefore = { mtimeMs: 1, size: 999999, mode: 0o100644 } as import("node:fs").Stats;
	const result = await writeIfUnchanged(file, `${JSON.stringify(baseReceipt({ agentId: "a1", harnessUnattributableReason: "no_run_scoped_harness_evidence" }))}\n`, fakeBefore);
	expect(result).toEqual({ written: false, drifted: true });

	expect(await fs.readFile(file, "utf8")).toBe(original);
	const entries = await fs.readdir(path.join(stateDir, "receipts"));
	expect(entries.every((e) => !e.includes(".tmp"))).toBe(true);
});

test("writeIfUnchanged: a null `before` (file didn't exist at read time) also aborts rather than clobbering a since-created file", async () => {
	const stateDir = await tmpStateDir();
	await writeRawLines(stateDir, "a1", [baseReceipt({ agentId: "a1" })]);
	const file = receiptPath(stateDir, "a1");
	const original = await fs.readFile(file, "utf8");

	const result = await writeIfUnchanged(file, "should-never-land\n", null);
	expect(result).toEqual({ written: false, drifted: true });
	expect(await fs.readFile(file, "utf8")).toBe(original);
});

// ── runBackfill: acquires and HOLDS the real lock (round 2 Finding 1) ────────────────────────────

test("runBackfill: REFUSES to run (dry-run included) while a live daemon holds the state dir", async () => {
	const stateDir = await tmpStateDir();
	await writeRawLines(stateDir, "a1", [baseReceipt({ agentId: "a1", harness: undefined })]);
	await writeLiveDaemonLock(stateDir);

	await expect(runBackfill({ stateDir, dryRun: true })).rejects.toThrow(DaemonLockRefusal);
	await expect(runBackfill({ stateDir, dryRun: false })).rejects.toThrow(DaemonLockRefusal);

	const [receipt] = await readReceipts(stateDir, "a1");
	expect(receipt.harnessUnattributableReason).toBeUndefined(); // refused before touching anything
});

test("runBackfill: a STALE lock (dead pid) is reclaimed by the real acquire — proceeds normally", async () => {
	const stateDir = await tmpStateDir();
	await writeRawLines(stateDir, "a1", [baseReceipt({ agentId: "a1", harness: undefined })]);
	await writeStaleDaemonLock(stateDir);

	const report = await runBackfill({ stateDir, dryRun: true });
	expect(report.harnessUnattributable).toBe(1);
});

test("runBackfill: ACTUALLY ACQUIRES the real lock for the pass and RELEASES it afterward — no lingering daemon.lock", async () => {
	const stateDir = await tmpStateDir();
	await writeRawLines(stateDir, "a1", [baseReceipt({ agentId: "a1", harness: undefined })]);
	expect(await exists(path.join(stateDir, "daemon.lock"))).toBe(false); // no lock before the run

	await runBackfill({ stateDir, dryRun: true });

	expect(await exists(path.join(stateDir, "daemon.lock"))).toBe(false); // released after — proves acquire+release happened, not just a probe
});

test("runBackfill: no lock file at all proceeds normally", async () => {
	const stateDir = await tmpStateDir();
	await writeRawLines(stateDir, "a1", [baseReceipt({ agentId: "a1", harness: undefined })]);
	const report = await runBackfill({ stateDir, dryRun: true });
	expect(report.harnessUnattributable).toBe(1);
});

// ── runBackfill: end-to-end over a fixture state dir ─────────────────────────────────────────

test("runBackfill --dry-run: reports counts and writes NOTHING to disk; never a harness/model value anywhere", async () => {
	const stateDir = await tmpStateDir();
	await writeRawLines(stateDir, "legacy1", [baseReceipt({ agentId: "legacy1", harness: undefined, model: undefined })]);
	await writeRawLines(stateDir, "cc-abcd1234", [baseReceipt({ agentId: "cc-abcd1234", harness: undefined, model: "claude-sonnet" })]);

	const beforeLegacy = await fs.readFile(receiptPath(stateDir, "legacy1"), "utf8");
	const beforeCc = await fs.readFile(receiptPath(stateDir, "cc-abcd1234"), "utf8");

	const report = await runBackfill({ stateDir, dryRun: true });

	expect(report.filesScanned).toBe(2);
	expect(report.totalLines).toBe(2);
	expect(report.harnessUnattributable).toBe(2);
	expect(report.modelUnattributable).toBe(1); // legacy1 only — cc-abcd1234 already has a model
	expect(report.filesWritten).toBe(0);

	expect(await fs.readFile(receiptPath(stateDir, "legacy1"), "utf8")).toBe(beforeLegacy);
	expect(await fs.readFile(receiptPath(stateDir, "cc-abcd1234"), "utf8")).toBe(beforeCc);

	printReport(report); // smoke coverage for the CLI's console output path
});

test("runBackfill live: annotates reasons only (never a value), and is idempotent", async () => {
	const stateDir = await tmpStateDir();
	await writeRawLines(stateDir, "noevidence", [baseReceipt({ agentId: "noevidence", harness: undefined })]);

	await writeRawLines(stateDir, "clean", [baseReceipt({ agentId: "clean", harness: "pi", model: "opus" })]);
	const cleanBefore = await fs.readFile(receiptPath(stateDir, "clean"), "utf8");

	const report = await runBackfill({ stateDir, dryRun: false });

	expect(report.harnessUnattributable).toBe(1);
	expect(report.modelUnattributable).toBe(1);
	expect(report.filesWritten).toBe(1);

	const noevidence = await readReceipts(stateDir, "noevidence");
	expect(noevidence[0].harness).toBeUndefined();
	expect(noevidence[0].harnessUnattributableReason).toBe("no_run_scoped_harness_evidence");

	expect(await fs.readFile(receiptPath(stateDir, "clean"), "utf8")).toBe(cleanBefore);

	const second = await runBackfill({ stateDir, dryRun: false });
	expect(second.filesWritten).toBe(0);
	expect(second.harnessUnattributable).toBe(1);
	expect(second.modelUnattributable).toBe(1);

	const entries = await fs.readdir(path.join(stateDir, "receipts"));
	expect(entries.every((e) => !e.includes(".tmp"))).toBe(true);
});

test("runBackfill: a file with an unrecognized row is skipped entirely and reported, siblings still process", async () => {
	const stateDir = await tmpStateDir();
	await writeRawLines(stateDir, "weird", [{ agentId: "a" }]); // codex counterexample
	await writeRawLines(stateDir, "normal", [baseReceipt({ agentId: "normal", harness: undefined })]);
	const weirdBefore = await fs.readFile(receiptPath(stateDir, "weird"), "utf8");

	const report = await runBackfill({ stateDir, dryRun: false });
	expect(report.filesSkippedUnknownSchema).toBe(1);
	expect(await fs.readFile(receiptPath(stateDir, "weird"), "utf8")).toBe(weirdBefore);
	const [normal] = await readReceipts(stateDir, "normal");
	expect(normal.harnessUnattributableReason).toBe("no_run_scoped_harness_evidence"); // sibling still processed
});

test("runBackfill: an empty/missing receipts dir reports zero scanned, never throws", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "backfill-empty-"));
	tmps.push(stateDir);
	const report = await runBackfill({ stateDir, dryRun: true });
	expect(report.filesScanned).toBe(0);
	expect(report.totalLines).toBe(0);
});
