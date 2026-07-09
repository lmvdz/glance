/**
 * Live incident: a one-shot ACP agent (the plan-reviser spawned by "Send to planner", capability
 * catalog id `collaborative-plan-reviser`, running on an ACP harness) completed its turn — WORKING →
 * IDLE, `agent_end` fired, the edit landed for real — and then ~8s later its process exited 143
 * (SIGTERM), its normal one-shot teardown. The exit handler in squad-manager.ts's `wire()` used to map
 * `code === 0 ? "stopped" : "error"` unconditionally, so a signal-exit AFTER a completed turn was
 * flagged ERROR and surfaced as "needs you" + Restart even though the agent had already succeeded.
 *
 * The fix: an exit is only a crash if the agent had NOT already finished its work. "Finished its
 * work" = `rec.completedTurn` (set once an `agent_end` frame has ever landed) AND the agent is
 * currently at rest (not streaming, nothing pending) at the moment of exit. Under that rule, ANY exit
 * code — including signal-kill codes (143 SIGTERM, 130 SIGINT, 137 SIGKILL) — after a completed,
 * at-rest turn is clean teardown. A crash before any completed turn, or a death mid-stream / with an
 * unanswered pending request, still classifies as `error`, exactly as before.
 */

import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { PersistedAgent, RpcSessionState } from "../src/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

/** Resolves prompt() by synchronously emitting "agent_end" first — models a one-shot ACP turn that
 *  actually completes (end_turn/cancel/refusal/error all fire agent_end per acp-agent-driver.ts). The
 *  test drives "exit" separately, exactly like a real ACP child's `proc.exited` handler would. */
class OneShotDriver extends EventEmitter implements AgentDriver {
	readonly isReady = true;
	readonly isAlive = true;
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async prompt(): Promise<void> {
		this.emit("event", { type: "agent_end" });
	}
	async abort(): Promise<unknown> {
		return undefined;
	}
	async getState(): Promise<RpcSessionState> {
		return { todoPhases: [], isStreaming: false } as RpcSessionState;
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

/** Never resolves its own turn — prompt() just leaves the driver "streaming" forever, modeling a
 *  process that dies before producing anything (cold-start death) or mid-turn (a real crash). */
class NeverFinishesDriver extends EventEmitter implements AgentDriver {
	readonly isReady = true;
	readonly isAlive = true;
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	prompt(): Promise<void> {
		return new Promise(() => {}); // never resolves, never emits agent_end
	}
	async abort(): Promise<unknown> {
		return undefined;
	}
	async getState(): Promise<RpcSessionState> {
		return { todoPhases: [], isStreaming: true } as RpcSessionState;
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

interface DriverFactoryHost {
	makeDriver: (p: PersistedAgent) => AgentDriver;
}

async function makeRepo(prefix: string): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(repo);
	const git = async (args: string[]) => {
		await Bun.spawn(["git", ...args], { cwd: repo, stdout: "ignore", stderr: "ignore" }).exited;
	};
	await git(["init", "-q"]);
	await git(["config", "user.email", "t@t"]);
	await git(["config", "user.name", "t"]);
	await git(["config", "commit.gpgsign", "false"]);
	await fs.writeFile(path.join(repo, "README.md"), "x\n");
	await git(["add", "."]);
	await git(["commit", "-qm", "init"]);
	return repo;
}

async function makeMgr(prefix: string): Promise<{ mgr: SquadManager; repo: string }> {
	const repo = await makeRepo(`${prefix}-repo-`);
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-state-`));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-wt-`));
	tmps.push(stateDir, worktreeBase);
	const mgr = new SquadManager({ stateDir, worktreeBase });
	await mgr.start();
	return { mgr, repo };
}

test("RED (pre-fix behavior, now fixed): a completed one-shot that exits 143 (SIGTERM) reaps as stopped, not error", async () => {
	const { mgr, repo } = await makeMgr("sigterm-clean");
	const driver = new OneShotDriver();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => driver;

	const dto = await mgr.create({ name: "plan-reviser", repo, approvalMode: "write", task: "revise the plan doc" });
	// The turn completed synchronously inside create()'s own prompt() await — before we ever touch exit.
	expect(dto.status).toBe("idle");

	driver.emit("exit", { code: 143 }); // SIGTERM — normal ACP one-shot teardown, not a crash

	const after = mgr.list().find((a) => a.id === dto.id);
	expect(after?.status).toBe("stopped"); // NOT "error" — this is the bug
	expect(after?.error).toBeUndefined();
	expect(mgr.list().find((a) => a.id === dto.id)?.status).not.toBe("error");

	await mgr.stop();
});

test("a completed one-shot that exits 130 (SIGINT) or 137 (SIGKILL) also reaps clean", async () => {
	for (const code of [130, 137]) {
		const { mgr, repo } = await makeMgr(`sig-${code}`);
		const driver = new OneShotDriver();
		(mgr as unknown as DriverFactoryHost).makeDriver = () => driver;
		const dto = await mgr.create({ name: "plan-reviser", repo, approvalMode: "write", task: "revise" });

		driver.emit("exit", { code });

		expect(mgr.list().find((a) => a.id === dto.id)?.status).toBe("stopped");
		await mgr.stop();
	}
});

test("a crash BEFORE any completed turn still classifies as error, even for the same signal code", async () => {
	const { mgr, repo } = await makeMgr("crash-no-turn");
	const driver = new NeverFinishesDriver();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => driver;

	// create() with no task: nothing ever prompts, no agent_end ever fires — completedTurn stays unset.
	const dto = await mgr.create({ name: "never-ran", repo, approvalMode: "write" });
	expect(dto.status).toBe("idle");

	driver.emit("exit", { code: 143 }); // died before doing anything — still an error, not teardown

	const after = mgr.list().find((a) => a.id === dto.id);
	expect(after?.status).toBe("error");
	expect(after?.error).toContain("143");

	await mgr.stop();
});

test("a crash mid-stream (after a prior completed turn) still classifies as error — turn completion doesn't blanket-immunize a later crash", async () => {
	const { mgr, repo } = await makeMgr("crash-mid-stream");
	const driver = new OneShotDriver();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => driver;

	// First turn completes cleanly (completedTurn becomes true).
	const dto = await mgr.create({ name: "plan-reviser", repo, approvalMode: "write", task: "first turn" });
	expect(dto.status).toBe("idle");

	// Second turn never resolves (still streaming) when the process dies mid-flight.
	driver.prompt = () => new Promise(() => {});
	void mgr.applyCommand({ type: "prompt", id: dto.id, message: "second turn" } as never);
	// Give the prompt call a tick to flip streaming true via the "task-start" transition.
	await new Promise((r) => setTimeout(r, 5));
	expect(mgr.list().find((a) => a.id === dto.id)?.status).toBe("working");

	driver.emit("exit", { code: 1 });

	const after = mgr.list().find((a) => a.id === dto.id);
	expect(after?.status).toBe("error"); // mid-stream death is a real crash, not teardown of a finished run

	await mgr.stop();
});

test("a plain crash (code 0 never involved, no turn ever completed) with a NON-signal code still errors", async () => {
	const { mgr, repo } = await makeMgr("plain-crash");
	const driver = new NeverFinishesDriver();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => driver;
	const dto = await mgr.create({ name: "never-ran", repo, approvalMode: "write" });

	driver.emit("exit", { code: 1 });

	expect(mgr.list().find((a) => a.id === dto.id)?.status).toBe("error");
	await mgr.stop();
});

test("code 0 stays clean regardless of turn state (unchanged prior behavior)", async () => {
	const { mgr, repo } = await makeMgr("code-zero");
	const driver = new NeverFinishesDriver();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => driver;
	const dto = await mgr.create({ name: "never-ran", repo, approvalMode: "write" });

	driver.emit("exit", { code: 0 });

	expect(mgr.list().find((a) => a.id === dto.id)?.status).toBe("stopped");
	await mgr.stop();
});

test("restart() resets completedTurn — a fresh driver's own pre-turn crash isn't immunized by the OLD driver's completed turn", async () => {
	const { mgr, repo } = await makeMgr("restart-reset");
	const first = new OneShotDriver();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => first;
	const dto = await mgr.create({ name: "plan-reviser", repo, approvalMode: "write", task: "first turn" });
	expect(dto.status).toBe("idle"); // completedTurn is now true on the old driver's record

	const fresh = new NeverFinishesDriver();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => fresh;
	await mgr.applyCommand({ type: "restart", id: dto.id } as never);
	await new Promise((r) => setTimeout(r, 5));

	fresh.emit("exit", { code: 1 }); // the NEW process crashed before ever completing a turn

	const after = mgr.list().find((a) => a.id === dto.id);
	expect(after?.status).toBe("error"); // must NOT be masked by the pre-restart completed turn

	await mgr.stop();
});
