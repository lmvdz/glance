/**
 * Receipt ledger: drive the pure accumulator through a synthetic frame
 * sequence mirroring a real run, then round-trip the JSONL persistence.
 * No model tokens, no manager/omp spawn, no fixtures.
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendReceipt, confirmDeliveredFlags, ingest, readAllReceipts, readReceipts, receiptPath, RunAccumulator, splitCapabilityTokens, unitEfficiencyFlags } from "../src/receipts.ts";
import type { RunReceipt } from "../src/types.ts";

const tmps: string[] = [];

afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

function feed(acc: RunAccumulator, frames: Array<Record<string, unknown>>): void {
	for (const f of frames) ingest(acc, f);
}

const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { total: 0.0021 } };

test("snapshot + rollup over a synthetic run", () => {
	const acc = new RunAccumulator({ agentId: "ag1", name: "alpha", repo: "/repo", branch: "feat", model: "opus" });
	feed(acc, [
		{ type: "agent_start" },
		{ type: "tool_execution_start", toolName: "edit" },
		{ type: "tool_execution_start", toolName: "bash" },
		{ type: "message_end", message: { role: "assistant", usage } },
		{ type: "message_end", message: { role: "assistant", usage } },
		{ type: "tool_execution_start", toolName: "edit" },
		{ type: "agent_end" },
	]);
	acc.finish("idle", ["src/a.ts", "src/b.ts"]);

	const snap = acc.snapshot();
	expect(snap.toolCalls).toBe(3);
	expect(snap.toolTally.edit).toBe(2);
	expect(snap.toolTally.bash).toBe(1);
	expect(snap.tokens?.input).toBe(200);
	expect(snap.tokens?.total).toBe(300);
	expect(snap.costUsd).toBeCloseTo(0.0042, 10);
	expect(snap.filesTouched.length).toBe(2);
	expect(typeof snap.durationMs).toBe("number");
	expect(snap.status).toBe("idle");

	const roll = acc.rollup();
	expect(roll.toolCalls).toBe(3);
	expect(roll.costUsd).toBeCloseTo(0.0042, 10);
	expect(typeof roll.durationMs).toBe("number");
	expect(typeof roll.endedAt).toBe("number");
});

test("JSONL persistence round-trip", async () => {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "receipts-"));
	tmps.push(baseDir);

	const acc = new RunAccumulator({ agentId: "ag2", name: "beta", repo: "/repo" });
	feed(acc, [{ type: "agent_start" }, { type: "tool_execution_start", toolName: "read" }, { type: "agent_end" }]);
	acc.finish("idle", []);
	const first = acc.snapshot();

	const acc2 = new RunAccumulator({ agentId: "ag2", name: "beta", repo: "/repo" });
	feed(acc2, [{ type: "agent_start" }, { type: "tool_execution_start", toolName: "bash" }, { type: "agent_end" }]);
	acc2.finish("stopped", ["x.ts"]);
	const second = acc2.snapshot();

	await appendReceipt(baseDir, first);
	await appendReceipt(baseDir, second);

	const back = await readReceipts(baseDir, "ag2");
	expect(back.length).toBe(2);
	expect(back[0].runId).toBe(first.runId);
	expect(back[1]).toEqual(second);

	const text = await fs.readFile(receiptPath(baseDir, "ag2"), "utf8");
	expect(receiptPath(baseDir, "ag2").endsWith(path.join("receipts", "ag2.jsonl"))).toBe(true);
	const lines = text.split("\n").filter((l) => l.trim());
	expect(JSON.parse(lines[lines.length - 1])).toEqual(second);
});

test("readReceipts tolerates a crash-torn tail line instead of throwing", async () => {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "receipts-"));
	tmps.push(baseDir);

	const acc = new RunAccumulator({ agentId: "ag3", name: "gamma", repo: "/repo" });
	feed(acc, [{ type: "agent_start" }, { type: "agent_end" }]);
	acc.finish("idle", []);
	const good = acc.snapshot();
	await appendReceipt(baseDir, good);

	// Simulate a host crash mid-append: a half-written JSONL line with no trailing newline.
	await fs.appendFile(receiptPath(baseDir, "ag3"), '{"agentId":"ag3","runId":"torn","started');

	// Must NOT throw — a single torn line otherwise 500s every receipts-backed endpoint.
	const back = await readReceipts(baseDir, "ag3");
	expect(back.length).toBe(1);
	expect(back[0].runId).toBe(good.runId);

	const all = await readAllReceipts(baseDir);
	expect(all.length).toBe(1);
});

test("readReceipts returns [] for an unknown agent", async () => {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "receipts-"));
	tmps.push(baseDir);
	expect(await readReceipts(baseDir, "nope")).toEqual([]);
});

test("a RunReceipt carrying a validation record (Epic 3) round-trips through JSONL persistence", async () => {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "receipts-"));
	tmps.push(baseDir);

	const acc = new RunAccumulator({ agentId: "ag4", name: "delta", repo: "/repo", branch: "feat" });
	feed(acc, [{ type: "agent_start" }, { type: "agent_end" }]);
	acc.finish("idle", []);
	const receipt = acc.snapshot();
	receipt.validation = {
		verdict: "veto",
		agreement: 0.5,
		confidence: 0.8,
		perCriterion: [
			{ id: "c1", satisfied: true },
			{ id: "c2", satisfied: false, note: "auth missing" },
		],
		rationale: "auth criterion not met",
		model: "opus",
		ranAt: 1000,
	};

	await appendReceipt(baseDir, receipt);
	const back = await readReceipts(baseDir, "ag4");
	expect(back.length).toBe(1);
	expect(back[0].validation).toEqual(receipt.validation);
	expect(back[0].validation?.verdict).toBe("veto");
});

test("late-binds the effective model off an assistant frame when seed.model is unset", () => {
	const acc = new RunAccumulator({ agentId: "ag5", name: "epsilon", repo: "/repo" });
	feed(acc, [
		{ type: "agent_start" },
		{ type: "message_end", message: { role: "assistant", usage, model: "claude-sonnet-4-5" } },
		{ type: "agent_end" },
	]);
	acc.finish("idle", []);

	const snap = acc.snapshot();
	expect(snap.model).toBe("claude-sonnet-4-5");
});

test("an explicit opts.model stays authoritative over a later assistant frame's model", () => {
	const acc = new RunAccumulator({ agentId: "ag6", name: "zeta", repo: "/repo", model: "opus" });
	feed(acc, [
		{ type: "agent_start" },
		{ type: "message_end", message: { role: "assistant", usage, model: "claude-sonnet-4-5" } },
		{ type: "agent_end" },
	]);
	acc.finish("idle", []);

	const snap = acc.snapshot();
	expect(snap.model).toBe("opus");
});

test("readReceipts parses a pre-attribution-fix receipt (no model/harness fields at all)", async () => {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "receipts-"));
	tmps.push(baseDir);

	// A historical receipt shape (predates the harness field / model backfill) — no `model`, no
	// `harness` key at all, not even `undefined`. Every reader (scoreboard, attribution, /api/usage)
	// must keep working against the old backlog of receipts on disk.
	const legacy = { agentId: "ag-legacy", name: "old", repo: "/repo", runId: "r1", startedAt: 1, status: "idle", toolCalls: 0, toolTally: {}, filesTouched: [] };
	await fs.mkdir(path.join(baseDir, "receipts"), { recursive: true });
	await fs.writeFile(path.join(baseDir, "receipts", "ag-legacy.jsonl"), `${JSON.stringify(legacy)}\n`);

	const back = await readReceipts(baseDir, "ag-legacy");
	expect(back.length).toBe(1);
	expect(back[0].model).toBeUndefined();
	expect(back[0].harness).toBeUndefined();
	expect(back[0].agentId).toBe("ag-legacy");
});

// ── concern 02: delivery-confirmed efficiencyFlags ──────────────────────────────────────────────

test("splitCapabilityTokens: separates membrane:* tokens from real tool grants", () => {
	const { toolGrants, requested } = splitCapabilityTokens(["read", "membrane:verdict-first", "bash", "membrane:minimal-code"]);
	expect(toolGrants).toEqual(["read", "bash"]);
	expect(requested).toEqual(["membrane:verdict-first", "membrane:minimal-code"]);
});

test("splitCapabilityTokens: an all-tools capabilities array leaves requested undefined (no behavior change)", () => {
	const { toolGrants, requested } = splitCapabilityTokens(["read", "bash"]);
	expect(toolGrants).toEqual(["read", "bash"]);
	expect(requested).toBeUndefined();
});

test("splitCapabilityTokens: an all-membrane capabilities array leaves toolGrants undefined (isolation)", () => {
	const { toolGrants, requested } = splitCapabilityTokens(["membrane:verdict-first"]);
	expect(toolGrants).toBeUndefined();
	expect(requested).toEqual(["membrane:verdict-first"]);
});

test("splitCapabilityTokens: undefined/empty capabilities → both undefined", () => {
	expect(splitCapabilityTokens(undefined)).toEqual({ toolGrants: undefined, requested: undefined });
	expect(splitCapabilityTokens([])).toEqual({ toolGrants: undefined, requested: undefined });
});

test("confirmDeliveredFlags: native contextInjection confirms the requested flags", () => {
	expect(confirmDeliveredFlags(["membrane:verdict-first"], "native")).toEqual(["membrane:verdict-first"]);
});

test("confirmDeliveredFlags: ACP contextInjection \"none\" drops the request — never a placebo stamp", () => {
	expect(confirmDeliveredFlags(["membrane:verdict-first"], "none")).toBeUndefined();
});

test("confirmDeliveredFlags: \"mcp\" contextInjection also does not confirm an appendSystemPrompt-delivered flag", () => {
	expect(confirmDeliveredFlags(["membrane:verdict-first"], "mcp")).toBeUndefined();
});

test("confirmDeliveredFlags: nothing requested → undefined regardless of contextInjection", () => {
	expect(confirmDeliveredFlags(undefined, "native")).toBeUndefined();
	expect(confirmDeliveredFlags([], "native")).toBeUndefined();
});

function receipt(overrides: Partial<RunReceipt>): RunReceipt {
	return { agentId: "unit-1", name: "unit", repo: "/repo", runId: "r", startedAt: 0, status: "idle", toolCalls: 0, toolTally: {}, filesTouched: [], ...overrides };
}

test("unitEfficiencyFlags: every run confirms the same flag → that flag, no mixed marker", () => {
	const runs = [receipt({ efficiencyFlags: ["membrane:verdict-first"] }), receipt({ efficiencyFlags: ["membrane:verdict-first"] })];
	expect(unitEfficiencyFlags(runs)).toEqual(["membrane:verdict-first"]);
});

test("unitEfficiencyFlags: no run ever had a flag → empty array, not mixed", () => {
	const runs = [receipt({}), receipt({})];
	expect(unitEfficiencyFlags(runs)).toEqual([]);
});

test("unitEfficiencyFlags: a mixed-run unit (one confirmed, one not) gets the mixed marker", () => {
	const runs = [receipt({ efficiencyFlags: ["membrane:verdict-first"] }), receipt({ efficiencyFlags: undefined })];
	expect(unitEfficiencyFlags(runs)).toEqual(["mixed"]);
});

test("unitEfficiencyFlags: two runs confirming DIFFERENT flag sets also get the mixed marker", () => {
	const runs = [receipt({ efficiencyFlags: ["membrane:verdict-first"] }), receipt({ efficiencyFlags: ["membrane:minimal-code"] })];
	expect(unitEfficiencyFlags(runs)).toEqual(["mixed"]);
});

test("unitEfficiencyFlags: no runs → empty array", () => {
	expect(unitEfficiencyFlags([])).toEqual([]);
});

test("RunAccumulator: seed.efficiencyFlags rides through snapshot() onto the receipt (native harness)", () => {
	const acc = new RunAccumulator({ agentId: "ag7", name: "eta", repo: "/repo", efficiencyFlags: ["membrane:verdict-first"] });
	feed(acc, [{ type: "agent_start" }, { type: "agent_end" }]);
	acc.finish("idle", []);
	expect(acc.snapshot().efficiencyFlags).toEqual(["membrane:verdict-first"]);
});

test("RunAccumulator: an unset seed.efficiencyFlags (ACP-none delivery) leaves the receipt flagless", () => {
	const acc = new RunAccumulator({ agentId: "ag8", name: "theta", repo: "/repo" });
	feed(acc, [{ type: "agent_start" }, { type: "agent_end" }]);
	acc.finish("idle", []);
	expect(acc.snapshot().efficiencyFlags).toBeUndefined();
});

test("graceful no-usage case: tokens/costUsd omitted", () => {
	const acc = new RunAccumulator({ agentId: "ag3", name: "gamma", repo: "/repo" });
	feed(acc, [{ type: "agent_start" }, { type: "tool_execution_start", toolName: "search" }, { type: "agent_end" }]);
	acc.finish("idle", []);

	const snap = acc.snapshot();
	expect(snap.tokens).toBeUndefined();
	expect(snap.costUsd).toBeUndefined();
	expect(snap.toolCalls).toBe(1);
	expect(acc.rollup().costUsd).toBeUndefined();
});
