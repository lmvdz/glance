/**
 * report-tool.test.ts — the agent-facing squad_report host tool (Epic 5 HITL safeguards, leaf 05).
 * Drives the private `handleReportTool` seam directly (same pattern as kb-tool.test.ts) to prove the
 * primitive is genuinely NON-blocking (DESIGN.md D2): it responds to the agent immediately, appends to
 * the separate `AgentDTO.reports` channel, and never touches `pending` or flips `status` to "input" —
 * unlike the blocking `onHostTool` pending path.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SquadManager } from "../src/squad-manager.ts";
import type { AgentReport } from "../src/types.ts";

const tmps: string[] = [];
const managers: SquadManager[] = [];

afterEach(async () => {
	for (const m of managers) await m.stop().catch(() => {});
	managers.length = 0;
	for (const t of tmps) await fs.rm(t, { recursive: true, force: true }).catch(() => {});
	tmps.length = 0;
});

async function mgr(): Promise<{ mgr: SquadManager; repo: string }> {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "report-tool-state-"));
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "report-tool-repo-"));
	tmps.push(stateDir, repo);
	const m = new SquadManager({ stateDir });
	managers.push(m);
	return { mgr: m, repo };
}

/** Minimal AgentRecord stand-in carrying just what handleReportTool touches. */
function fakeRec(repo: string, capture: { tool?: { text: string; isError: boolean } }) {
	return {
		dto: { id: "fake-1", name: "fake", status: "working", repo, worktree: "/w", pending: [], lastActivity: 0 },
		agent: { respondHostTool: (_id: string, text: string, isError = false) => { capture.tool = { text, isError }; } },
		options: { repo, name: "fake" },
		transcript: [],
		assistantBuf: "",
		thinkingBuf: "",
		streaming: false,
		subs: {},
		toolEntries: new Map(),
	} as any;
}

test("squad_report responds immediately (non-error) and appends to the non-blocking reports channel", async () => {
	const { mgr: m, repo } = await mgr();
	const cap: { tool?: { text: string; isError: boolean } } = {};
	const rec = fakeRec(repo, cap);
	await (m as unknown as { handleReportTool: (r: unknown, c: unknown) => Promise<void> })
		.handleReportTool(rec, { id: "call-1", arguments: { summary: "unsure about the migration approach", proposal: "try approach B instead", confidence: 0.3 } });

	// Responds right away — the agent's next turn can proceed, unlike a confirm/input pending.
	expect(cap.tool).toBeDefined();
	expect(cap.tool!.isError).toBeFalsy();

	const reports = rec.dto.reports as AgentReport[] | undefined;
	expect(reports).toHaveLength(1);
	expect(reports![0].summary).toBe("unsure about the migration approach");
	expect(reports![0].proposal).toBe("try approach B instead");
	expect(reports![0].confidence).toBe(0.3);

	// Non-blocking, by construction: never touches pending or status.
	expect(rec.dto.pending).toEqual([]);
	expect(rec.dto.status).toBe("working");
});

test("squad_report with an empty summary returns a usage error and appends nothing", async () => {
	const { mgr: m, repo } = await mgr();
	const cap: { tool?: { text: string; isError: boolean } } = {};
	const rec = fakeRec(repo, cap);
	await (m as unknown as { handleReportTool: (r: unknown, c: unknown) => Promise<void> })
		.handleReportTool(rec, { id: "call-1", arguments: {} });

	expect(cap.tool!.isError).toBe(true);
	expect(cap.tool!.text).toContain("usage: squad_report");
	expect(rec.dto.reports ?? []).toHaveLength(0);
});

test("a second squad_report call appends (does not replace) — the channel is append-only", async () => {
	const { mgr: m, repo } = await mgr();
	const cap: { tool?: { text: string; isError: boolean } } = {};
	const rec = fakeRec(repo, cap);
	const handle = (m as unknown as { handleReportTool: (r: unknown, c: unknown) => Promise<void> }).handleReportTool.bind(m);
	await handle(rec, { id: "c1", arguments: { summary: "first concern" } });
	await handle(rec, { id: "c2", arguments: { summary: "second concern" } });

	const reports = rec.dto.reports as AgentReport[] | undefined;
	expect(reports).toHaveLength(2);
	expect(reports!.map((r) => r.summary)).toEqual(["first concern", "second concern"]);
});
