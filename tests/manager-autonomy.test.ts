/**
 * Manager autonomy — the three behaviors carved onto SquadManager:
 *   #1  close-on-land fires on the SINGLE-AGENT land path (`land(id)`), not only `landFeature`.
 *   #13 admission backpressure: at the WIP cap, enqueue instead of throwing when OMP_SQUAD_QUEUE_ON_FULL is set.
 *   #5  supervised autonomy: bounded, opt-in auto-answer of LOW-RISK pending requests (OMP_SQUAD_AUTOSUPERVISE).
 *
 * Deterministic: a typed fake driver + a fake land seam + a tiny Plane stub. No model tokens, no real omp.
 */

import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SquadManager } from "../src/squad-manager.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import type { AgentDriver } from "../src/agent-driver.ts";
import { SubagentTracker } from "../src/subagents.ts";
import type { LandResult } from "../src/land.ts";
import { recordLandOutcome } from "../src/land-ledger.ts";
import type { AgentDTO, IssueRef, PersistedAgent, RpcExtensionUIRequest, RpcSessionState } from "../src/types.ts";

const tmps: string[] = [];
const ENV = ["PLANE_API_KEY", "PLANE_WORKSPACE", "PLANE_BASE_URL", "OMP_SQUAD_MAX_WIP", "OMP_SQUAD_QUEUE_ON_FULL", "OMP_SQUAD_AUTOSUPERVISE", "OMP_SQUAD_AUTOSUPERVISE_BUDGET", "OMP_SQUAD_AUTOLAND_FAIL_CAP"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV) saved[k] = process.env[k];

afterEach(async () => {
	for (const k of ENV) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

/** A no-op AgentDriver that records every respondUi call, so an auto-answer is observable without a real omp. */
class FakeDriver extends EventEmitter implements AgentDriver {
	readonly isReady = true;
	readonly isAlive = true;
	readonly uiCalls: { id: string; payload: { value?: string; confirmed?: boolean; cancelled?: true } }[] = [];
	start(): Promise<void> {
		return Promise.resolve();
	}
	stop(): Promise<void> {
		return Promise.resolve();
	}
	prompt(): Promise<void> {
		return Promise.resolve();
	}
	abort(): Promise<unknown> {
		return Promise.resolve();
	}
	getState(): Promise<RpcSessionState> {
		return Promise.reject(new Error("getState is never called in these tests"));
	}
	respondUi(requestId: string, payload: { value?: string; confirmed?: boolean; cancelled?: true }): void {
		this.uiCalls.push({ id: requestId, payload });
	}
	respondHostTool(): void {}
}

/** SquadManager with the land seam faked and a way to drive a UI request straight into onUi. */
class TestManager extends SquadManager {
	landResult: LandResult = { ok: true, committed: true, merged: true, message: "landed" };
	protected landBranch(): Promise<LandResult> {
		return Promise.resolve(this.landResult);
	}
	/** Inject a UI request as if the agent's driver had emitted it (exercises the real onUi → auto-supervise path). */
	fireUi(id: string, req: RpcExtensionUIRequest): void {
		const rec = this.agents.get(id);
		if (rec) this.onUi(rec, req);
	}
	/** Expose the production orchestrator-wiring seam (start() arms the live daemon, so it can't run here). */
	makeOrchestrator(): Orchestrator {
		return this.buildOrchestrator();
	}
}

async function freshManager(planeBase?: string): Promise<TestManager> {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-"));
	tmps.push(stateDir);
	process.env.PLANE_API_KEY = "secret";
	process.env.PLANE_WORKSPACE = "acme";
	if (planeBase) process.env.PLANE_BASE_URL = planeBase;
	return new TestManager({ stateDir });
}

/** Insert a roster record with a fake driver. Returns the driver so a test can read its recorded calls. */
function seed(mgr: TestManager, id: string, issue?: IssueRef): FakeDriver {
	const agent = new FakeDriver();
	const dto: AgentDTO = {
		id,
		name: id,
		status: "idle",
		kind: "omp-operator",
		repo: "/r",
		worktree: "/r/wt",
		branch: `squad/${id}`,
		approvalMode: "yolo",
		pending: [],
		lastActivity: 0,
		messageCount: 0,
		issue,
	};
	const options: PersistedAgent = { id, name: id, repo: "/r", worktree: "/r/wt", approvalMode: "yolo", issue };
	mgr.agents.set(id, { dto, agent, options, transcript: [], assistantBuf: "", streaming: false, subs: new SubagentTracker() });
	return agent;
}

/** Minimal Plane HTTP stub: GET .../states/ advertises a completed group; PATCH counts as a close. */
function planeStub(completed: boolean) {
	let patches = 0;
	const server = Bun.serve({
		port: 0,
		fetch: (req) => {
			const url = new URL(req.url);
			if (req.method === "GET" && url.pathname.endsWith("/states/")) {
				return Response.json({ results: completed ? [{ id: "s-done", group: "completed" }] : [{ id: "s-todo", group: "backlog" }] });
			}
			if (req.method === "PATCH") {
				patches++;
				return Response.json({ ok: true });
			}
			return new Response("no", { status: 404 });
		},
	});
	return { server, patches: () => patches };
}

const trackedIssue: IssueRef = { id: "iss-1", name: "do the thing", projectId: "proj-9" };

function confirmReq(id: string, title: string, message: string): RpcExtensionUIRequest {
	return { type: "extension_ui_request", id, method: "confirm", title, message };
}

// ── #1 close-on-land on the single-agent path ────────────────────────────────

test("single-agent land closes its tracking issue exactly once (idempotent across re-lands)", async () => {
	const { server, patches } = planeStub(true);
	try {
		const mgr = await freshManager(`http://127.0.0.1:${server.port}`);
		seed(mgr, "a1", trackedIssue);
		const r = await mgr.land("a1");
		expect(r.ok).toBe(true);
		await mgr.land("a1"); // already closed → no second PATCH
		expect(patches()).toBe(1);
	} finally {
		server.stop(true);
	}
});

test("single-agent no-op land does NOT close its tracking issue", async () => {
	const { server, patches } = planeStub(true);
	try {
		const mgr = await freshManager(`http://127.0.0.1:${server.port}`);
		mgr.landResult = { ok: true, committed: false, merged: false, message: "nothing to land" };
		seed(mgr, "a1", trackedIssue);
		const r = await mgr.land("a1");
		expect(r.ok).toBe(true);
		expect(patches()).toBe(0);
	} finally {
		server.stop(true);
	}
});

test("single-agent land does NOT close the issue when the land fails", async () => {
	const { server, patches } = planeStub(true);
	try {
		const mgr = await freshManager(`http://127.0.0.1:${server.port}`);
		mgr.landResult = { ok: false, committed: false, merged: false, message: "", detail: "diverged" };
		seed(mgr, "a1", trackedIssue);
		const r = await mgr.land("a1");
		expect(r.ok).toBe(false);
		expect(patches()).toBe(0);
	} finally {
		server.stop(true);
	}
});

test("single-agent land of an issue-less agent makes no Plane call", async () => {
	const { server, patches } = planeStub(true);
	try {
		const mgr = await freshManager(`http://127.0.0.1:${server.port}`);
		seed(mgr, "a1"); // no issue
		expect((await mgr.land("a1")).ok).toBe(true);
		expect(patches()).toBe(0);
	} finally {
		server.stop(true);
	}
});

test("auto-land parks a branch after the failure cap (restart-safe via the branch ledger); operator land bypasses it", async () => {
	process.env.OMP_SQUAD_AUTOLAND_FAIL_CAP = "2";
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-"));
	tmps.push(stateDir);
	const mgr = new TestManager({ stateDir });
	mgr.landResult = { ok: true, committed: true, merged: true, message: "landed" };
	seed(mgr, "a1"); // branch squad/a1, no issue
	// Two prior failed auto-lands persisted to the ledger (e.g. survived a daemon restart that re-minted the id).
	recordLandOutcome(stateDir, "squad/a1", false, "gate red");
	recordLandOutcome(stateDir, "squad/a1", false, "gate red");
	// Auto-land now parks (does NOT reach the land seam, which would return ok).
	const parked = await mgr.land("a1");
	expect(parked.ok).toBe(false);
	expect(parked.detail).toContain("parked");
	// An operator land (auto:false) is never blocked — it reaches the real seam and clears the streak.
	const forced = await mgr.land("a1", undefined, { auto: false });
	expect(forced.ok).toBe(true);
});

// ── #13 admission backpressure: enqueue at the cap ───────────────────────────

test("create enqueues at the WIP cap when OMP_SQUAD_QUEUE_ON_FULL is set (signals queued, no throw, not in roster)", async () => {
	const mgr = await freshManager();
	seed(mgr, "live1");
	seed(mgr, "live2"); // 2 occupying live agents, cap 2 → full
	for (const id of ["live1", "live2"]) mgr.agents.get(id)!.dto.status = "working";
	process.env.OMP_SQUAD_MAX_WIP = "2";
	process.env.OMP_SQUAD_QUEUE_ON_FULL = "1";
	const dto = await mgr.create({ repo: "/x/repo", name: "parked" });
	expect(dto.queued).toBe(true);
	expect(dto.name).toBe("parked");
	expect(mgr.list().length).toBe(2); // the parked spawn never joined the roster
});

test("create still hard-throws at the cap when the flag is off (default behavior preserved)", async () => {
	const mgr = await freshManager();
	seed(mgr, "live1");
	seed(mgr, "live2");
	for (const id of ["live1", "live2"]) mgr.agents.get(id)!.dto.status = "working";
	process.env.OMP_SQUAD_MAX_WIP = "2";
	delete process.env.OMP_SQUAD_QUEUE_ON_FULL;
	delete process.env.OMP_SQUAD_RESOURCE_GATE; // hermetic: assert the count cap, not ambient host-pressure backoff
	await expect(mgr.create({ repo: "/x/repo", name: "blocked" })).rejects.toThrow(/WIP cap reached \(2\/2\)/);
});

// ── OMPSQ-134: the manager parks into the SAME Scheduler the orchestrator drains ──

test("a parked spawn is visible to the orchestrator's drain (manager + orchestrator share one Scheduler)", async () => {
	const mgr = await freshManager();
	seed(mgr, "live1");
	seed(mgr, "live2"); // cap 2, both occupying → full
	for (const id of ["live1", "live2"]) mgr.agents.get(id)!.dto.status = "working";
	process.env.OMP_SQUAD_MAX_WIP = "2";
	process.env.OMP_SQUAD_QUEUE_ON_FULL = "1";
	const dto = await mgr.create({ repo: "/x/repo", name: "parked" });
	expect(dto.queued).toBe(true);

	// The manager parks into its private scheduler; the orchestrator start() builds is wired to THAT
	// exact instance (buildOrchestrator passes `scheduler: this.scheduler`). Before the fix the
	// orchestrator owned a different Scheduler, so this request was stranded forever. Exercise the REAL
	// production seam (not a hand-mirrored Orchestrator) so a regression on that one wiring line — the
	// exact regression this guards — actually fails the test.
	const schedulerMgrParkedInto = (mgr as unknown as { scheduler: import("../src/scheduler.ts").Scheduler }).scheduler;
	expect(schedulerMgrParkedInto.queued).toBe(1);
	const orch = mgr.makeOrchestrator();
	expect(orch.scheduler).toBe(schedulerMgrParkedInto); // same instance — not a private copy
	expect(orch.scheduler.dequeue()?.name).toBe("parked"); // the drain side pops what create() parked
});

// ── #5 supervised autonomy: bounded, opt-in auto-answer ──────────────────────

test("autosupervise auto-approves low-risk confirms within the per-agent budget, then leaves the rest for a human", async () => {
	process.env.OMP_SQUAD_AUTOSUPERVISE = "1";
	process.env.OMP_SQUAD_AUTOSUPERVISE_BUDGET = "2";
	const mgr = await freshManager();
	const drv = seed(mgr, "a1");
	mgr.fireUi("a1", confirmReq("r1", "Run tests?", "bun test"));
	mgr.fireUi("a1", confirmReq("r2", "Read a file?", "src/x.ts"));
	mgr.fireUi("a1", confirmReq("r3", "Install a dep?", "bun add zod"));
	expect(drv.uiCalls.map((c) => c.id)).toEqual(["r1", "r2"]); // budget of 2 spent
	expect(drv.uiCalls.every((c) => c.payload.confirmed === true)).toBe(true);
	expect(mgr.getAgent("a1")?.pending.map((p) => p.id)).toEqual(["r3"]); // the over-budget one waits
});

test("autosupervise NEVER answers a destructive request — it is left for a human", async () => {
	process.env.OMP_SQUAD_AUTOSUPERVISE = "1";
	const mgr = await freshManager();
	const drv = seed(mgr, "a1");
	mgr.fireUi("a1", confirmReq("r1", "Force-push to main?", "git push --force origin main"));
	expect(drv.uiCalls.length).toBe(0);
	expect(mgr.getAgent("a1")?.pending.map((p) => p.id)).toEqual(["r1"]);
});

test("autosupervise OFF (opt-out): every request waits for a human", async () => {
	process.env.OMP_SQUAD_AUTOSUPERVISE = "0"; // now opt-OUT: autosupervise is on by default, so disable it explicitly
	const mgr = await freshManager();
	const drv = seed(mgr, "a1");
	mgr.fireUi("a1", confirmReq("r1", "Run tests?", "bun test"));
	expect(drv.uiCalls.length).toBe(0);
	expect(mgr.getAgent("a1")?.pending.map((p) => p.id)).toEqual(["r1"]);
});
