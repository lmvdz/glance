/**
 * kb-tool.test.ts — the agent-facing squad_kb_search host tool, end-to-end through
 * the real manager (minus the omp child): registration via set_host_tools, and the
 * onHostTool → handleKbSearchTool → fabric → searchFabric → respondHostTool path.
 *
 * Driving the private seams with a fake driver lets us prove the whole chain
 * deterministically — a live omp host can't cold-start reliably under test load.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SquadManager } from "../src/squad-manager.ts";
import type { HostToolDef } from "../src/agent-driver.ts";

const tmps: string[] = [];
const managers: SquadManager[] = [];

afterEach(async () => {
	for (const m of managers) await m.stop().catch(() => {});
	managers.length = 0;
	for (const t of tmps) await fs.rm(t, { recursive: true, force: true }).catch(() => {});
	tmps.length = 0;
});

async function mgrWithDecision(): Promise<{ mgr: SquadManager; repo: string }> {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "kb-state-"));
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "kb-repo-"));
	tmps.push(stateDir, repo);
	const mgr = new SquadManager({ stateDir });
	managers.push(mgr);
	const pf = mgr.createFeature({ title: "Auth tokens", repo, planDir: "plans/auth" });
	await mgr.updateFeature(pf.id, { repo, decisions: [{ id: "d1", text: "Use rotating refresh tokens with a 15-minute access TTL.", source: "human" }] });
	return { mgr, repo };
}

/** Minimal AgentRecord stand-in carrying just what onHostTool/handleKbSearchTool touch. */
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

test("squad_kb_search returns ranked KB facts (the seeded decision) to the calling agent", async () => {
	const { mgr, repo } = await mgrWithDecision();
	const cap: { tool?: { text: string; isError: boolean } } = {};
	const rec = fakeRec(repo, cap);
	await (mgr as unknown as { handleKbSearchTool: (r: unknown, c: unknown) => Promise<void> })
		.handleKbSearchTool(rec, { id: "call-1", arguments: { query: "refresh token rotation" } });
	expect(cap.tool).toBeDefined();
	expect(cap.tool!.isError).toBeFalsy();
	expect(cap.tool!.text).toContain("rotating refresh tokens");
	expect(cap.tool!.text).toContain("[decision]");
});

test("squad_kb_search with an empty query returns a usage error", async () => {
	const { mgr, repo } = await mgrWithDecision();
	const cap: { tool?: { text: string; isError: boolean } } = {};
	await (mgr as unknown as { handleKbSearchTool: (r: unknown, c: unknown) => Promise<void> })
		.handleKbSearchTool(fakeRec(repo, cap), { id: "c", arguments: {} });
	expect(cap.tool!.isError).toBe(true);
	expect(cap.tool!.text).toContain("usage: squad_kb_search");
});

test("squad_kb_search reports no-match cleanly", async () => {
	const { mgr, repo } = await mgrWithDecision();
	const cap: { tool?: { text: string; isError: boolean } } = {};
	await (mgr as unknown as { handleKbSearchTool: (r: unknown, c: unknown) => Promise<void> })
		.handleKbSearchTool(fakeRec(repo, cap), { id: "c", arguments: { query: "kubernetes helm chart" } });
	expect(cap.tool!.isError).toBeFalsy();
	expect(cap.tool!.text).toContain("No matching context");
});

test("registerHostTools advertises squad_kb_search + squad_message + squad_report to an omp agent", async () => {
	const { mgr, repo } = await mgrWithDecision();
	let registered: HostToolDef[] | null = null;
	const rec = { dto: { id: "r2", repo }, options: {}, agent: { setHostTools: (t: HostToolDef[]) => { registered = t; } } } as any;
	(mgr as unknown as { registerHostTools: (r: unknown) => void }).registerHostTools(rec);
	expect(registered).not.toBeNull();
	// squad_report: Epic 5's non-blocking "I'm unsure, here's a proposal" host tool (DESIGN.md D2).
	expect(registered!.map((t) => t.name).sort()).toEqual(["squad_kb_search", "squad_message", "squad_report"].sort());
	const kb = registered!.find((t) => t.name === "squad_kb_search")!;
	expect((kb.parameters as { required?: string[] }).required).toContain("query");
});

test("registerHostTools is a no-op for a non-omp (acp) runtime", async () => {
	const { mgr, repo } = await mgrWithDecision();
	let called = false;
	const rec = { dto: { id: "r3", repo }, options: { runtime: "acp" }, agent: { setHostTools: () => { called = true; } } } as any;
	(mgr as unknown as { registerHostTools: (r: unknown) => void }).registerHostTools(rec);
	expect(called).toBe(false);
});
