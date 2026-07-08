/**
 * Regression for the daemon-crashing bug: a console-chat prompt to an agent whose harness can't
 * (re)start took the WHOLE FLEET DAEMON DOWN, not just that one agent.
 *
 * Real mechanism (reproduced against a scratch daemon — own state dir, all 5 autonomy flags off,
 * HOME repointed to an empty tmp dir — driving `/api/console` then a chat prompt against a bogus
 * harness bin): the webapp's Assistant chat POSTs `/api/console` to spin up a console agent (safely
 * caught by `createWithId`'s own try/catch around `agent.start()` — that path was never the bug), then
 * sends the user's actual message as a `{type:"prompt"}` `ClientCommand` over the daemon's websocket.
 * `applyCommand`'s "prompt" case called `await this.ensureConnected(rec)` BARE — unlike the
 * `promptConnected` call two lines below it, which every caller wraps in
 * `.catch((err) => this.fail(rec, err))` — so when the agent wasn't alive/ready (exactly the state a
 * failed-to-start harness leaves it in) and `ensureConnected` re-threw the driver's `start()` rejection,
 * nothing in `applyCommand` caught it. The daemon's WS message handler (src/server.ts) fires
 * `applyCommand` fire-and-forget — `void m.applyCommand(cmd, actor).catch((err) => { if (!(err
 * instanceof RbacDenied)) throw err; })` — so that escaped rejection became a genuinely unhandled
 * promise rejection with no further catcher in the chain, which (absent a listener) crashes the whole
 * Bun process: every other live agent, every other org, gone.
 *
 * This drives `SquadManager.applyCommand({type:"prompt"})` directly against a seeded agent whose driver's
 * `start()` always rejects (the exact shape a bogus/broken harness bin produces via RpcAgent.start() →
 * spawnHost() → agent-host's spawn choreography — proven for real components in
 * tests/rpc-agent-spawn-failure.test.ts) and asserts:
 *  1. `applyCommand` itself never rejects — the failure settles into the SAME legible "error" status/
 *     `dto.error` surface every other spawn failure in this file uses (createWithId, restart,
 *     attachExisting all do this already; the prompt case now matches).
 *  2. Wrapping the call in the EXACT fire-and-forget shape server.ts's WS handler uses never produces an
 *     unhandled promise rejection.
 *  3. The manager keeps working afterward (survives) — a second, healthy agent can still be prompted.
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
import type { AgentDTO, AgentStatus, ClientCommand, PersistedAgent, RpcSessionState } from "../src/types.ts";

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
 *  `RpcAgent.start()` exhausts its respawn budget (`agent host for … did not come up` / `agent … not
 *  ready within …ms` / `agent exited before ready`). `isAlive`/`isReady` stay false so `ensureConnected`
 *  always attempts (and re-fails) `start()`, exactly like a genuinely dead/unreconnectable host. */
class UnstartableDriver extends EventEmitter implements AgentDriver {
	readonly isReady = false;
	readonly isAlive = false;
	startCalls = 0;
	start(): Promise<void> {
		this.startCalls++;
		return Promise.reject(new Error("spawn ENOENT: bogus-harness-bin — agent host did not come up"));
	}
	stop(): Promise<void> {
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
	respondUi(): void {}
	respondHostTool(): void {}
}

/** A healthy no-op driver — used to prove the manager survives the crash-shaped failure above and can
 *  still service an unrelated agent afterward. */
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

test("a prompt to an agent whose harness can't start settles into the error state, not an unhandled rejection", async () => {
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

	// The spawn failure was attempted (not skipped) …
	expect(broken.startCalls).toBeGreaterThan(0);
	// … but applyCommand ITSELF never rejected — the failure settled into the agent's own legible state.
	const dto = mgr.list().find((a) => a.id === "console-1");
	expect(dto?.status).toBe("error");
	expect(dto?.error).toContain("bogus-harness-bin");
	// No floating rejection ever escaped to the process level.
	expect(unhandled).toBeUndefined();

	await mgr.stop();
});

test("the WS fire-and-forget dispatch shape never produces an unhandled rejection for a spawn failure", async () => {
	const stateDir = await freshStateDir();
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	seed(mgr, "console-2", new UnstartableDriver(), "idle");

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
	const dto = mgr.list().find((a) => a.id === "console-2");
	expect(dto?.status).toBe("error");

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
