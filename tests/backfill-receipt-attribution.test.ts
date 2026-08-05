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
 *
 * Round 3 (fresh blind codex, invariant-only pass — the three core invariants were refuted-clean
 * a third straight time: no attribution writes, `finally` lock coverage, atomic rename, and
 * idempotency all held) added:
 *   - full NESTED validation: `toolTally` values must be numeric, `tokens` rejects extra keys,
 *     every `Span` and every `ValidationRecord` field/enum is checked, not just outer shape.
 *   - error honesty: an unreadable receipts dir (ENOTDIR etc., not just "doesn't exist yet")
 *     throws instead of silently reporting "0 files scanned".
 *   - the schema guard's key set is compile-time ratcheted against `keyof RunReceipt` — this file
 *     doesn't test that directly (a TS compile error isn't a runtime assertion), but `bun run
 *     check` is the test: tsconfig.json now includes this script.
 *   - mode preservation widened to `0o7777` (special bits too), regression-tested with `02750`.
 *   - `--state-dir` rejects a following `--`-prefixed token as a misplaced flag.
 *   - two test-gap fixes: a barrier proves the lock is genuinely HELD during the write phase (not
 *     just acquired-then-released), and an inode-change assertion pins rename-based replacement.
 *
 * Delta-verify round (scoped re-check of rounds 1-3, fresh codex — 5/7 confirmed CLOSED, 2
 * residuals fixed here):
 *   - readFileWithStat now only degrades ENOENT to a skip; any other per-FILE open failure
 *     (EACCES from a 0000-mode file, ELOOP, …) throws ReceiptFileUnreadable — the same posture
 *     round 3 already gave the directory-level readdir failure.
 *   - the round-3 inode-change assertion didn't actually pin ATOMIC rename (a non-atomic
 *     unlink+link also changes the inode and would pass it). Replaced with a stronger assertion:
 *     the destination path is polled continuously and must NEVER be momentarily unstatable
 *     during the write — true for a real rename, false for unlink-then-link. The weaker
 *     inode-only check is kept alongside as corroborating, non-load-bearing evidence.
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
	ReceiptFileUnreadable,
	ReceiptsDirUnreadable,
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

// Re-homed from a `test.skip` (glance#354): this used to be flaky/order-dependent because
// `runBackfill` called `acquireStateLock` with `handoffMs: 0` while state-lock.ts's deadline
// check ran on a millisecond-resolution `Date.now()` — an uncontested stale-lock reclaim only
// "fit" inside a zero budget by accidentally landing in the same millisecond bucket the deadline
// was computed in, so it passed only when incidental timing (which flock caches happened to
// already be warm, exact scheduling) got lucky. state-lock.ts's #354 hygiene fix (residual 1:
// a monotonic clock with no millisecond-bucketing grace, checked consistently before AND after
// the flock attempt) removed that accidental luck entirely — a genuinely zero budget can no
// longer complete a reclaim at all, ever, since the fence mechanics themselves take a nonzero
// amount of real time. The actual fix was in the CALLER: `runBackfill` now passes a real
// `RECLAIM_HANDOFF_MS` (500ms) instead of `0` (see scripts/backfill-receipt-attribution.ts), which
// gives genuine headroom for an uncontested reclaim to finish. Verified deterministic (not just
// "usually passes") across repeated runs, standalone and combined with tests/state-lock.test.ts,
// in both file orders.
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

// ── Round 3: nested schema validation (Finding 1) ────────────────────────────────────────────

test('guardReceiptShape: codex counterexample {"toolTally":{"bash":"one"}} — non-numeric tally value — FAILS', () => {
	const failure = guardReceiptShape({ ...baseReceipt(), toolTally: { bash: "one" } });
	expect(failure?.reason).toBe("invalid_field_type");
	expect(failure?.detail).toBe("toolTally value");
});

test('planFile: codex counterexample {"toolTally":{"bash":"one"}} leaves the WHOLE FILE byte-identical', () => {
	const line = JSON.stringify({ ...baseReceipt(), toolTally: { bash: "one" } });
	const { report, outLines } = planFile("weird3.jsonl", line);
	expect(report.skippedUnknownSchema).toBe(true);
	expect(outLines).toEqual([line]);
});

test("guardReceiptShape: tokens rejects an extra unrecognized key, not just its five known fields", () => {
	const tokens = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 5, extra: 6 };
	const failure = guardReceiptShape({ ...baseReceipt(), tokens });
	expect(failure?.reason).toBe("invalid_field_type");
	expect(failure?.detail).toBe("tokens.{extra}");
});

test("guardReceiptShape: a span is fully validated — required fields, enum values, and unknown keys", () => {
	const goodSpan = { traceId: "t1", spanId: "s1", name: "n", kind: "tool", startedAt: 1, status: "ok" };
	expect(guardReceiptShape({ ...baseReceipt(), spans: [goodSpan] })).toBeUndefined();

	expect(guardReceiptShape({ ...baseReceipt(), spans: [{ ...goodSpan, kind: "not-a-real-kind" }] })?.detail).toBe("spans[0].kind");
	expect(guardReceiptShape({ ...baseReceipt(), spans: [{ ...goodSpan, status: "not-a-real-status" }] })?.detail).toBe("spans[0].status");
	expect(guardReceiptShape({ ...baseReceipt(), spans: [{ ...goodSpan, startedAt: "future" }] })?.detail).toBe("spans[0].startedAt");
	expect(guardReceiptShape({ ...baseReceipt(), spans: [{ ...goodSpan, extraKey: 1 }] })?.detail).toBe("spans[0].{extraKey}");
	expect(guardReceiptShape({ ...baseReceipt(), spans: [{ ...goodSpan, attrs: { a: 1 } }] })?.detail).toBe("spans[0].attrs value");
});

test("guardReceiptShape: a validation record is fully validated — required fields, nested perCriterion/lensAdvisory, enums, and unknown keys", () => {
	const good = { verdict: "pass", agreement: 1, confidence: 1, perCriterion: [{ id: "c1", satisfied: true }], rationale: "ok", ranAt: 1 };
	expect(guardReceiptShape({ ...baseReceipt(), validation: good })).toBeUndefined();

	expect(guardReceiptShape({ ...baseReceipt(), validation: { ...good, verdict: "not-a-real-verdict" } })?.detail).toBe("validation.verdict");
	expect(guardReceiptShape({ ...baseReceipt(), validation: { ...good, extraKey: 1 } })?.detail).toBe("validation.{extraKey}");
	expect(guardReceiptShape({ ...baseReceipt(), validation: { ...good, perCriterion: [{ id: "c1", satisfied: "yes" }] } })?.detail).toBe("validation.perCriterion[0].satisfied");
	expect(guardReceiptShape({ ...baseReceipt(), validation: { ...good, authorLineage: "not-a-real-lineage" } })?.detail).toBe("validation.authorLineage");
	expect(guardReceiptShape({ ...baseReceipt(), validation: { ...good, lensAdvisory: [{ lens: "regression", disposition: "object", severity: "high", claim: "x" }] } })).toBeUndefined();
	expect(guardReceiptShape({ ...baseReceipt(), validation: { ...good, lensAdvisory: [{ lens: "regression", disposition: "not-a-real-disposition", severity: "high", claim: "x" }] } })?.detail).toBe("validation.lensAdvisory[0].disposition");
	expect(guardReceiptShape({ ...baseReceipt(), validation: { ...good, lensVerify: { lens: "regression", claim: "x", confirmed: true } } })).toBeUndefined();
	expect(guardReceiptShape({ ...baseReceipt(), validation: { ...good, lensVerify: { lens: "regression", claim: "x", confirmed: "yes" } } })?.detail).toBe("validation.lensVerify.confirmed");
});

// ── Round 3: error honesty (Finding 2) ────────────────────────────────────────────────────────

test("runBackfill: receipts dir existing as a PLAIN FILE (ENOTDIR) throws ReceiptsDirUnreadable — never reports success with 0 files", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "backfill-enotdir-"));
	tmps.push(stateDir);
	await fs.writeFile(path.join(stateDir, "receipts"), "not a directory");

	await expect(runBackfill({ stateDir, dryRun: true })).rejects.toBeInstanceOf(ReceiptsDirUnreadable);
});

test("runBackfill: a genuinely-missing receipts dir (ENOENT) still degrades to zero scanned, not an error", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "backfill-enoent-"));
	tmps.push(stateDir);
	const report = await runBackfill({ stateDir, dryRun: true });
	expect(report.filesScanned).toBe(0);
});

// ── Delta-verify round: per-file read errors (Residual 1) ────────────────────────────────────

test("runBackfill: a receipts/a.jsonl file that exists but is UNREADABLE (mode 0000, EACCES) throws ReceiptFileUnreadable — never silently skipped", async () => {
	if (process.getuid?.() === 0) return; // root ignores file permission bits — this test needs a non-root process to observe EACCES
	const stateDir = await tmpStateDir();
	await writeRawLines(stateDir, "a1", [baseReceipt({ agentId: "a1", harness: undefined })]);
	const file = receiptPath(stateDir, "a1");
	await fs.chmod(file, 0o000);
	try {
		await expect(runBackfill({ stateDir, dryRun: true })).rejects.toBeInstanceOf(ReceiptFileUnreadable);
	} finally {
		await fs.chmod(file, 0o644); // restore so the tmpdir cleanup in afterAll can actually remove it
	}
});

test("runBackfill: an unreadable file blocks the WHOLE run (never reports partial success) — a sibling that WOULD have been processed doesn't hide it", async () => {
	if (process.getuid?.() === 0) return;
	const stateDir = await tmpStateDir();
	await writeRawLines(stateDir, "unreadable", [baseReceipt({ agentId: "unreadable", harness: undefined })]);
	await writeRawLines(stateDir, "normal", [baseReceipt({ agentId: "normal", harness: undefined })]);
	const file = receiptPath(stateDir, "unreadable");
	await fs.chmod(file, 0o000);
	try {
		const err = await runBackfill({ stateDir, dryRun: true }).catch((e) => e);
		expect(err).toBeInstanceOf(ReceiptFileUnreadable);
		expect((err as ReceiptFileUnreadable).file).toContain("unreadable");
	} finally {
		await fs.chmod(file, 0o644);
	}
});

// ── Round 3: mode preservation widened to special bits (Finding 4) ──────────────────────────────

/** Bun 1.3.14's `fs.chmod`/`FileHandle.chmod` silently drops the setgid bit even under
 *  conditions where the real `chmod(1)` binary (and Node's `fs.promises.chmod`) succeed — a
 *  confirmed Bun runtime bug, not a POSIX restriction. Test SETUP needs a genuinely-02750 fixture
 *  regardless of that bug, so it shells out too, exactly like `chmodLikeSource` (the production
 *  workaround this test is verifying) does. */
async function chmodViaShell(file: string, mode: number): Promise<void> {
	const proc = Bun.spawn(["chmod", (mode & 0o7777).toString(8).padStart(4, "0"), file], { stdout: "ignore", stderr: "ignore" });
	if ((await proc.exited) !== 0) throw new Error(`test setup: chmod failed for ${file}`);
}

test("writeIfUnchanged: preserves SPECIAL mode bits (setgid) too, not just permission bits — 02750 fixture", async () => {
	const stateDir = await tmpStateDir();
	await writeRawLines(stateDir, "a1", [baseReceipt({ agentId: "a1" })]);
	const file = receiptPath(stateDir, "a1");
	await chmodViaShell(file, 0o2750);
	const before = await fs.stat(file);
	expect(before.mode & 0o7777).toBe(0o2750); // setup sanity check — proves the fixture is genuinely 02750

	const result = await writeIfUnchanged(file, `${JSON.stringify(baseReceipt({ agentId: "a1", harnessUnattributableReason: "no_run_scoped_harness_evidence" }))}\n`, before);
	expect(result.written).toBe(true);

	const after = await fs.stat(file);
	expect(after.mode & 0o7777).toBe(0o2750); // writeIfUnchanged's own chmodLikeSource preserved it across the rewrite
});

// ── Round 3: argv rejects a --state-dir value that looks like another flag (Finding 5) ───────────

test("CLI argv: --state-dir followed by a --dry-run-shaped token is rejected, not silently accepted as a directory named --dry-run", async () => {
	// parseArgs isn't exported (it's the CLI-only entry point) — drive the same failure through the
	// actual binary via Bun.spawn, matching codex's own counterexample invocation shape.
	const proc = Bun.spawn(["bun", "scripts/backfill-receipt-attribution.ts", "--state-dir", "--dry-run"], {
		cwd: path.join(import.meta.dir, ".."),
		stdout: "ignore",
		stderr: "pipe",
	});
	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;
	expect(code).not.toBe(0);
	expect(stderr).toMatch(/--state-dir requires a directory path/);
});

// ── Round 3: the lock is genuinely HELD during the write phase (Finding 6 — test gap) ────────────

/** Runs tests/fixtures/lock-probe-child.ts (a SEPARATE process — see its own doc for why an
 *  in-process second `acquireStateLock` call can't prove this: same-pid reuse-detection would
 *  reclaim it) and returns its exit code: 0 = acquired, 1 = blocked by a live owner. */
async function probeLockFromChildProcess(stateDir: string): Promise<number> {
	const proc = Bun.spawn(["bun", path.join(import.meta.dir, "fixtures", "lock-probe-child.ts"), stateDir], { stdout: "ignore", stderr: "inherit" });
	return proc.exited;
}

test("runBackfill: the real lock is HELD for the whole pass — a concurrent acquireStateLock attempt from ANOTHER PROCESS fails while runBackfill is mid-pass", async () => {
	const stateDir = await tmpStateDir();
	await writeRawLines(stateDir, "a1", [baseReceipt({ agentId: "a1", harness: undefined })]);

	let releaseBarrier!: () => void;
	const barrier = new Promise<void>((resolve) => {
		releaseBarrier = resolve;
	});

	const runPromise = runBackfill({ stateDir, dryRun: true, onLockHeld: () => barrier });

	// Give runBackfill a moment to actually acquire the lock and enter the barrier — the acquire
	// itself is effectively synchronous here (no live owner to wait out), so this is generous, not
	// load-bearing precision.
	await new Promise((r) => setTimeout(r, 50));

	// A version with the real acquireStateLock call deleted would let this SUCCEED — that's
	// exactly the test gap round 3 found in round 2's "acquires and releases" test. Must be a
	// DIFFERENT process: an in-process second acquire would share this test's own pid and get
	// reclaimed as "our own stale record" by acquireStateLock's reuse-detection.
	expect(await probeLockFromChildProcess(stateDir)).toBe(1); // blocked

	releaseBarrier();
	await runPromise;

	// Released afterward: a normal acquire (even from a fresh child process) now succeeds again.
	expect(await probeLockFromChildProcess(stateDir)).toBe(0);
});

// ── Delta-verify round: pin ATOMIC rename, not just "the inode changed" (Residual 2) ─────────────
//
// The round-3 inode-only assertion below is real but INSUFFICIENT: a non-atomic
// `unlink(file); link(tmp, file); unlink(tmp)` sequence ALSO changes the destination's inode and
// would pass it, while reopening a genuine missing-file window. The stronger test polls the
// destination continuously during the write and requires it to be statable at every single poll
// — true by construction for a real `rename(2)` (which replaces the destination atomically, in
// one step — there is no window for an unlink-then-link race to hide in), false for the
// non-atomic alternative. The inode check is kept as secondary, non-load-bearing evidence.

test("writeIfUnchanged: the destination path is NEVER momentarily unstatable during the write — pins ATOMIC rename, not just an inode side effect", async () => {
	const stateDir = await tmpStateDir();
	await writeRawLines(stateDir, "a1", [baseReceipt({ agentId: "a1" })]);
	const file = receiptPath(stateDir, "a1");
	const before = await fs.stat(file);

	let sawMissing = false;
	let polling = true;
	const pollLoop = (async () => {
		while (polling) {
			try {
				await fs.stat(file);
			} catch {
				sawMissing = true;
				break;
			}
			// Yield as tightly as the event loop allows — setImmediate fires between I/O phases, so
			// this gets maximum scheduling opportunities across writeIfUnchanged's real async gaps
			// (temp-file write, the chmodLikeSource subprocess spawn+exit, fsync, the rename itself).
			// A real rename has NO window to observe; a hypothetical unlink-then-link regression does,
			// however brief, and this loop is tuned to catch it.
			await new Promise((r) => setImmediate(r));
		}
	})();

	const result = await writeIfUnchanged(file, `${JSON.stringify(baseReceipt({ agentId: "a1", harnessUnattributableReason: "no_run_scoped_harness_evidence" }))}\n`, before);
	polling = false;
	await pollLoop;

	expect(result.written).toBe(true);
	expect(sawMissing).toBe(false); // the destination was ALWAYS statable throughout — the actual atomicity guarantee

	// Secondary, non-load-bearing corroboration (round 3): a genuinely new inode, consistent with
	// replacement rather than an in-place content overwrite of the SAME inode.
	const after = await fs.stat(file);
	expect(after.ino).not.toBe(before.ino);
});
