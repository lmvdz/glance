/**
 * Regression for the daemon-crashing bug AND its cross-lineage-review follow-up (the zombie-host class):
 * a spawn/reconnect failure on any in-roster settle path must (1) never escape as an unhandled rejection
 * that kills the fleet daemon, and (2) STOP the possibly-half-spawned driver before marking error, so no
 * orphan agent-host/socket survives — mirroring createWithId's long-standing `stop()`-before-`fail()`.
 *
 * Original crash mechanism (reproduced live against a scratch daemon — own state dir, all 5 autonomy
 * flags off, HOME repointed to an empty tmp dir, GLANCE_BIN pointed at a harness that can't start): the
 * webapp POSTs `/api/console` to spin up a console agent (safely caught by `createWithId` — never the
 * bug), then sends the user's message as a `{type:"prompt"}` `ClientCommand` over the WS. `applyCommand`'s
 * "prompt" case called `await this.ensureConnected(rec)` BARE, so a failed (re)start's rejection had no
 * catcher in `applyCommand` and propagated out. The WS handler fires `applyCommand` fire-and-forget
 * (`void m.applyCommand(...).catch(...)`), so that escaped rejection became a genuinely unhandled promise
 * rejection — which crashes the whole Bun process (confirmed: NOT caught by index.ts's process-level
 * unhandledRejection listener when it escapes a Bun.serve WS `message` callback).
 *
 * Cross-lineage review then found the SETTLE was incomplete: settling into "error" left a half-spawned
 * host/socket alive on four paths (prompt / set-model / restart / commission-onboard). All four now funnel
 * through `settleSpawnFailure` (stop-then-fail) — createWithId's pattern — except the commission path,
 * which REMOVES the never-onboarded record entirely (an owner-less flue worker shouldn't linger as a
 * roster ghost). These tests drive each path against a driver whose `start()` always rejects (the shape a
 * bogus/broken harness bin produces — proven for real components in tests/rpc-agent-spawn-failure.test.ts,
 * which also proves `stop()` reaps a real attached-but-unready host) and assert per path:
 *  - `applyCommand` itself never rejects and no `unhandledRejection` fires;
 *  - the agent settles into the SAME legible "error" status/`dto.error` surface every other spawn failure
 *    uses (or, for commission, is removed from the roster with a `removed` event);
 *  - `stop()` was invoked on the failed driver (stop-before-fail — the zombie-reap guard);
 *  - the manager survives and keeps serving other agents.
 */

import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SquadManager } from "../src/squad-manager.ts";
import { SubagentTracker } from "../src/subagents.ts";
import type { AgentDriver } from "../src/agent-driver.ts";
import { RbacDenied } from "../src/auth.ts";
import { LOCAL_ACTOR } from "../src/federation.ts";
import type { AgentDTO, AgentStatus, ClientCommand, PersistedAgent, RpcSessionState, SquadEvent } from "../src/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";
process.env.OMP_SQUAD_AUTODRIVE = "0";
process.env.OMP_SQUAD_AUTOLAND = "0";
process.env.OMP_SQUAD_AUTOSUPERVISE = "0";
process.env.OMP_SQUAD_AUTO_SUPERVISE = "0";

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function freshStateDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "console-prompt-spawn-"));
	tmps.push(dir);
	return dir;
}

/** A driver whose `start()` always rejects — the shape a bogus/broken harness bin produces once
 *  `RpcAgent.start()` exhausts its respawn budget. `isAlive`/`isReady` stay false so `ensureConnected`
 *  always attempts (and re-fails) `start()`, exactly like a genuinely dead/unreconnectable host.
 *  `stopCalls` proves the settle path tore the (possibly half-spawned) driver down before marking error. */
class UnstartableDriver extends EventEmitter implements AgentDriver {
	readonly isReady = false;
	readonly isAlive = false;
	startCalls = 0;
	stopCalls = 0;
	start(): Promise<void> {
		this.startCalls++;
		return Promise.reject(new Error("spawn ENOENT: bogus-harness-bin — agent host did not come up"));
	}
	stop(): Promise<void> {
		this.stopCalls++;
		return Promise.resolve();
	}
	prompt(): Promise<void> {
		return Promise.reject(new Error("prompt() must never be reached — start() already failed"));
	}
	abort(): Promise<unknown> {
		return Promise.resolve();
	}
	getState(): Promise<RpcSessionState> {
		return Promise.reject(new Error("getState is never called in this test"));
	}
	// Present so applyCommand's "set-model" guard (`!rec.agent.setModel` → break) passes and the
	// ensureConnected spawn failure is actually exercised. Never reached (start() fails first).
	setModel(): Promise<unknown> {
		return Promise.reject(new Error("setModel() must never be reached — start() already failed"));
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

/** A healthy no-op driver — proves the manager survives the crash-shaped failure and still serves others. */
class HealthyDriver extends EventEmitter implements AgentDriver {
	isReady = true;
	isAlive = true;
	promptedWith: string[] = [];
	start(): Promise<void> {
		return Promise.resolve();
	}
	stop(): Promise<void> {
		return Promise.resolve();
	}
	prompt(message: string): Promise<void> {
		this.promptedWith.push(message);
		return Promise.resolve();
	}
	abort(): Promise<unknown> {
		return Promise.resolve();
	}
	getState(): Promise<RpcSessionState> {
		return Promise.reject(new Error("getState is never called in this test"));
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

interface AgentRecordLike {
	dto: AgentDTO;
	agent: AgentDriver;
	options: PersistedAgent;
	transcript: unknown[];
	assistantBuf: string;
	thinkingBuf: string;
	streaming: boolean;
	subs: SubagentTracker;
	toolEntries: Map<string, unknown>;
}

interface ManagerTestHost {
	agents: Map<string, AgentRecordLike>;
	makeDriver: (p: PersistedAgent, cold?: boolean) => AgentDriver;
}

function seed(mgr: SquadManager, id: string, agent: AgentDriver, status: AgentStatus = "idle"): AgentRecordLike {
	const dto: AgentDTO = {
		id,
		name: id,
		status,
		kind: "omp-operator",
		repo: "/r",
		worktree: "/r",
		branch: `squad/${id}`,
		approvalMode: "yolo",
		pending: [],
		lastActivity: 0,
		messageCount: 0,
	};
	const options: PersistedAgent = { id, name: id, repo: "/r", worktree: "/r", approvalMode: "yolo" };
	const rec: AgentRecordLike = { dto, agent, options, transcript: [], assistantBuf: "", thinkingBuf: "", streaming: false, subs: new SubagentTracker(), toolEntries: new Map() };
	(mgr as unknown as ManagerTestHost).agents.set(id, rec);
	return rec;
}

/** Mirrors src/server.ts's (fixed) WS command dispatch exactly: fire-and-forget, RbacDenied swallowed,
 *  anything else logged — NEVER rethrown into the void. */
function dispatchLikeWsHandler(mgr: SquadManager, cmd: ClientCommand, log: string[]): void {
	void mgr.applyCommand(cmd, LOCAL_ACTOR).catch((err) => {
		if (err instanceof RbacDenied) return;
		log.push(err instanceof Error ? err.message : String(err));
	});
}

test("prompt: a spawn failure settles into error, stops the driver, and never leaks an unhandled rejection", async () => {
	const stateDir = await freshStateDir();
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	const broken = new UnstartableDriver();
	seed(mgr, "console-1", broken, "idle");

	let unhandled: unknown;
	const onUnhandled = (reason: unknown) => {
		unhandled = reason;
	};
	process.on("unhandledRejection", onUnhandled);

	try {
		// The exact vulnerable call: applyCommand's "prompt" case, driving ensureConnected against a
		// driver whose start() rejects. Pre-fix, this threw straight out of applyCommand.
		await mgr.applyCommand({ type: "prompt", id: "console-1", message: "hello" }, LOCAL_ACTOR);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}

	expect(broken.startCalls).toBeGreaterThan(0);
	const dto = mgr.list().find((a) => a.id === "console-1");
	expect(dto?.status).toBe("error");
	expect(dto?.error).toContain("bogus-harness-bin");
	// Zombie-reap guard: the half-spawned driver was stopped before the record was failed.
	expect(broken.stopCalls).toBeGreaterThanOrEqual(1);
	expect(unhandled).toBeUndefined();

	await mgr.stop();
});

test("the WS fire-and-forget dispatch shape never produces an unhandled rejection for a spawn failure", async () => {
	const stateDir = await freshStateDir();
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	const broken = new UnstartableDriver();
	seed(mgr, "console-2", broken, "idle");

	let unhandled: unknown;
	const onUnhandled = (reason: unknown) => {
		unhandled = reason;
	};
	process.on("unhandledRejection", onUnhandled);

	const logged: string[] = [];
	try {
		dispatchLikeWsHandler(mgr, { type: "prompt", id: "console-2", message: "hello" }, logged);
		// Give the fire-and-forget chain (and any errant unhandledRejection) a tick to surface.
		await new Promise((r) => setTimeout(r, 50));
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}

	expect(unhandled).toBeUndefined();
	// Nothing unexpected was even logged — the source-level fix means applyCommand resolved cleanly,
	// so the WS wrapper's catch never fired at all.
	expect(logged).toEqual([]);
	expect(mgr.list().find((a) => a.id === "console-2")?.status).toBe("error");
	expect(broken.stopCalls).toBeGreaterThanOrEqual(1);

	await mgr.stop();
});

test("set-model: a spawn failure settles into error (not a stuck 'starting') and stops the driver", async () => {
	const stateDir = await freshStateDir();
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	const broken = new UnstartableDriver();
	seed(mgr, "console-sm", broken, "idle");

	let unhandled: unknown;
	const onUnhandled = (reason: unknown) => {
		unhandled = reason;
	};
	process.on("unhandledRejection", onUnhandled);

	try {
		await mgr.applyCommand({ type: "set-model", id: "console-sm", model: "opus" }, LOCAL_ACTOR);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}

	const dto = mgr.list().find((a) => a.id === "console-sm");
	// ensureConnected already transitioned to "starting"; pre-review it was left stranded there. Now it
	// settles all the way to "error".
	expect(dto?.status).toBe("error");
	expect(broken.stopCalls).toBeGreaterThanOrEqual(1);
	expect(unhandled).toBeUndefined();

	await mgr.stop();
});

test("restart: a fresh driver that fails to start settles into error and is stopped (no orphan host)", async () => {
	const stateDir = await freshStateDir();
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	const original = new UnstartableDriver();
	seed(mgr, "console-rs", original, "idle");

	// restart() builds a FRESH driver via makeDriver and replaces rec.agent with it; that fresh driver is
	// the one whose start() must be caught-and-stopped. Inject a failing fresh driver deterministically.
	const fresh = new UnstartableDriver();
	(mgr as unknown as ManagerTestHost).makeDriver = () => fresh;

	let unhandled: unknown;
	const onUnhandled = (reason: unknown) => {
		unhandled = reason;
	};
	process.on("unhandledRejection", onUnhandled);

	try {
		await mgr.applyCommand({ type: "restart", id: "console-rs" }, LOCAL_ACTOR);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}

	expect(mgr.list().find((a) => a.id === "console-rs")?.status).toBe("error");
	// The fresh (failed) driver was stopped by settleSpawnFailure; restart also stops the original first.
	expect(fresh.stopCalls).toBeGreaterThanOrEqual(1);
	expect(unhandled).toBeUndefined();

	await mgr.stop();
});

test("the manager survives a spawn-failure prompt and keeps serving other agents", async () => {
	const stateDir = await freshStateDir();
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	seed(mgr, "console-3", new UnstartableDriver(), "idle");
	const healthy = new HealthyDriver();
	seed(mgr, "other-agent", healthy, "idle");

	await mgr.applyCommand({ type: "prompt", id: "console-3", message: "hello" }, LOCAL_ACTOR);
	expect(mgr.list().find((a) => a.id === "console-3")?.status).toBe("error");

	// The manager instance is still alive and functional for an unrelated agent.
	await mgr.applyCommand({ type: "prompt", id: "other-agent", message: "still works" }, LOCAL_ACTOR);
	expect(healthy.promptedWith).toEqual(["still works"]);
	expect(mgr.list().find((a) => a.id === "other-agent")?.status).not.toBe("error");

	await mgr.stop();
});

test("commission onboard: a worker whose host can't start leaves NO phantom roster member", async () => {
	const stateDir = await freshStateDir();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "console-spawn-worker-"));
	tmps.push(dir);
	const mgr = new SquadManager({ stateDir });
	await mgr.start();

	// Onboard is the only commission step that builds a driver via makeDriver — inject a failing one so
	// the gate still passes (author/validate untouched) but `onboardFlueWorker`'s `agent.start()` rejects.
	const failed = new UnstartableDriver();
	(mgr as unknown as ManagerTestHost).makeDriver = () => failed;

	const removed: string[] = [];
	mgr.on("event", (e: SquadEvent) => {
		if (e.type === "removed") removed.push(e.id);
	});

	const spec = {
		name: "extract-emails",
		purpose: "Extract email addresses from text.",
		model: false as const,
		capabilities: [] as string[],
		workflowBody: `const text = String(payload.text ?? "");\nconst emails = text.match(/[\\w.+-]+@[\\w-]+\\.[\\w.-]+/g) ?? [];\nreturn { emails, count: emails.length };`,
		accept: { payload: { text: "a@x.io b@y.org" }, expect: { count: 2 } },
	};

	const { TemplateArchitect } = await import("../src/architect.ts");
	// The onboard step rethrows, so commission() rejects — that's fine; the invariant under test is the
	// ROSTER, not the return shape: a failed onboard must not leave an owner-less flue member behind.
	await mgr.commission(spec, { architect: new TemplateArchitect(), dir }).catch(() => {});

	expect(failed.startCalls).toBeGreaterThan(0);
	expect(failed.stopCalls).toBeGreaterThanOrEqual(1); // the half-spawned host was torn down …
	expect(mgr.list().some((a) => a.name === "extract-emails")).toBe(false); // … and no phantom lingers
	expect(removed.length).toBeGreaterThanOrEqual(1); // a `removed` event announced the teardown

	await mgr.stop();
});
