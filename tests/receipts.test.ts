/**
 * Receipt ledger: drive the pure accumulator through a synthetic frame
 * sequence mirroring a real run, then round-trip the JSONL persistence.
 * No model tokens, no manager/omp spawn, no fixtures.
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendReceipt, ingest, readReceipts, receiptPath, RunAccumulator } from "../src/receipts.ts";

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

test("readReceipts returns [] for an unknown agent", async () => {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "receipts-"));
	tmps.push(baseDir);
	expect(await readReceipts(baseDir, "nope")).toEqual([]);
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
