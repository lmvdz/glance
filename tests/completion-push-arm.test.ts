/**
 * plans/voice-loop concern 01 + plans/daily-attention-w0 concern 01: the `completionPushArmed`
 * arm/disarm latch on squad-manager.ts — voice ALWAYS arms (never gated by settings); otherwise the
 * session's category decides (casual console chats ON by default via OMP_SQUAD_PUSH_CASUAL_DONE,
 * fleet units OFF by default via OMP_SQUAD_PUSH_FLEET_DONE). Also: disarm on ANY `interrupt`,
 * promote() clearing an unconsumed category latch at the casual→fleet boundary, persistence
 * round-trip across a daemon restart (including the legacy `voicePushArmed` field migration), and
 * the workflow-node-boundary exposure invariant (`onAgentEvent`'s `agent_end`/`workflow_done`
 * handling) that keeps a multi-node workflow from mistaking a mid-graph idle blip for its real
 * finish. push.ts's `completionPayload` unit tests and server.ts's `maybePushAlert` integration
 * tests live in push.test.ts / push-server.test.ts.
 */

import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { armCompletionPushKind } from "../src/completion-push.ts";
import { CONSOLE_SYSTEM_PROMPT } from "../src/console-prompt.ts";
import { FileStore } from "../src/dal/store.ts";
import { LOCAL_ACTOR } from "../src/federation.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { AgentDTO, PersistedAgent, RpcSessionState } from "../src/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

/** Run `fn` with completion-push category flags pinned, restoring the ambient env afterwards —
 *  the manager arm sites read process.env at decision time (the settings.json → env mirror). */
async function withPushFlags(flags: { casual?: string; fleet?: string }, fn: () => Promise<void>): Promise<void> {
	const prior = { casual: process.env.OMP_SQUAD_PUSH_CASUAL_DONE, fleet: process.env.OMP_SQUAD_PUSH_FLEET_DONE };
	if (flags.casual === undefined) delete process.env.OMP_SQUAD_PUSH_CASUAL_DONE;
	else process.env.OMP_SQUAD_PUSH_CASUAL_DONE = flags.casual;
	if (flags.fleet === undefined) delete process.env.OMP_SQUAD_PUSH_FLEET_DONE;
	else process.env.OMP_SQUAD_PUSH_FLEET_DONE = flags.fleet;
	try {
		await fn();
	} finally {
		if (prior.casual === undefined) delete process.env.OMP_SQUAD_PUSH_CASUAL_DONE;
		else process.env.OMP_SQUAD_PUSH_CASUAL_DONE = prior.casual;
		if (prior.fleet === undefined) delete process.env.OMP_SQUAD_PUSH_FLEET_DONE;
		else process.env.OMP_SQUAD_PUSH_FLEET_DONE = prior.fleet;
	}
}

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

// ── the pure arm decision (completion-push.ts) ───────────────────────────

test("armCompletionPushKind: voice always arms, regardless of category or flags", () => {
	const off = { OMP_SQUAD_PUSH_CASUAL_DONE: "0", OMP_SQUAD_PUSH_FLEET_DONE: "0" } as NodeJS.ProcessEnv;
	expect(armCompletionPushKind({}, "voice", off)).toBe("voice");
	expect(armCompletionPushKind({ appendSystemPrompt: CONSOLE_SYSTEM_PROMPT }, "voice", off)).toBe("voice");
	expect(armCompletionPushKind({ appendSystemPrompt: CONSOLE_SYSTEM_PROMPT, promoted: true }, "voice", off)).toBe("voice");
});

test("armCompletionPushKind: a casual session (console prompt, unpromoted) arms by default; explicit 0 suppresses it", () => {
	const casual = { appendSystemPrompt: CONSOLE_SYSTEM_PROMPT };
	expect(armCompletionPushKind(casual, undefined, {} as NodeJS.ProcessEnv)).toBe("category"); // default ON with the flag unset
	expect(armCompletionPushKind(casual, undefined, { OMP_SQUAD_PUSH_CASUAL_DONE: "0" } as NodeJS.ProcessEnv)).toBeUndefined();
});

test("armCompletionPushKind: a fleet session does NOT arm by default; explicit 1 arms it", () => {
	expect(armCompletionPushKind({}, undefined, {} as NodeJS.ProcessEnv)).toBeUndefined(); // no console prompt = fleet, default OFF
	expect(armCompletionPushKind({ appendSystemPrompt: "some profile bundle" }, undefined, {} as NodeJS.ProcessEnv)).toBeUndefined();
	expect(armCompletionPushKind({}, undefined, { OMP_SQUAD_PUSH_FLEET_DONE: "1" } as NodeJS.ProcessEnv)).toBe("category");
});

test("armCompletionPushKind: a PROMOTED former-casual session is fleet — casual flag no longer applies", () => {
	// A promoted console chat still carrying the console prompt (the classifier's promoted test) …
	expect(armCompletionPushKind({ appendSystemPrompt: CONSOLE_SYSTEM_PROMPT, promoted: true }, undefined, {} as NodeJS.ProcessEnv)).toBeUndefined();
	// … and one restored through a fresh-id path (promoted not carried, but promote() stripped the
	// console prompt) — fleet by the OTHER half of the classifier, so restores stay correct too.
	expect(armCompletionPushKind({ appendSystemPrompt: undefined, promoted: undefined }, undefined, {} as NodeJS.ProcessEnv)).toBeUndefined();
	expect(armCompletionPushKind({ appendSystemPrompt: CONSOLE_SYSTEM_PROMPT, promoted: true }, undefined, { OMP_SQUAD_PUSH_FLEET_DONE: "1" } as NodeJS.ProcessEnv)).toBe("category");
});

// ── arm (manager wiring) ─────────────────────────────────────────────────

test("a voice-sourced prompt arms the completion-push latch; a plain FLEET prompt does not", async () => {
	const { mgr, repo } = await makeMgr("arm");
	const host = mgr as unknown as InternalHost;

	const voiced = await mgr.create({ name: "voiced", repo, approvalMode: "yolo" });
	await mgr.applyCommand({ type: "prompt", id: voiced.id, message: "go", source: "voice" }, LOCAL_ACTOR);
	expect(host.agents.get(voiced.id)?.options.completionPushArmed).toBe(true);
	expect(host.agents.get(voiced.id)?.options.completionPushKind).toBe("voice");

	const typed = await mgr.create({ name: "typed", repo, approvalMode: "yolo" });
	await mgr.applyCommand({ type: "prompt", id: typed.id, message: "go" }, LOCAL_ACTOR);
	expect(host.agents.get(typed.id)?.options.completionPushArmed).toBeUndefined();

	await mgr.stop();
});

test("voice arms even with BOTH category flags explicitly off (a voice dispatch is never gated by settings)", async () => {
	await withPushFlags({ casual: "0", fleet: "0" }, async () => {
		const { mgr, repo } = await makeMgr("arm-voice-gated");
		const host = mgr as unknown as InternalHost;
		const dto = await mgr.create({ name: "voiced", repo, approvalMode: "yolo" }, LOCAL_ACTOR, "voice");
		expect(host.agents.get(dto.id)?.options.completionPushArmed).toBe(true);
		expect(host.agents.get(dto.id)?.options.completionPushKind).toBe("voice");
		await mgr.stop();
	});
});

test("a voice-sourced create (spawn) arms the latch directly on the persisted record", async () => {
	const { mgr, repo } = await makeMgr("arm-spawn");
	const host = mgr as unknown as InternalHost;
	const dto = await mgr.create({ name: "spawned", repo, approvalMode: "yolo" }, LOCAL_ACTOR, "voice");
	expect(host.agents.get(dto.id)?.options.completionPushArmed).toBe(true);
	// dto itself must NOT carry armed-ness at spawn time — exposure happens only at the dispatch's
	// terminal signal (onAgentEvent), never eagerly at create.
	expect(dto.completionPushArmed).toBeUndefined();
	await mgr.stop();
});

test("a CASUAL console-chat session arms by default (flag unset ⇒ defaultEnabled true), kind category", async () => {
	await withPushFlags({}, async () => {
		const { mgr, repo } = await makeMgr("arm-casual");
		const host = mgr as unknown as InternalHost;
		// The exact unit shape POST /api/console (and glance here through it) creates.
		const dto = await mgr.create({ name: "chat", repo, approvalMode: "yolo", autoRoute: false, appendSystemPrompt: CONSOLE_SYSTEM_PROMPT });
		expect(host.agents.get(dto.id)?.options.completionPushArmed).toBe(true);
		expect(host.agents.get(dto.id)?.options.completionPushKind).toBe("category");
		expect(dto.completionPushArmed).toBeUndefined(); // never exposed eagerly at create
		await mgr.stop();
	});
});

test("OMP_SQUAD_PUSH_CASUAL_DONE=0 suppresses the casual arm; OMP_SQUAD_PUSH_FLEET_DONE=1 arms a fleet unit", async () => {
	await withPushFlags({ casual: "0", fleet: "1" }, async () => {
		const { mgr, repo } = await makeMgr("arm-flags");
		const host = mgr as unknown as InternalHost;

		const chat = await mgr.create({ name: "chat", repo, approvalMode: "yolo", appendSystemPrompt: CONSOLE_SYSTEM_PROMPT });
		expect(host.agents.get(chat.id)?.options.completionPushArmed).toBeUndefined();
		await mgr.applyCommand({ type: "prompt", id: chat.id, message: "hi" }, LOCAL_ACTOR);
		expect(host.agents.get(chat.id)?.options.completionPushArmed).toBeUndefined();

		const fleet = await mgr.create({ name: "fleet-unit", repo, approvalMode: "yolo" });
		expect(host.agents.get(fleet.id)?.options.completionPushArmed).toBe(true);
		expect(host.agents.get(fleet.id)?.options.completionPushKind).toBe("category");

		await mgr.stop();
	});
});

test("a re-arm takes the LATEST prompt's kind (voice→typed downgrades to category, typed→voice upgrades)", async () => {
	const { mgr, repo } = await makeMgr("arm-latest");
	const host = mgr as unknown as InternalHost;
	const dto = await mgr.create({ name: "chat", repo, approvalMode: "yolo", appendSystemPrompt: CONSOLE_SYSTEM_PROMPT });
	expect(host.agents.get(dto.id)?.options.completionPushKind).toBe("category");
	await mgr.applyCommand({ type: "prompt", id: dto.id, message: "go", source: "voice" }, LOCAL_ACTOR);
	expect(host.agents.get(dto.id)?.options.completionPushKind).toBe("voice");
	await mgr.applyCommand({ type: "prompt", id: dto.id, message: "actually do this instead" }, LOCAL_ACTOR);
	expect(host.agents.get(dto.id)?.options.completionPushArmed).toBe(true);
	expect(host.agents.get(dto.id)?.options.completionPushKind).toBe("category");
	await mgr.stop();
});

// ── disarm ───────────────────────────────────────────────────────────────

test("ANY interrupt disarms the latch (and clears the DTO projection) — a typed stop of voice work is still the operator cancelling it", async () => {
	const { mgr, repo } = await makeMgr("disarm");
	const host = mgr as unknown as InternalHost;

	const a = await mgr.create({ name: "a", repo, approvalMode: "yolo" });
	await mgr.applyCommand({ type: "prompt", id: a.id, message: "go", source: "voice" }, LOCAL_ACTOR);
	expect(host.agents.get(a.id)?.options.completionPushArmed).toBe(true);
	await mgr.applyCommand({ type: "interrupt", id: a.id, source: "voice" }, LOCAL_ACTOR);
	expect(host.agents.get(a.id)?.options.completionPushArmed).toBe(false);
	expect(host.agents.get(a.id)?.options.completionPushKind).toBeUndefined();
	expect(host.agents.get(a.id)?.dto.completionPushArmed).toBe(false);

	// Source-blind on purpose: the cancel's own agent_end reads as a terminal idle, so an armed latch
	// surviving a TYPED stop would fire a "finished" push for work the operator just killed.
	const b = await mgr.create({ name: "b", repo, approvalMode: "yolo" });
	await mgr.applyCommand({ type: "prompt", id: b.id, message: "go", source: "voice" }, LOCAL_ACTOR);
	await mgr.applyCommand({ type: "interrupt", id: b.id }, LOCAL_ACTOR); // no source — still disarms
	expect(host.agents.get(b.id)?.options.completionPushArmed).toBe(false);

	await mgr.stop();
});

// ── promote: the casual→fleet category flip ─────────────────────────────

test("promote() clears an unconsumed CATEGORY latch, and the next prompt does not re-arm (fleet default OFF)", async () => {
	await withPushFlags({}, async () => {
		const { mgr, repo } = await makeMgr("promote-flip");
		const host = mgr as unknown as InternalHost;

		const dto = await mgr.create({ name: "chat", repo, approvalMode: "yolo", appendSystemPrompt: CONSOLE_SYSTEM_PROMPT });
		await mgr.applyCommand({ type: "prompt", id: dto.id, message: "explore this" }, LOCAL_ACTOR);
		const rec = host.agents.get(dto.id);
		if (!rec) throw new Error("agent not resident");
		expect(rec.options.completionPushArmed).toBe(true); // armed as casual

		const res = await mgr.promote(dto.id, {});
		expect(res.ok).toBe(true);
		// The unconsumed casual latch must not ride across the casual→fleet boundary — the promoted
		// unit's very next idle would otherwise push despite fleet completion being off by default.
		expect(rec.options.completionPushArmed).toBe(false);
		expect(rec.options.completionPushKind).toBeUndefined();

		// The NEXT prompt after promotion evaluates as fleet (promoted:true + console prompt stripped)
		// with zero extra bookkeeping — no re-arm, so its terminal agent_end exposes nothing.
		await mgr.applyCommand({ type: "prompt", id: dto.id, message: "now build it" }, LOCAL_ACTOR);
		expect(rec.options.completionPushArmed).toBe(false);
		const driver = rec.agent as unknown as EventEmitter;
		driver.emit("event", { type: "agent_start" });
		driver.emit("event", { type: "agent_end" });
		expect(rec.dto.completionPushArmed).toBe(false);

		await mgr.stop();
	});
});

test("after promotion, OMP_SQUAD_PUSH_FLEET_DONE=1 arms the promoted unit again", async () => {
	await withPushFlags({ fleet: "1" }, async () => {
		const { mgr, repo } = await makeMgr("promote-fleet-on");
		const host = mgr as unknown as InternalHost;
		const dto = await mgr.create({ name: "chat", repo, approvalMode: "yolo", appendSystemPrompt: CONSOLE_SYSTEM_PROMPT });
		expect((await mgr.promote(dto.id, {})).ok).toBe(true);
		await mgr.applyCommand({ type: "prompt", id: dto.id, message: "build it" }, LOCAL_ACTOR);
		expect(host.agents.get(dto.id)?.options.completionPushArmed).toBe(true);
		expect(host.agents.get(dto.id)?.options.completionPushKind).toBe("category");
		await mgr.stop();
	});
});

test("promote() leaves a VOICE-armed latch alone (voice arms unconditionally, category is irrelevant)", async () => {
	const { mgr, repo } = await makeMgr("promote-voice");
	const host = mgr as unknown as InternalHost;
	const dto = await mgr.create({ name: "chat", repo, approvalMode: "yolo", appendSystemPrompt: CONSOLE_SYSTEM_PROMPT });
	await mgr.applyCommand({ type: "prompt", id: dto.id, message: "go", source: "voice" }, LOCAL_ACTOR);
	expect((await mgr.promote(dto.id, {})).ok).toBe(true);
	expect(host.agents.get(dto.id)?.options.completionPushArmed).toBe(true);
	expect(host.agents.get(dto.id)?.options.completionPushKind).toBe("voice");
	await mgr.stop();
});

// ── persistence round-trip ──────────────────────────────────────────────

test("the armed latch (and its kind) survives a daemon restart", async () => {
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
	expect((mgr1 as unknown as InternalHost).agents.get(dto.id)?.options.completionPushArmed).toBe(true);
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
	// squad-manager.ts's adoptOrphanedAgents, and createWithId/CreateAgentOptions.completionPushArmed,
	// which carries the latch through that specific fresh-id boundary). Look it up by name, not id.
	const rec2 = [...(mgr2 as unknown as InternalHost).agents.values()].find((r) => r.options.name === "voiced");
	expect(rec2?.options.completionPushArmed).toBe(true);
	expect(rec2?.options.completionPushKind).toBe("voice");
	await mgr2.stop();
});

test("a LEGACY persisted record (pre-rename `voicePushArmed`) migrates forward at load and still owes its push", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "legacy-state-"));
	tmps.push(stateDir);
	// A state.json written by the pre-rename daemon: the latch under its old name, no kind field.
	const legacy = { id: "old1", name: "voiced", repo: "/r", worktree: "/w", approvalMode: "yolo", voicePushArmed: true };
	await fs.writeFile(path.join(stateDir, "state.json"), JSON.stringify({ version: 1, agents: [legacy], transcripts: {}, features: [] }));
	const store = new FileStore(stateDir);
	const snapshot = await store.load();
	expect(snapshot.agents).toHaveLength(1);
	expect(snapshot.agents[0]!.completionPushArmed).toBe(true);
	expect(snapshot.agents[0]!.completionPushKind).toBe("voice"); // voice was the only legacy arm source
});

// ── workflow node-boundary exposure invariant ───────────────────────────

test("a workflow's intermediate agent_end never exposes the armed latch onto the DTO; only the agent_end paired with workflow_done does", async () => {
	const { mgr, repo } = await makeMgr("wf-expose");
	const host = mgr as unknown as InternalHost;

	const dto = await mgr.create({ name: "wf", repo, approvalMode: "yolo", workflow: "fake.yaml" }, LOCAL_ACTOR, "voice");
	const rec = host.agents.get(dto.id);
	if (!rec) throw new Error("agent not resident");
	expect(rec.options.kind).toBe("workflow");
	expect(rec.options.completionPushArmed).toBe(true);
	const driver = rec.agent as unknown as EventEmitter;

	// A human-gate/checkpoint boundary mid-graph: agent_start → agent_end with NO preceding
	// workflow_done. Must never expose the latch — the graph isn't actually done.
	driver.emit("event", { type: "agent_start" });
	driver.emit("event", { type: "agent_end" });
	expect(rec.dto.completionPushArmed).toBe(false);
	expect(rec.dto.completionPushKind).toBeUndefined();
	expect(rec.options.completionPushArmed).toBe(true); // the underlying latch stays armed, waiting for the real finish

	// The graph's real completion: workflow-driver.ts's execRun cleanup always emits workflow_done
	// immediately followed by agent_end.
	driver.emit("event", { type: "agent_start" });
	driver.emit("event", { type: "workflow_done", outcome: "succeeded" });
	driver.emit("event", { type: "agent_end" });
	expect(rec.dto.completionPushArmed).toBe(true);
	expect(rec.dto.completionPushKind).toBe("voice");

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
	expect(rec.dto.completionPushArmed).toBe(true);
	expect(rec.dto.completionPushKind).toBe("voice");

	await mgr.stop();
});
