/**
 * plans/voice-loop concern 01 (completion push lane): the `voicePushArmed` arm/disarm latch on
 * squad-manager.ts — arm on a voice-sourced `prompt`/`create`, disarm on ANY `interrupt`,
 * persistence round-trip across a daemon restart, and the workflow-node-boundary exposure invariant
 * (`onAgentEvent`'s `agent_end`/`workflow_done` handling) that keeps a multi-node workflow from
 * mistaking a mid-graph idle blip for its real finish. push.ts's `voiceDonePayload` unit tests and
 * server.ts's `maybePushAlert` integration tests live in push.test.ts / push-server.test.ts.
 */

import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { LOCAL_ACTOR } from "../src/federation.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { AgentDTO, PersistedAgent, RpcSessionState } from "../src/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

/** Never auto-resolves a turn — the test drives `agent_end`/`workflow_done` explicitly via `emit`, so
 *  the arm/exposure invariants can be observed at each intermediate step. */
class ControlDriver extends EventEmitter implements AgentDriver {
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

/** Like ControlDriver, but `prompt()` finishes its own turn immediately (a microtask `agent_end`) —
 *  for tests that just need a completed dispatch, not manual control of the frame stream. */
class AutoDriver extends EventEmitter implements AgentDriver {
	readonly isReady = true;
	readonly isAlive = true;
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async prompt(): Promise<void> {
		queueMicrotask(() => this.emit("event", { type: "agent_end" }));
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

interface DriverFactoryHost {
	makeDriver: (p: PersistedAgent, cold?: boolean) => AgentDriver;
}
interface AgentRecordLike {
	dto: AgentDTO;
	agent: AgentDriver;
	options: PersistedAgent;
}
interface InternalHost {
	agents: Map<string, AgentRecordLike>;
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

async function makeMgr(prefix: string): Promise<{ mgr: SquadManager; repo: string; stateDir: string; worktreeBase: string }> {
	const repo = await makeRepo(`${prefix}-repo-`);
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-state-`));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-wt-`));
	tmps.push(stateDir, worktreeBase);
	const mgr = new SquadManager({ stateDir, worktreeBase });
	await mgr.start();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new ControlDriver();
	return { mgr, repo, stateDir, worktreeBase };
}

// ── arm ──────────────────────────────────────────────────────────────────

test("a voice-sourced prompt arms the completion-push latch; a plain prompt does not", async () => {
	const { mgr, repo } = await makeMgr("arm");
	const host = mgr as unknown as InternalHost;

	const voiced = await mgr.create({ name: "voiced", repo, approvalMode: "yolo" });
	await mgr.applyCommand({ type: "prompt", id: voiced.id, message: "go", source: "voice" }, LOCAL_ACTOR);
	expect(host.agents.get(voiced.id)?.options.voicePushArmed).toBe(true);

	const typed = await mgr.create({ name: "typed", repo, approvalMode: "yolo" });
	await mgr.applyCommand({ type: "prompt", id: typed.id, message: "go" }, LOCAL_ACTOR);
	expect(host.agents.get(typed.id)?.options.voicePushArmed).toBeUndefined();

	await mgr.stop();
});

test("a voice-sourced create (spawn) arms the latch directly on the persisted record", async () => {
	const { mgr, repo } = await makeMgr("arm-spawn");
	const host = mgr as unknown as InternalHost;
	const dto = await mgr.create({ name: "spawned", repo, approvalMode: "yolo" }, LOCAL_ACTOR, "voice");
	expect(host.agents.get(dto.id)?.options.voicePushArmed).toBe(true);
	// dto itself must NOT carry armed-ness at spawn time — exposure happens only at the dispatch's
	// terminal signal (onAgentEvent), never eagerly at create.
	expect(dto.voicePushArmed).toBeUndefined();
	await mgr.stop();
});

// ── disarm ───────────────────────────────────────────────────────────────

test("ANY interrupt disarms the latch (and clears the DTO projection) — a typed stop of voice work is still the operator cancelling it", async () => {
	const { mgr, repo } = await makeMgr("disarm");
	const host = mgr as unknown as InternalHost;

	const a = await mgr.create({ name: "a", repo, approvalMode: "yolo" });
	await mgr.applyCommand({ type: "prompt", id: a.id, message: "go", source: "voice" }, LOCAL_ACTOR);
	expect(host.agents.get(a.id)?.options.voicePushArmed).toBe(true);
	await mgr.applyCommand({ type: "interrupt", id: a.id, source: "voice" }, LOCAL_ACTOR);
	expect(host.agents.get(a.id)?.options.voicePushArmed).toBe(false);
	expect(host.agents.get(a.id)?.dto.voicePushArmed).toBe(false);

	// Source-blind on purpose: the cancel's own agent_end reads as a terminal idle, so an armed latch
	// surviving a TYPED stop would fire a "finished" push for work the operator just killed.
	const b = await mgr.create({ name: "b", repo, approvalMode: "yolo" });
	await mgr.applyCommand({ type: "prompt", id: b.id, message: "go", source: "voice" }, LOCAL_ACTOR);
	await mgr.applyCommand({ type: "interrupt", id: b.id }, LOCAL_ACTOR); // no source — still disarms
	expect(host.agents.get(b.id)?.options.voicePushArmed).toBe(false);

	await mgr.stop();
});

// ── persistence round-trip ──────────────────────────────────────────────

test("the armed latch survives a daemon restart", async () => {
	const repo = await makeRepo("persist-repo-");
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "persist-state-"));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "persist-wt-"));
	tmps.push(stateDir, worktreeBase);

	const mgr1 = new SquadManager({ stateDir, worktreeBase });
	await mgr1.start();
	(mgr1 as unknown as DriverFactoryHost).makeDriver = () => new AutoDriver();
	const dto = await mgr1.create({ name: "voiced", repo, approvalMode: "yolo" });
	// AutoDriver's prompt() resolves its own turn (agent_end) before applyCommand returns — the agent
	// reaches idle with the latch still armed (never disarmed here: only the server's push-sent hook
	// disarms it), mirroring "work finished while the daemon was down/the tab was closed".
	await mgr1.applyCommand({ type: "prompt", id: dto.id, message: "go", source: "voice" }, LOCAL_ACTOR);
	expect((mgr1 as unknown as InternalHost).agents.get(dto.id)?.options.voicePushArmed).toBe(true);
	// A dirty worktree — real produced work — so the restart-adopt path (persistedHasWork) actually
	// re-creates this agent. A genuinely CLEAN idle agent is dropped by that same pre-existing policy
	// (nothing to resume), independent of this concern; that's not what's under test here.
	await fs.writeFile(path.join(dto.worktree, "output.txt"), "done\n");
	await mgr1.stop();

	const mgr2 = new SquadManager({ stateDir, worktreeBase });
	(mgr2 as unknown as DriverFactoryHost).makeDriver = () => new AutoDriver();
	await mgr2.start();
	// No REAL detached process survives a fake-driver test (`agent.detach?.()` is a no-op on our fakes),
	// so this agent reattaches through the orphan-adopt path — same NAME, a freshly minted id (see
	// squad-manager.ts's adoptOrphanedAgents, and createWithId/CreateAgentOptions.voicePushArmed, which
	// carries the latch through that specific fresh-id boundary). Look it up by name, not id.
	const rec2 = [...(mgr2 as unknown as InternalHost).agents.values()].find((r) => r.options.name === "voiced");
	expect(rec2?.options.voicePushArmed).toBe(true);
	await mgr2.stop();
});

// ── workflow node-boundary exposure invariant ───────────────────────────

test("a workflow's intermediate agent_end never exposes the armed latch onto the DTO; only the agent_end paired with workflow_done does", async () => {
	const { mgr, repo } = await makeMgr("wf-expose");
	const host = mgr as unknown as InternalHost;

	const dto = await mgr.create({ name: "wf", repo, approvalMode: "yolo", workflow: "fake.yaml" }, LOCAL_ACTOR, "voice");
	const rec = host.agents.get(dto.id);
	if (!rec) throw new Error("agent not resident");
	expect(rec.options.kind).toBe("workflow");
	expect(rec.options.voicePushArmed).toBe(true);
	const driver = rec.agent as unknown as EventEmitter;

	// A human-gate/checkpoint boundary mid-graph: agent_start → agent_end with NO preceding
	// workflow_done. Must never expose the latch — the graph isn't actually done.
	driver.emit("event", { type: "agent_start" });
	driver.emit("event", { type: "agent_end" });
	expect(rec.dto.voicePushArmed).toBe(false);
	expect(rec.options.voicePushArmed).toBe(true); // the underlying latch stays armed, waiting for the real finish

	// The graph's real completion: workflow-driver.ts's execRun cleanup always emits workflow_done
	// immediately followed by agent_end.
	driver.emit("event", { type: "agent_start" });
	driver.emit("event", { type: "workflow_done", outcome: "succeeded" });
	driver.emit("event", { type: "agent_end" });
	expect(rec.dto.voicePushArmed).toBe(true);

	await mgr.stop();
});

test("a non-workflow agent's agent_end always exposes the armed latch (its one turn IS the terminal signal)", async () => {
	const { mgr, repo } = await makeMgr("plain-expose");
	const host = mgr as unknown as InternalHost;

	const dto = await mgr.create({ name: "plain", repo, approvalMode: "yolo" }, LOCAL_ACTOR, "voice");
	const rec = host.agents.get(dto.id);
	if (!rec) throw new Error("agent not resident");
	expect(rec.options.kind).toBe("omp-operator");
	const driver = rec.agent as unknown as EventEmitter;

	driver.emit("event", { type: "agent_start" });
	driver.emit("event", { type: "agent_end" });
	expect(rec.dto.voicePushArmed).toBe(true);

	await mgr.stop();
});
