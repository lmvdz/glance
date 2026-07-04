/**
 * Gate-class guard — a real workflow gate (raiseGate's `gate_`-id requests) must never be
 * auto-answered by either independent auto-approval engine: the in-process `maybeAutoSupervise`
 * (SquadManager) and the external `src/supervisor.ts` process. One shared scripted gate-shaped
 * PendingRequest drives BOTH engines here, alongside an otherwise-identical plain request, so a
 * pass proves the guard is gate-class-specific — not a blanket auto-answer regression.
 */

import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SquadManager } from "../src/squad-manager.ts";
import { createSupervisorLoop } from "../src/supervisor.ts";
import { SubagentTracker } from "../src/subagents.ts";
import type { LandResult } from "../src/land.ts";
import type { AgentDTO, IssueRef, PendingRequest, PersistedAgent, RpcExtensionUIRequest, RpcSessionState } from "../src/types.ts";

const tmps: string[] = [];
const ENV = ["OMP_SQUAD_AUTOSUPERVISE", "OMP_SQUAD_AUTOSUPERVISE_BUDGET"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV) saved[k] = process.env[k];

afterEach(async () => {
	for (const k of ENV) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

// ── #maybeAutoSupervise (SquadManager, in-process) ───────────────────────────

/** A no-op AgentDriver that records every respondUi call, so an auto-answer is observable without a real omp. */
class FakeDriver extends EventEmitter {
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

/** SquadManager with the land seam faked and a way to drive a UI request straight into onUi/maybeAutoSupervise. */
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
	/** The auto-supervise budget spend, exposed read-only for the assertion that a gate never touches it. */
	budgetFor(id: string): number {
		return (this as unknown as { superviseBudget: Map<string, number> }).superviseBudget.get(id) ?? 0;
	}
}

async function freshManager(): Promise<TestManager> {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-class-"));
	tmps.push(stateDir);
	return new TestManager({ stateDir });
}

function seed(mgr: TestManager, id: string, issue?: IssueRef): FakeDriver {
	const agent = new FakeDriver();
	const dto: AgentDTO = {
		id,
		name: id,
		status: "idle",
		kind: "omp-operator",
		repo: "/r",
		worktree: "/r",
		branch: `squad/${id}`,
		approvalMode: "yolo",
		pending: [],
		lastActivity: 0,
		messageCount: 0,
		issue,
	};
	const options: PersistedAgent = { id, name: id, repo: "/r", worktree: "/r", approvalMode: "yolo", issue };
	mgr.agents.set(id, { dto, agent: agent as never, options, transcript: [], assistantBuf: "", streaming: false, subs: new SubagentTracker() });
	return agent;
}

function gateReq(id: string, title: string, options: string[]): RpcExtensionUIRequest {
	return { type: "extension_ui_request", id, method: "select", title, options } as RpcExtensionUIRequest;
}

function confirmReq(id: string, title: string, message: string): RpcExtensionUIRequest {
	return { type: "extension_ui_request", id, method: "confirm", title, message } as RpcExtensionUIRequest;
}

test("onUi stamps gateClass:true for a raiseGate-shaped request (gate_-id), and leaves a plain confirm unstamped", async () => {
	const mgr = await freshManager();
	seed(mgr, "a1");
	mgr.fireUi("a1", gateReq("gate_1", "Proceed to deploy?", ["Approve", "Deny"]));
	mgr.fireUi("a1", confirmReq("r1", "Run tests?", "bun test"));
	const pending = mgr.getAgent("a1")?.pending ?? [];
	expect(pending.find((p) => p.id === "gate_1")?.gateClass).toBe(true);
	expect(pending.find((p) => p.id === "r1")?.gateClass).toBeUndefined();
});

test("maybeAutoSupervise NEVER answers a gate-class request or spends its budget, while an otherwise-identical plain confirm IS auto-answered", async () => {
	process.env.OMP_SQUAD_AUTOSUPERVISE = "1";
	const mgr = await freshManager();
	const drv = seed(mgr, "a1");

	mgr.fireUi("a1", gateReq("gate_1", "Proceed to deploy?", ["Approve", "Deny"]));
	// A plain confirm with an unambiguous yes/no bias IS auto-answered by the same engine — proves
	// the guard is gate-class-specific, not a blanket auto-answer regression.
	mgr.fireUi("a1", confirmReq("r1", "Run tests?", "bun test"));

	expect(drv.uiCalls.map((c) => c.id)).toEqual(["r1"]); // the gate never reached respondUi
	expect(mgr.budgetFor("a1")).toBe(1); // only the plain confirm spent budget
	expect(mgr.getAgent("a1")?.pending.map((p) => p.id)).toEqual(["gate_1"]); // gate still waits for a human
});

test("maybeAutoSupervise refuses a gate even when it is phrased as a low-risk yes/no confirm (id alone is the gate signal)", async () => {
	process.env.OMP_SQUAD_AUTOSUPERVISE = "1";
	const mgr = await freshManager();
	const drv = seed(mgr, "a1");
	mgr.fireUi("a1", confirmReq("gate_2", "Run tests?", "bun test")); // gate_-id but confirm-shaped/low-risk
	expect(drv.uiCalls.length).toBe(0);
	expect(mgr.getAgent("a1")?.pending.map((p) => p.id)).toEqual(["gate_2"]);
});

// ── #createSupervisorLoop (external supervisor.ts, out-of-process) ───────────

function loopAgent(pending: PendingRequest[]): AgentDTO {
	return {
		id: "a1",
		name: "a1",
		status: "input",
		kind: "omp-operator",
		repo: "/r",
		worktree: "/r",
		branch: "squad/a1",
		approvalMode: "yolo",
		pending,
		lastActivity: 0,
		messageCount: 0,
	};
}

async function flush(): Promise<void> {
	await new Promise((r) => setTimeout(r, 10));
}

test("createSupervisorLoop never fetches context or decides for a gate-class request, while an otherwise-identical plain confirm IS resolved via the chooseFallback fallback", async () => {
	let fetchCalls = 0;
	let decideCalls = 0;
	const sent: { agentId: string; requestId: string; value: string }[] = [];
	const loop = createSupervisorLoop({
		fetchContext: async () => {
			fetchCalls++;
			return "";
		},
		decide: async () => {
			decideCalls++;
			throw new Error("model unavailable in test"); // forces the chooseFallback fallback, same as a real timeout/parse-failure
		},
		send: (agentId, requestId, value) => sent.push({ agentId, requestId, value }),
	});

	const gate: PendingRequest = { id: "gate_1", source: "ui", kind: "select", title: "Proceed to deploy?", options: ["Approve", "Deny"], gateClass: true, createdAt: Date.now() };
	const plain: PendingRequest = { id: "r1", source: "ui", kind: "confirm", title: "Run tests?", message: "bun test", createdAt: Date.now() };

	loop.handleAgent(loopAgent([gate, plain]));
	await flush();

	// The gate never reaches resolveRequest at all: no context fetch, no decide() call, no send,
	// and it is never marked inflight/answered.
	expect(loop.inflight.has("gate_1")).toBe(false);
	expect(loop.answered.has("gate_1")).toBe(false);
	expect(sent.find((s) => s.requestId === "gate_1")).toBeUndefined();

	// The plain confirm IS resolved: fetchContext + decide were both invoked exactly once (for it
	// alone), decide's rejection fell back to chooseFallback's deterministic "yes", and it was sent.
	expect(fetchCalls).toBe(1);
	expect(decideCalls).toBe(1);
	expect(sent).toEqual([{ agentId: "a1", requestId: "r1", value: "yes" }]);
	expect(loop.answered.has("r1")).toBe(true);
	expect(loop.inflight.has("r1")).toBe(false); // cleared by the .finally() once resolved
});

test("createSupervisorLoop in dryRun mode still never resolves a gate, and never calls send for the plain confirm either", async () => {
	let fetchCalls = 0;
	const sent: unknown[] = [];
	const loop = createSupervisorLoop({
		fetchContext: async () => {
			fetchCalls++;
			return "";
		},
		decide: async () => "yes",
		send: (...args) => sent.push(args),
		dryRun: true,
	});
	const gate: PendingRequest = { id: "gate_1", source: "ui", kind: "select", title: "Proceed to deploy?", options: ["Approve", "Deny"], gateClass: true, createdAt: Date.now() };
	const plain: PendingRequest = { id: "r1", source: "ui", kind: "confirm", title: "Run tests?", message: "bun test", createdAt: Date.now() };
	loop.handleAgent(loopAgent([gate, plain]));
	await flush();
	expect(fetchCalls).toBe(1); // only for the plain confirm
	expect(sent.length).toBe(0); // dryRun never sends, for either kind
	expect(loop.answered.has("r1")).toBe(true); // still resolved/logged, just not transmitted
	expect(loop.answered.has("gate_1")).toBe(false);
});
