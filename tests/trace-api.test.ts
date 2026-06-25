import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendAudit, makeAuditEntry } from "../src/audit.ts";
import { appendReceipt } from "../src/receipts.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer } from "../src/server.ts";
import type { RunReceipt } from "../src/types.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

test("GET /api/trace/:id returns receipt rollups plus audit-derived lifecycle spans", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trace-api-"));
	const receipt: RunReceipt = { agentId: "a1", name: "alpha", repo: "/repo", runId: "r1", startedAt: 1, endedAt: 2, durationMs: 1, status: "idle", toolCalls: 1, toolTally: { read: 1 }, costUsd: 0.25, filesTouched: [], traceId: "feat:f1", featureId: "f1" };
	await appendReceipt(dir, receipt);
	await appendAudit(dir, makeAuditEntry({ actor: "op", action: "land", target: "f1" }, 3));

	const mgr = new SquadManager({ stateDir: dir });
	const server = new SquadServer(mgr, { port: 0 });
	const url = server.start();
	cleanups.push(() => server.stop(), () => fs.rm(dir, { recursive: true, force: true }));

	const res = await fetch(`${url}/api/trace/f1`);
	expect(res.status).toBe(200);
	const trace = await res.json() as { traceId: string; rollup: { runs: number; costUsd: number }; root: { children: Array<{ kind: string }> } };
	expect(trace.traceId).toBe("feat:f1");
	expect(trace.rollup.runs).toBe(1);
	expect(trace.rollup.costUsd).toBe(0.25);
	expect(trace.root.children.some((n) => n.kind === "land")).toBe(true);

	expect((await fetch(`${url}/api/trace/missing`)).status).toBe(404);
});
