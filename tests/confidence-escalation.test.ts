/**
 * Epic 5 leaf 06 (low-confidence auto-escalation) — the join of leaves 02 (scorer)+03 (autonomy
 * cap)+05 (report channel), wired at `finalizeRun`'s single seam. Drives a synthetic run through the
 * manager's real `onAgentEvent`/`finalizeRun` (same pattern as squad-manager-subagent-lineage.test.ts)
 * and asserts the brake actually engages: a run finishing below the confidence floor (a) drops
 * `effectiveMode` to `assist` (propose-only — `land` absent from `availableActions`), and (b)
 * auto-emits exactly one non-blocking `AgentReport`, without ever touching `pending` or flipping
 * `status` to "input". A high-confidence run does neither.
 */

import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { AgentDTO, PersistedAgent, RpcSessionState } from "../src/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const savedLandConfirm = process.env.OMP_SQUAD_LAND_CONFIRM;
process.env.OMP_SQUAD_LAND_CONFIRM = "0"; // landConfirm=false, so autoLand:true → automationCap "autodrive" (isolates the confidence cap's effect)

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
	if (savedLandConfirm === undefined) delete process.env.OMP_SQUAD_LAND_CONFIRM;
	else process.env.OMP_SQUAD_LAND_CONFIRM = savedLandConfirm;
});

/** A driver that comes up ready immediately and never replays any frames — only the manager's own
 *  onAgentEvent wiring is exercised (frames are injected directly, not emitted by this driver). */
class ReadyDriver extends EventEmitter implements AgentDriver {
	readonly isReady = true;
	readonly isAlive = true;
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async prompt(): Promise<void> {}
	async abort(): Promise<unknown> {
		return undefined;
	}
	async getState(): Promise<RpcSessionState> {
		return { todoPhases: [], isStreaming: false } as RpcSessionState;
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

interface DriverFactoryHost {
	makeDriver: (p: PersistedAgent, cold?: boolean) => AgentDriver;
}

interface AgentRecordLike {
	dto: AgentDTO;
	options: PersistedAgent;
	run?: unknown;
}

interface ManagerInternals {
	agents: Map<string, AgentRecordLike>;
	onAgentEvent: (rec: AgentRecordLike, frame: { type?: string; [k: string]: unknown }) => void;
	finalizeRun: (rec: AgentRecordLike) => Promise<void>;
}

async function makeMgr(): Promise<{ mgr: SquadManager; repo: string }> {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "confidence-escalation-state-"));
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "confidence-escalation-repo-"));
	tmps.push(stateDir, repo);
	// autoLand + landConfirm=false (env above) → automationCap "autodrive", so a drop to "assist" is
	// attributable to the confidence cap, not some other policy already sitting at "assist".
	const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true, autoLand: true });
	await mgr.start();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new ReadyDriver();
	return { mgr, repo };
}

test("a run finishing below the confidence floor caps effectiveMode to assist and auto-emits exactly one non-blocking report", async () => {
	const { mgr, repo } = await makeMgr();
	const dto = await mgr.create({ name: "low-conf", repo, approvalMode: "yolo", autoRoute: false });
	const internals = mgr as unknown as ManagerInternals;
	const rec = internals.agents.get(dto.id)!;

	// Baseline: a fresh agent has no confidence yet, so the cap is inert — requested autodrive holds.
	expect(rec.dto.effectiveMode).toBe("autodrive");
	expect(rec.dto.status).not.toBe("input");
	expect(rec.dto.pending).toEqual([]);

	// A live run must exist for finalizeRun to act (it early-returns on `!rec.run`).
	internals.onAgentEvent(rec, { type: "agent_start" });
	rec.dto.verificationState = "failed"; // forces scoreConfidence well below the 0.4 default floor

	await internals.finalizeRun(rec);

	expect(rec.dto.confidence).toBeLessThan(0.4);
	expect(rec.dto.reports).toHaveLength(1);
	expect(rec.dto.reports?.[0]?.id).toMatch(/^auto-/);
	expect(rec.dto.reports?.[0]?.confidence).toBe(rec.dto.confidence);
	expect(rec.dto.effectiveMode).toBe("assist"); // capped by leaf 03, driven by the fresh confidence
	expect(rec.dto.availableActions).not.toContain("land");
	// Non-blocking, by construction: the report never touches pending/status.
	expect(rec.dto.pending).toEqual([]);
	expect(rec.dto.status).not.toBe("input");

	// A second finalize (the real agent_end+exit double-fire) is a no-op — `rec.run` is already
	// cleared, so the accumulator's own `finalized` guard short-circuits before any of this leaf's
	// logic runs again. Still one report, not two.
	await internals.finalizeRun(rec);
	expect(rec.dto.reports).toHaveLength(1);

	await mgr.stop();
});

test("a high-confidence run (fresh proof, no files) produces zero auto-reports and keeps its requested mode", async () => {
	const { mgr, repo } = await makeMgr();
	const dto = await mgr.create({ name: "high-conf", repo, approvalMode: "yolo", autoRoute: false });
	const internals = mgr as unknown as ManagerInternals;
	const rec = internals.agents.get(dto.id)!;

	internals.onAgentEvent(rec, { type: "agent_start" });
	rec.dto.verificationState = "fresh";

	await internals.finalizeRun(rec);

	expect(rec.dto.confidence).toBeGreaterThanOrEqual(0.4);
	expect(rec.dto.reports ?? []).toHaveLength(0);
	expect(rec.dto.effectiveMode).toBe("autodrive"); // uncapped — requested mode holds
	expect(rec.dto.availableActions).toContain("land");

	await mgr.stop();
});

test("a later high-confidence run SUPERSEDES the prior run's auto-report (it stops nagging), but keeps agent-raised reports", async () => {
	const { mgr, repo } = await makeMgr();
	const dto = await mgr.create({ name: "supersede", repo, approvalMode: "yolo", autoRoute: false });
	const internals = mgr as unknown as ManagerInternals;
	const rec = internals.agents.get(dto.id)!;

	// Run 1: low confidence → one auto-report appended.
	internals.onAgentEvent(rec, { type: "agent_start" });
	rec.dto.verificationState = "failed";
	await internals.finalizeRun(rec);
	expect(rec.dto.reports).toHaveLength(1);
	expect(rec.dto.reports?.[0]?.id).toMatch(/^auto-/);

	// An agent-raised (non-auto) report also sits on the channel — it must NOT be pruned by a later run.
	rec.dto.reports = [...(rec.dto.reports ?? []), { id: "manual-1", summary: "I flagged something myself", createdAt: Date.now() }];

	// Run 2: the agent re-runs and now finishes GREEN (fresh proof, high confidence). The stale auto-report
	// from run 1 is superseded — the low-confidence flag stops nagging — while the manual report survives.
	internals.onAgentEvent(rec, { type: "agent_start" });
	rec.dto.verificationState = "fresh";
	await internals.finalizeRun(rec);

	expect(rec.dto.confidence).toBeGreaterThanOrEqual(0.4);
	const ids = (rec.dto.reports ?? []).map((r) => r.id);
	expect(ids).toEqual(["manual-1"]); // the auto-report is gone; the agent-raised one remains
	expect(rec.dto.effectiveMode).toBe("autodrive"); // cap lifted with the recovered confidence

	await mgr.stop();
});
