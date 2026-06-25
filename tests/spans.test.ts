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
	expect(sampledOut.spans).toBeUndefined();

	const kept = acc.snapshot({ includeSpans: true });
	expect(kept.spans?.map((s) => s.kind)).toContain("run");
	expect(kept.spans?.some((s) => s.name === "node:plan")).toBe(true);
	expect(kept.spans?.some((s) => s.name === "tool:read" && s.status === "ok")).toBe(true);
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
