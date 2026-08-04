/**
 * scripts/backfill-receipt-attribution.ts — the historical-repair pass for glance#331's missing
 * harness/model on receipts. GAUNTLET ROUND 1 (PR #342 blind cross-lineage review, block verdict,
 * adjudicated) found the round-1 version fabricated attribution and had two crash/race hazards;
 * this file covers the fix shape:
 *   - harness: attributed ONLY from positive, row-scoped `state.json` roster evidence (explicit
 *     `harness` field, or legacy `runtime` mapped via the SAME `runtimeToHarness` the daemon
 *     itself uses) — never from "harness absent", never from today's global default.
 *   - model: NEVER attributed. Every missing-model row gets the fixed reason code
 *     `no_run_scoped_model_evidence` — no task-outcomes cross-reference, no heuristics.
 *   - a row with an unrecognized shape (unknown key, wrong-typed known field, unparseable JSON)
 *     leaves its WHOLE FILE untouched, byte-identical.
 *   - the write path never opens the source with "w": temp file → fsync → re-stat the original
 *     immediately before rename, abort on drift → rename → fsync the directory.
 *   - the whole script refuses to run (dry-run included) while a live daemon holds the state
 *     dir's single-writer lock.
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
	loadPositiveEvidence,
	MODEL_UNATTRIBUTABLE_REASON,
	planFile,
	positiveHarnessFrom,
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

async function writeStateJson(stateDir: string, agents: Array<Record<string, unknown>>): Promise<void> {
	await fs.writeFile(path.join(stateDir, "state.json"), JSON.stringify({ agents }));
}

/** Writes a daemon.lock recording a genuinely LIVE, different-from-this-test-process pid (a real
 *  spawned child) — `ownerAlive` special-cases `rec.pid === process.pid` as "our own stale
 *  record", so the probe needs an actually distinct alive process to prove the "live" path. */
async function writeLiveDaemonLock(stateDir: string): Promise<void> {
	const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
	spawned.push(child);
	await fs.writeFile(path.join(stateDir, "daemon.lock"), JSON.stringify({ pid: child.pid, host: os.hostname(), startedAt: Date.now() }));
}

/** Writes a daemon.lock recording a pid that (almost certainly) does not exist — the stale-lock
 *  path `probeDaemonLock` must NOT treat as live. */
async function writeStaleDaemonLock(stateDir: string): Promise<void> {
	await fs.writeFile(path.join(stateDir, "daemon.lock"), JSON.stringify({ pid: 999_999_999, host: os.hostname(), startedAt: Date.now() }));
}

// ── positiveHarnessFrom / classifyReceipt (pure) ─────────────────────────────────────────────

test("positiveHarnessFrom: explicit harness field wins", () => {
	expect(positiveHarnessFrom({ harness: "auggie" })).toBe("auggie");
});

test("positiveHarnessFrom: legacy runtime maps through the SAME runtimeToHarness the daemon uses", () => {
	expect(positiveHarnessFrom({ runtime: "acp" })).toBe("auggie");
	expect(positiveHarnessFrom({ runtime: "omp" })).toBe("omp");
});

test("positiveHarnessFrom: an unrecognized legacy runtime value is NOT evidence", () => {
	expect(positiveHarnessFrom({ runtime: "something-future" })).toBeUndefined();
});

test("positiveHarnessFrom: a record with NEITHER field is no evidence — never falls back to today's global default", () => {
	expect(positiveHarnessFrom({})).toBeUndefined();
	expect(positiveHarnessFrom(undefined)).toBeUndefined();
});

test("classifyReceipt: missing harness with positive state.json evidence is attributed to that harness", () => {
	const r = baseReceipt({ harness: undefined });
	const result = classifyReceipt(r, { evidence: { harness: "pi" } });
	expect(result.harness).toBe("pi");
	expect(result.harnessUnattributableReason).toBeUndefined();
});

test("classifyReceipt: missing harness with NO evidence gets the generic unattributable code", () => {
	const r = baseReceipt({ harness: undefined });
	const result = classifyReceipt(r, {});
	expect(result.harness).toBeUndefined();
	expect(result.harnessUnattributableReason).toBe("no_state_json_evidence");
});

test("classifyReceipt: missing harness on an ingested-lane agentId prefix gets the MORE SPECIFIC ambiguous code, never blind-stamped", () => {
	for (const agentId of ["cc-abc12345", "codex-abc12345", "or-2026-08-04-opus"]) {
		const r = baseReceipt({ agentId, harness: undefined });
		const result = classifyReceipt(r, {});
		expect(result.harness).toBeUndefined();
		expect(result.harnessUnattributableReason).toBe("agent_id_prefix_ambiguous");
	}
});

test("classifyReceipt: present harness is left alone even when state.json disagrees", () => {
	const r = baseReceipt({ harness: "pi" });
	const result = classifyReceipt(r, { evidence: { harness: "codex" } });
	expect(result.harness).toBeUndefined();
});

test("classifyReceipt: missing model ALWAYS gets the single fixed reason code — no attribution path exists", () => {
	const r = baseReceipt({ model: undefined });
	const result = classifyReceipt(r, {});
	expect(result.modelUnattributableReason).toBe(MODEL_UNATTRIBUTABLE_REASON);
	expect((result as Record<string, unknown>).model).toBeUndefined();
});

test("classifyReceipt: present model is left alone", () => {
	const r = baseReceipt({ model: "opus" });
	const result = classifyReceipt(r, {});
	expect(result.modelUnattributableReason).toBeUndefined();
});

// ── applyClassification (pure) ───────────────────────────────────────────────────────────────

test("applyClassification: stamps harness and clears any stale reason, never mutates the input", () => {
	const r = baseReceipt({ harness: undefined, harnessUnattributableReason: "no_state_json_evidence" });
	const next = applyClassification(r, { harness: "pi" });
	expect(next.harness).toBe("pi");
	expect(next.harnessUnattributableReason).toBeUndefined();
	expect(r.harness).toBeUndefined(); // original untouched
});

test("applyClassification: stamps unattributable reasons for both fields independently", () => {
	const r = baseReceipt({ harness: undefined, model: undefined });
	const next = applyClassification(r, { harnessUnattributableReason: "no_state_json_evidence", modelUnattributableReason: MODEL_UNATTRIBUTABLE_REASON });
	expect(next.harness).toBeUndefined();
	expect(next.harnessUnattributableReason).toBe("no_state_json_evidence");
	expect(next.modelUnattributableReason).toBe(MODEL_UNATTRIBUTABLE_REASON);
});

test("applyClassification: a no-op classification returns the SAME reference (no spurious rewrite) — proves idempotency at the unit level", () => {
	const r = baseReceipt({ harness: "pi", model: "opus" });
	expect(applyClassification(r, {})).toBe(r);

	// Re-applying the SAME reason a second time (as a re-audit pass would) is also a no-op.
	const unattributed = baseReceipt({ harness: undefined, harnessUnattributableReason: "no_state_json_evidence" });
	const reapplied = applyClassification(unattributed, { harnessUnattributableReason: "no_state_json_evidence", modelUnattributableReason: undefined });
	expect(reapplied).toBe(unattributed);
});

// ── guardReceiptShape (Finding 5) ────────────────────────────────────────────────────────────

test("guardReceiptShape: a fully recognized receipt passes", () => {
	expect(guardReceiptShape(baseReceipt())).toBeUndefined();
});

test("guardReceiptShape: an unknown top-level key fails closed, never silently ignored", () => {
	const failure = guardReceiptShape({ ...baseReceipt(), schemaVersion: 2 });
	expect(failure?.reason).toBe("unknown_keys");
	expect(failure?.detail).toBe("schemaVersion");
});

test("guardReceiptShape: a wrong-typed known field fails closed", () => {
	expect(guardReceiptShape({ ...baseReceipt(), harness: 123 })?.reason).toBe("invalid_field_type");
	expect(guardReceiptShape({ ...baseReceipt(), model: true })?.reason).toBe("invalid_field_type");
});

test("guardReceiptShape: a non-object value fails closed", () => {
	expect(guardReceiptShape(null)?.reason).toBe("not_an_object");
	expect(guardReceiptShape("a string")?.reason).toBe("not_an_object");
	expect(guardReceiptShape([1, 2])?.reason).toBe("not_an_object");
});

// ── planFile (per-file, pure over text) ──────────────────────────────────────────────────────

test("planFile: preserves line order and count, attributes harness only from positive evidence", () => {
	const rows = [baseReceipt({ agentId: "a1", runId: "r1", harness: undefined, model: "opus" }), baseReceipt({ agentId: "a1", runId: "r2", harness: "codex", model: "gpt" })];
	const text = rows.map((r) => JSON.stringify(r)).join("\n");
	const evidence = new Map([["a1", { harness: "auggie" }]]);
	const { report, outLines } = planFile("a1.jsonl", text, evidence);
	expect(report.lines).toBe(2);
	expect(report.harnessBackfilled).toBe(1);
	expect(report.changed).toBe(true);
	expect(outLines.length).toBe(2);
	expect(JSON.parse(outLines[0]).harness).toBe("auggie");
	expect(JSON.parse(outLines[1]).harness).toBe("codex"); // untouched
});

test("planFile: an unparseable line leaves the WHOLE FILE byte-identical, including otherwise-attributable rows", () => {
	const good = JSON.stringify(baseReceipt({ agentId: "a1", harness: undefined }));
	const text = `${good}\n{not valid json`;
	const { report, outLines } = planFile("torn.jsonl", text, new Map([["a1", { harness: "pi" }]]));
	expect(report.skippedUnknownSchema).toBe(true);
	expect(report.parseErrors).toBe(1);
	expect(report.harnessBackfilled).toBe(0); // the good row was NOT touched either
	expect(outLines).toEqual([good, "{not valid json"]); // byte-identical passthrough
});

test("planFile: an unrecognized key on ANY row leaves the whole file byte-identical", () => {
	const attributable = JSON.stringify(baseReceipt({ agentId: "a1", harness: undefined }));
	const unrecognized = JSON.stringify({ ...baseReceipt({ agentId: "a2" }), schemaVersion: 2 });
	const text = [attributable, unrecognized].join("\n");
	const { report, outLines } = planFile("mixed.jsonl", text, new Map([["a1", { harness: "pi" }]]));
	expect(report.skippedUnknownSchema).toBe(true);
	expect(report.skippedUnknownSchemaDetail[0]).toMatch(/unknown_keys/);
	expect(report.harnessBackfilled).toBe(0);
	expect(outLines).toEqual([attributable, unrecognized]);
});

test("planFile: a file with no attributable/unattributable changes reports changed=false", () => {
	const text = JSON.stringify(baseReceipt({ harness: "pi", model: "opus" }));
	const { report } = planFile("clean.jsonl", text, new Map());
	expect(report.changed).toBe(false);
	expect(report.harnessBackfilled).toBe(0);
	expect(report.modelUnattributable).toBe(0);
});

test("planFile: model is NEVER attributed even when positive evidence exists for harness on the same row", () => {
	const text = JSON.stringify(baseReceipt({ agentId: "a1", harness: undefined, model: undefined }));
	const { report, outLines } = planFile("a1.jsonl", text, new Map([["a1", { harness: "pi" }]]));
	expect(report.modelUnattributable).toBe(1);
	const out = JSON.parse(outLines[0]);
	expect(out.model).toBeUndefined();
	expect(out.modelUnattributableReason).toBe(MODEL_UNATTRIBUTABLE_REASON);
	expect(out.harness).toBe("pi"); // harness attribution is independent and still applies
});

// ── loadPositiveEvidence (Finding 3) ─────────────────────────────────────────────────────────

test("loadPositiveEvidence: reads state.json's roster, explicit harness and legacy runtime both count", async () => {
	const stateDir = await tmpStateDir();
	await writeStateJson(stateDir, [
		{ id: "unit-a", harness: "pi" },
		{ id: "unit-b", runtime: "acp" },
		{ id: "unit-c" }, // neither field — no evidence
	]);
	const map = await loadPositiveEvidence(stateDir);
	expect(map.get("unit-a")).toEqual({ harness: "pi", runtime: undefined });
	expect(map.get("unit-b")).toEqual({ harness: undefined, runtime: "acp" });
	expect(map.has("unit-c")).toBe(false);
});

test("loadPositiveEvidence: missing/corrupt/malformed state.json degrades to an empty map, never throws", async () => {
	const stateDir = await tmpStateDir();
	expect(await loadPositiveEvidence(stateDir)).toEqual(new Map()); // no file at all

	await fs.writeFile(path.join(stateDir, "state.json"), "{not valid json");
	expect(await loadPositiveEvidence(stateDir)).toEqual(new Map());

	// A malformed entry (harness as a number, id missing) is skipped, not crashed on or mis-read.
	await fs.writeFile(path.join(stateDir, "state.json"), JSON.stringify({ agents: [{ harness: 5 }, { id: "ok", harness: "codex" }, "not-an-object"] }));
	const map = await loadPositiveEvidence(stateDir);
	expect(map.size).toBe(1);
	expect(map.get("ok")?.harness).toBe("codex");
});

// ── writeIfUnchanged (Findings 1+2) ──────────────────────────────────────────────────────────

test("writeIfUnchanged: writes via temp+rename when the stat matches, and fsyncs — no leftover temp files", async () => {
	const stateDir = await tmpStateDir();
	await writeRawLines(stateDir, "a1", [baseReceipt({ agentId: "a1" })]);
	const file = receiptPath(stateDir, "a1");
	const before = await fs.stat(file);

	const result = await writeIfUnchanged(file, `${JSON.stringify(baseReceipt({ agentId: "a1", harness: "pi" }))}\n`, before);
	expect(result).toEqual({ written: true, drifted: false });

	const [receipt] = await readReceipts(stateDir, "a1");
	expect(receipt.harness).toBe("pi");

	const entries = await fs.readdir(path.join(stateDir, "receipts"));
	expect(entries.every((e) => !e.includes(".tmp"))).toBe(true);
});

test("writeIfUnchanged: a stale `before` stat (simulating a concurrent writer) aborts — original file untouched, temp file cleaned up", async () => {
	const stateDir = await tmpStateDir();
	const original = `${JSON.stringify(baseReceipt({ agentId: "a1" }))}\n`;
	await writeRawLines(stateDir, "a1", [baseReceipt({ agentId: "a1" })]);
	const file = receiptPath(stateDir, "a1");

	// A deliberately WRONG "before" snapshot — as if the file had different content when it was
	// actually read (the drift this check exists to catch).
	const fakeBefore = { mtimeMs: 1, size: 999999 } as import("node:fs").Stats;
	const result = await writeIfUnchanged(file, `${JSON.stringify(baseReceipt({ agentId: "a1", harness: "pi" }))}\n`, fakeBefore);
	expect(result).toEqual({ written: false, drifted: true });

	expect(await fs.readFile(file, "utf8")).toBe(original); // never touched
	const entries = await fs.readdir(path.join(stateDir, "receipts"));
	expect(entries.every((e) => !e.includes(".tmp"))).toBe(true); // temp file cleaned up, not orphaned
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

// ── runBackfill: daemon-lock refusal (Findings 1+2) ──────────────────────────────────────────

test("runBackfill: REFUSES to run (dry-run included) while a live daemon holds the state dir", async () => {
	const stateDir = await tmpStateDir();
	await writeRawLines(stateDir, "a1", [baseReceipt({ agentId: "a1", harness: undefined })]);
	await writeLiveDaemonLock(stateDir);

	await expect(runBackfill({ stateDir, dryRun: true })).rejects.toThrow(DaemonLockRefusal);
	await expect(runBackfill({ stateDir, dryRun: false })).rejects.toThrow(DaemonLockRefusal);

	// Confirm nothing was touched by either refused attempt.
	const [receipt] = await readReceipts(stateDir, "a1");
	expect(receipt.harness).toBeUndefined();
});

test("runBackfill: a STALE lock (dead pid) does NOT refuse — proceeds normally", async () => {
	const stateDir = await tmpStateDir();
	await writeRawLines(stateDir, "a1", [baseReceipt({ agentId: "a1", harness: undefined })]);
	await writeStaleDaemonLock(stateDir);

	const report = await runBackfill({ stateDir, dryRun: true });
	expect(report.harnessUnattributable).toBe(1);
});

test("runBackfill: no lock file at all proceeds normally", async () => {
	const stateDir = await tmpStateDir();
	await writeRawLines(stateDir, "a1", [baseReceipt({ agentId: "a1", harness: undefined })]);
	const report = await runBackfill({ stateDir, dryRun: true });
	expect(report.harnessUnattributable).toBe(1);
});

// ── runBackfill: end-to-end over a fixture state dir ─────────────────────────────────────────

test("runBackfill --dry-run: reports counts and writes NOTHING to disk", async () => {
	const stateDir = await tmpStateDir();
	await writeRawLines(stateDir, "legacy1", [baseReceipt({ agentId: "legacy1", harness: undefined, model: undefined })]);
	await writeRawLines(stateDir, "cc-abcd1234", [baseReceipt({ agentId: "cc-abcd1234", harness: undefined, model: "claude-sonnet" })]);

	const beforeLegacy = await fs.readFile(receiptPath(stateDir, "legacy1"), "utf8");
	const beforeCc = await fs.readFile(receiptPath(stateDir, "cc-abcd1234"), "utf8");

	const report = await runBackfill({ stateDir, dryRun: true });

	expect(report.filesScanned).toBe(2);
	expect(report.totalLines).toBe(2);
	expect(report.harnessBackfilled).toBe(0); // no state.json at all ⇒ no positive evidence anywhere
	expect(report.harnessUnattributable).toBe(2);
	expect(report.modelUnattributable).toBe(1); // legacy1 only — cc-abcd1234 already has a model
	expect(report.filesWritten).toBe(0);

	expect(await fs.readFile(receiptPath(stateDir, "legacy1"), "utf8")).toBe(beforeLegacy);
	expect(await fs.readFile(receiptPath(stateDir, "cc-abcd1234"), "utf8")).toBe(beforeCc);

	printReport(report); // smoke coverage for the CLI's console output path
});

test("runBackfill live: rewrites only changed files via positive state.json evidence, and is idempotent", async () => {
	const stateDir = await tmpStateDir();
	// legacy2: single run, missing harness AND model, WITH a matching positive state.json entry.
	await writeRawLines(stateDir, "legacy2", [baseReceipt({ agentId: "legacy2", harness: undefined, model: undefined })]);
	// no-evidence: missing harness, no roster entry at all.
	await writeRawLines(stateDir, "noevidence", [baseReceipt({ agentId: "noevidence", harness: undefined })]);
	await writeStateJson(stateDir, [{ id: "legacy2", harness: "auggie" }]);

	// clean: already fully attributed — must be left byte-identical (no spurious rewrite).
	await writeRawLines(stateDir, "clean", [baseReceipt({ agentId: "clean", harness: "pi", model: "opus" })]);
	const cleanBefore = await fs.readFile(receiptPath(stateDir, "clean"), "utf8");

	const report = await runBackfill({ stateDir, dryRun: false });

	expect(report.harnessBackfilled).toBe(1); // legacy2
	expect(report.harnessUnattributable).toBe(1); // noevidence
	expect(report.modelUnattributable).toBe(2); // legacy2 AND noevidence both lack a model (baseReceipt default)
	expect(report.filesWritten).toBe(2); // legacy2 + noevidence; NOT clean

	const legacy2 = await readReceipts(stateDir, "legacy2");
	expect(legacy2[0].harness).toBe("auggie");
	expect(legacy2[0].harnessUnattributableReason).toBeUndefined();
	expect(legacy2[0].model).toBeUndefined();
	expect(legacy2[0].modelUnattributableReason).toBe(MODEL_UNATTRIBUTABLE_REASON);

	const noevidence = await readReceipts(stateDir, "noevidence");
	expect(noevidence[0].harness).toBeUndefined();
	expect(noevidence[0].harnessUnattributableReason).toBe("no_state_json_evidence");

	expect(await fs.readFile(receiptPath(stateDir, "clean"), "utf8")).toBe(cleanBefore);

	// Idempotent: a second pass finds nothing left to attribute or rewrite.
	const second = await runBackfill({ stateDir, dryRun: false });
	expect(second.harnessBackfilled).toBe(0);
	expect(second.filesWritten).toBe(0);
	// The still-unattributable rows keep re-reporting the same audited reason but aren't rewritten.
	expect(second.harnessUnattributable).toBe(1);
	expect(second.modelUnattributable).toBe(2);

	// No leftover temp files anywhere.
	const entries = await fs.readdir(path.join(stateDir, "receipts"));
	expect(entries.every((e) => !e.includes(".tmp"))).toBe(true);
});

test("runBackfill: a file with an unrecognized row is skipped entirely and reported, siblings still process", async () => {
	const stateDir = await tmpStateDir();
	await writeRawLines(stateDir, "weird", [{ ...baseReceipt({ agentId: "weird" }), schemaVersion: 2 }]);
	await writeRawLines(stateDir, "normal", [baseReceipt({ agentId: "normal", harness: undefined })]);
	const weirdBefore = await fs.readFile(receiptPath(stateDir, "weird"), "utf8");

	const report = await runBackfill({ stateDir, dryRun: false });
	expect(report.filesSkippedUnknownSchema).toBe(1);
	expect(await fs.readFile(receiptPath(stateDir, "weird"), "utf8")).toBe(weirdBefore);
	const [normal] = await readReceipts(stateDir, "normal");
	expect(normal.harnessUnattributableReason).toBe("no_state_json_evidence"); // sibling still processed
});

test("runBackfill: an empty/missing receipts dir reports zero scanned, never throws", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "backfill-empty-"));
	tmps.push(stateDir);
	const report = await runBackfill({ stateDir, dryRun: true });
	expect(report.filesScanned).toBe(0);
	expect(report.totalLines).toBe(0);
});
