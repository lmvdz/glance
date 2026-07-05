/**
 * D2: buildProvenance's `verify` field — the most recent `verify` audit entry targeting one of the
 * ticket thread's run agents, surfaced for the Inspector's ticket pane (Epic 4 leaf 02/05).
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendAudit, makeAuditEntry } from "../src/audit.ts";
import { buildProvenance } from "../src/omp-graph/provenance.ts";
import { appendReceipt } from "../src/receipts.ts";
import type { RunReceipt } from "../src/types.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

test("(D2) buildProvenance surfaces the most recent verify audit entry for the ticket's run agents", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "provenance-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));

	const receipt: RunReceipt = { agentId: "a1", name: "alpha", repo: "/repo", runId: "r1", startedAt: 1, endedAt: 2, durationMs: 1, status: "idle", toolCalls: 1, toolTally: {}, filesTouched: [], featureId: "f1" };
	await appendReceipt(dir, receipt);
	await appendAudit(dir, makeAuditEntry({ actor: "op", action: "verify", target: "a1", outcome: "ok" }, 10));
	await appendAudit(dir, makeAuditEntry({ actor: "op2", action: "verify", target: "a1", outcome: "error" }, 20));

	const doc = await buildProvenance({
		repo: "/repo",
		stateDir: dir,
		ticket: "TICK-1",
		features: [{ id: "f1", title: "Feature one", issueIdentifiers: ["TICK-1"] }],
		gitLog: async () => [],
	});

	expect(doc.runs.some((r) => r.agentId === "a1")).toBe(true);
	expect(doc.verify).toBeDefined();
	expect(doc.verify?.actor).toBe("op2"); // most recent (at:20) wins
	expect(doc.verify?.outcome).toBe("error");
});

test("(D2) buildProvenance leaves verify undefined when no verify audit targets this thread's agents", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "provenance-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));

	const receipt: RunReceipt = { agentId: "a2", name: "beta", repo: "/repo", runId: "r2", startedAt: 1, endedAt: 2, durationMs: 1, status: "idle", toolCalls: 0, toolTally: {}, filesTouched: [], featureId: "f2" };
	await appendReceipt(dir, receipt);

	const doc = await buildProvenance({
		repo: "/repo",
		stateDir: dir,
		ticket: "TICK-2",
		features: [{ id: "f2", title: "Feature two", issueIdentifiers: ["TICK-2"] }],
		gitLog: async () => [],
	});

	expect(doc.verify).toBeUndefined();
});
