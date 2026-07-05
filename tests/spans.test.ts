import { expect, test } from "bun:test";
import { buildTrace, capSpans, shouldKeepSpans } from "../src/spans.ts";
import { ingest, RunAccumulator } from "../src/receipts.ts";
import type { AuditEntry, RunReceipt } from "../src/types.ts";

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0.01 } };

test("RunAccumulator attaches traceId and tail-sampled spans while rollup stays lossless", () => {
	const acc = new RunAccumulator({ agentId: "a1", name: "alpha", repo: "/repo", featureId: "feat-1", parentId: "root" });
	ingest(acc, { type: "agent_start" });
	ingest(acc, { type: "tool_execution_start", toolName: "stage", intent: "plan" });
	ingest(acc, { type: "tool_execution_start", toolName: "read" });
	ingest(acc, { type: "message_end", message: { role: "assistant", usage } });
	acc.finish("idle", ["x.ts"]);

	const sampledOut = acc.snapshot({ sampleRatio: 0, random: () => 0.99 });
	expect(sampledOut.traceId).toBe("feat:feat-1");
	expect(sampledOut.toolCalls).toBe(2);
	expect(sampledOut.tokens?.total).toBe(3);
	// D1: the structural spine (run/node) always survives sampling; only `tool` spans are dropped, and
	// `sampled` records that honestly instead of leaving the receipt spanless.
	expect(sampledOut.spans?.map((s) => s.kind)).toContain("run");
	expect(sampledOut.spans?.some((s) => s.name === "node:plan")).toBe(true);
	expect(sampledOut.spans?.some((s) => s.kind === "tool")).toBe(false);
	expect(sampledOut.sampled).toBe(true);

	const kept = acc.snapshot({ includeSpans: true });
	expect(kept.spans?.map((s) => s.kind)).toContain("run");
	expect(kept.spans?.some((s) => s.name === "node:plan")).toBe(true);
	expect(kept.spans?.some((s) => s.name === "tool:read" && s.status === "ok")).toBe(true);
});

test("D1: a tail-sampled receipt still makes buildTrace's partial flip to false (structural spine present)", () => {
	const acc = new RunAccumulator({ agentId: "a2", name: "beta", repo: "/repo" });
	ingest(acc, { type: "agent_start" });
	ingest(acc, { type: "tool_execution_start", toolName: "read" });
	acc.finish("idle", []);
	const receipt = acc.snapshot({ sampleRatio: 0, random: () => 0.99 });
	expect(receipt.sampled).toBe(true);

	const trace = buildTrace(`run:a2:${receipt.runId}`, [receipt], []);
	expect(trace.partial).toBe(false);
});

test("errors force keeping spans and cap sheds old ok tools before errors/backbone", () => {
	expect(shouldKeepSpans("error", false, 0, () => 0.99)).toBe(true);
	const spans = [
		{ traceId: "t", spanId: "run", name: "run", kind: "run" as const, startedAt: 1, status: "ok" as const },
		{ traceId: "t", spanId: "tool-old", parentSpanId: "run", name: "tool:old", kind: "tool" as const, startedAt: 2, status: "ok" as const },
		{ traceId: "t", spanId: "tool-error", parentSpanId: "run", name: "tool:bad", kind: "tool" as const, startedAt: 3, status: "error" as const },
		{ traceId: "t", spanId: "tool-new", parentSpanId: "run", name: "tool:new", kind: "tool" as const, startedAt: 4, status: "ok" as const },
	];
	expect(capSpans(spans, 3).map((s) => s.spanId)).toEqual(["run", "tool-error", "tool-new"]);
});

test("buildTrace stitches parent runs, audit lifecycle spans, and rolled-up cost", () => {
	const parent: RunReceipt = { agentId: "parent", name: "parent", repo: "/repo", runId: "r1", startedAt: 1, endedAt: 5, durationMs: 4, status: "idle", toolCalls: 1, toolTally: { read: 1 }, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, costUsd: 0.1, filesTouched: [], traceId: "feat:f1", featureId: "f1", spans: [{ traceId: "feat:f1", spanId: "r1:0", name: "run:parent", kind: "run", startedAt: 1, endedAt: 5, status: "ok" }] };
	const child: RunReceipt = { agentId: "child", name: "child", repo: "/repo", runId: "r2", startedAt: 2, endedAt: 4, durationMs: 2, status: "error", toolCalls: 2, toolTally: { bash: 2 }, costUsd: 0.2, filesTouched: [], traceId: "feat:f1", featureId: "f1", parentId: "parent" };
	const audit: AuditEntry = { id: 10, at: 6, actor: "op", action: "land", target: "f1", outcome: "ok" };

	const trace = buildTrace("f1", [child, parent], [audit], ["f1"]);
	expect(trace.traceId).toBe("feat:f1");
	expect(trace.rollup.runs).toBe(2);
	expect(trace.rollup.toolCalls).toBe(3);
	expect(trace.rollup.costUsd).toBeCloseTo(0.3, 10);
	expect(trace.rollup.errors).toBe(1);
	expect(trace.partial).toBe(true);

	const parentNode = trace.root.children.find((n) => n.receipt?.agentId === "parent");
	expect(parentNode?.children.some((n) => n.receipt?.agentId === "child")).toBe(true);
	expect(trace.root.children.some((n) => n.kind === "land" && n.attrs?.operator === "op")).toBe(true);
});

test("(D2) buildTrace weaves verify/spawn audit actions under their target's run node, not as flat root siblings", () => {
	const receipt: RunReceipt = {
		agentId: "a1",
		name: "alpha",
		repo: "/repo",
		runId: "r1",
		startedAt: 1,
		endedAt: 5,
		durationMs: 4,
		status: "idle",
		toolCalls: 0,
		toolTally: {},
		filesTouched: [],
		traceId: "run:a1:r1",
		sampled: false,
		spans: [{ traceId: "run:a1:r1", spanId: "r1:0", name: "run:alpha", kind: "run", startedAt: 1, endedAt: 5, status: "ok" }],
	};
	const spawnAudit: AuditEntry = { id: 1, at: 1, actor: "op", action: "create", target: "a1", outcome: "ok" };
	const verifyAudit: AuditEntry = { id: 2, at: 2, actor: "op", action: "verify", target: "a1", outcome: "ok" };
	const landAudit: AuditEntry = { id: 3, at: 3, actor: "op", action: "land", target: "a1", outcome: "ok" };

	const trace = buildTrace("run:a1:r1", [receipt], [spawnAudit, verifyAudit, landAudit]);
	expect(trace.partial).toBe(false); // D1: structural spine present
	expect(trace.sampled).toBe(false);

	const runNode = trace.root.children.find((n) => n.receipt?.agentId === "a1");
	expect(runNode).toBeDefined();
	expect(runNode?.children.some((n) => n.kind === "spawn")).toBe(true);
	expect(runNode?.children.some((n) => n.kind === "verify")).toBe(true);
	expect(runNode?.children.some((n) => n.kind === "land")).toBe(true);
	// The woven steps are children of the run node, NOT flat root-level siblings.
	expect(trace.root.children.some((n) => n.kind === "verify" || n.kind === "spawn")).toBe(false);
});

test("(D1+D2) TraceResponse.sampled is true when any contributing receipt tail-sampled its tool spans", () => {
	const receipt: RunReceipt = {
		agentId: "a1", name: "alpha", repo: "/repo", runId: "r1", startedAt: 1, endedAt: 2, durationMs: 1,
		status: "idle", toolCalls: 1, toolTally: { read: 1 }, filesTouched: [], traceId: "run:a1:r1", sampled: true,
		spans: [{ traceId: "run:a1:r1", spanId: "r1:0", name: "run:alpha", kind: "run", startedAt: 1, endedAt: 2, status: "ok" }],
	};
	const trace = buildTrace("run:a1:r1", [receipt], []);
	expect(trace.partial).toBe(false);
	expect(trace.sampled).toBe(true);
});
