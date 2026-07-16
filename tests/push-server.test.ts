/**
 * Integration: a manager status event flows through the server and fires a push
 * (broadcast → maybePushAlert → escalationPayload → PushService dispatch).
 */

import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { CONSOLE_SYSTEM_PROMPT } from "../src/console-prompt.ts";
import { LOCAL_ACTOR } from "../src/federation.ts";
import { PushService, type PushSend } from "../src/push.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer } from "../src/server.ts";
import type { AgentDTO, AgentStatus, PersistedAgent, RpcSessionState } from "../src/types.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

function agent(status: AgentStatus, over: Partial<AgentDTO> = {}): AgentDTO {
	return { id: "x1", name: "alpha", status, kind: "omp-operator", repo: "/r", worktree: "/w", approvalMode: "yolo", pending: [], lastActivity: 0, messageCount: 0, ...over };
}

/** Never spawns a real process — for tests that need a REAL resident agent (so `manager.list()` /
 *  `clearCompletionPushArmed` have something to act on) but drive the push lane itself via synthetic
 *  `mgr.emit("event", ...)` DTOs, same as the tests above. */
class NoopDriver extends EventEmitter implements AgentDriver {
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
interface InternalHost {
	agents: Map<string, { options: PersistedAgent }>;
}

async function makeRepo(prefix: string): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
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

/** Poll until `predicate` is true — avoids a fixed sleep for the manager-side disarm, which fires off
 *  `push.notify()`'s OWN async resolution, one tick after the test's `sent` promise resolves. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
		await new Promise((r) => setTimeout(r, 5));
	}
}

test("a transition into input drives a real encrypted push through the server", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pushint-"));
	const calls: Array<{ endpoint: string; enc: string; len: number }> = [];
	let resolveSend: () => void = () => {};
	const sent = new Promise<void>((r) => {
		resolveSend = r;
	});
	const send: PushSend = async (endpoint, headers, body) => {
		calls.push({ endpoint, enc: headers["content-encoding"], len: body.length });
		resolveSend();
		return { status: 201 };
	};
	const push = new PushService(dir, { send });
	await push.init();

	// a browser-shaped subscription so encryption has a real UA public key
	const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const p256dh = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))).toString("base64url");
	const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
	await push.subscribe({ endpoint: "https://push.example.com/device", keys: { p256dh, auth } });

	const mgr = new SquadManager({ stateDir: dir });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0, push });
	server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});

	// seed the roster (no alert), then transition the agent into input
	mgr.emit("event", { type: "roster", agents: [agent("idle")] });
	mgr.emit("event", { type: "agent", agent: agent("input", { pending: [{ id: "p", source: "ui", kind: "select", title: "approve?", createdAt: 0 }] }) });

	await sent; // resolves when the push is dispatched — no polling
	expect(calls).toHaveLength(1);
	expect(calls[0].endpoint).toBe("https://push.example.com/device");
	expect(calls[0].enc).toBe("aes128gcm");
	expect(calls[0].len).toBeGreaterThan(80);
});

test("seeding + calm transitions do not push", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pushint2-"));
	let count = 0;
	const send: PushSend = async () => {
		count++;
		return { status: 201 };
	};
	const push = new PushService(dir, { send });
	await push.init();
	const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const p256dh = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))).toString("base64url");
	await push.subscribe({ endpoint: "https://push.example.com/d", keys: { p256dh, auth: "AAAAAAAAAAAAAAAAAAAAAA" } });
	const mgr = new SquadManager({ stateDir: dir });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0, push });
	server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});

	mgr.emit("event", { type: "roster", agents: [agent("working")] }); // seed
	mgr.emit("event", { type: "agent", agent: agent("idle") }); // working→idle, calm
	// give any erroneous dispatch a chance to run before asserting
	await mgr.stop();
	expect(count).toBe(0);
});

// ── voice-loop completion push (plans/voice-loop concern 01) ────────────────

test("a voice-armed working→idle transition drives a completion push through the server, and disarms the manager's latch", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pushdone-"));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "pushdone-wt-"));
	const repo = await makeRepo("pushdone-repo-");
	const calls: string[] = [];
	let resolveSend: () => void = () => {};
	const sent = new Promise<void>((r) => {
		resolveSend = r;
	});
	const send: PushSend = async (endpoint) => {
		calls.push(endpoint);
		resolveSend();
		return { status: 201 };
	};
	const push = new PushService(dir, { send });
	await push.init();
	const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const p256dh = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))).toString("base64url");
	const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
	await push.subscribe({ endpoint: "https://push.example.com/device", keys: { p256dh, auth } });

	const mgr = new SquadManager({ stateDir: dir, worktreeBase });
	await mgr.start();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new NoopDriver();
	// A REAL resident agent, armed through the actual manager path (not a synthetic DTO) — the manager's
	// clearCompletionPushArmed disarm needs a resident record to act on.
	const dto = await mgr.create({ name: "voiced", repo, approvalMode: "yolo" });
	await mgr.applyCommand({ type: "prompt", id: dto.id, message: "go", source: "voice" }, LOCAL_ACTOR);
	expect((mgr as unknown as InternalHost).agents.get(dto.id)?.options.completionPushArmed).toBe(true);

	const server = new SquadServer(mgr, { port: 0, push });
	server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(dir, { recursive: true, force: true });
		await fs.rm(worktreeBase, { recursive: true, force: true });
		await fs.rm(repo, { recursive: true, force: true });
	});

	// Drive the push lane with a synthetic terminal event (the real onAgentEvent exposure path is
	// covered by tests/completion-push-arm.test.ts) — seed, then the armed working→idle transition.
	mgr.emit("event", { type: "roster", agents: [agent("working", { id: dto.id, name: "voiced" })] });
	mgr.emit("event", { type: "agent", agent: agent("idle", { id: dto.id, name: "voiced", completionPushArmed: true, completionPushKind: "voice" }) });

	await sent; // resolves when the push is dispatched — no polling
	expect(calls).toEqual(["https://push.example.com/device"]);
	await waitFor(() => (mgr as unknown as InternalHost).agents.get(dto.id)?.options.completionPushArmed === false);
	expect((mgr as unknown as InternalHost).agents.get(dto.id)?.options.completionPushArmed).toBe(false);
});

test("an escalation and a completion push for the SAME agent within 3s of each other both send (separate debounce keys)", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pushboth-"));
	const calls: number[] = [];
	let resolveSecond: () => void = () => {};
	const second = new Promise<void>((r) => {
		resolveSecond = r;
	});
	const send: PushSend = async () => {
		calls.push(Date.now());
		if (calls.length === 2) resolveSecond();
		return { status: 201 };
	};
	const push = new PushService(dir, { send });
	await push.init();
	const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const p256dh = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))).toString("base64url");
	await push.subscribe({ endpoint: "https://push.example.com/d", keys: { p256dh, auth: "AAAAAAAAAAAAAAAAAAAAAA" } });

	const mgr = new SquadManager({ stateDir: dir });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0, push });
	server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});

	mgr.emit("event", { type: "roster", agents: [agent("working")] }); // seed
	// Escalation ("needs you") writes lastPush["x1"] — WITHOUT the done: namespace this would wrongly
	// debounce-block the completion push that follows a moment later for the SAME agent id.
	mgr.emit("event", { type: "agent", agent: agent("input", { pending: [{ id: "p", source: "ui", kind: "select", title: "approve?", createdAt: 0 }] }) });
	mgr.emit("event", { type: "agent", agent: agent("idle", { completionPushArmed: true, completionPushKind: "voice" }) });

	await second; // resolves once BOTH sends have happened — no polling
	expect(calls).toHaveLength(2);
});

// ── casual→fleet category flip mid-session (daily-attention-w0 concern 01) ──

test("a casual chat pushes on completion by default; after promote() the next idle does NOT push unless OMP_SQUAD_PUSH_FLEET_DONE is on", async () => {
	const priorEnv = { casual: process.env.OMP_SQUAD_PUSH_CASUAL_DONE, fleet: process.env.OMP_SQUAD_PUSH_FLEET_DONE, minTurn: process.env.OMP_SQUAD_PUSH_MIN_TURN_MS };
	delete process.env.OMP_SQUAD_PUSH_CASUAL_DONE; // defaults under test: casual ON, fleet OFF
	delete process.env.OMP_SQUAD_PUSH_FLEET_DONE;
	// This test isolates the CATEGORY decision, not the duration gate — its turns are instantaneous, so
	// disable the gate here (0). The gate has its own dedicated server-layer test below.
	process.env.OMP_SQUAD_PUSH_MIN_TURN_MS = "0";
	cleanups.push(() => {
		if (priorEnv.casual === undefined) delete process.env.OMP_SQUAD_PUSH_CASUAL_DONE;
		else process.env.OMP_SQUAD_PUSH_CASUAL_DONE = priorEnv.casual;
		if (priorEnv.fleet === undefined) delete process.env.OMP_SQUAD_PUSH_FLEET_DONE;
		else process.env.OMP_SQUAD_PUSH_FLEET_DONE = priorEnv.fleet;
		if (priorEnv.minTurn === undefined) delete process.env.OMP_SQUAD_PUSH_MIN_TURN_MS;
		else process.env.OMP_SQUAD_PUSH_MIN_TURN_MS = priorEnv.minTurn;
	});

	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pushpromote-"));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "pushpromote-wt-"));
	const repo = await makeRepo("pushpromote-repo-");
	const calls: string[] = [];
	const send: PushSend = async (endpoint) => {
		calls.push(endpoint);
		return { status: 201 };
	};
	const push = new PushService(dir, { send });
	await push.init();
	const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const p256dh = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))).toString("base64url");
	const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
	await push.subscribe({ endpoint: "https://push.example.com/casual", keys: { p256dh, auth } });

	const mgr = new SquadManager({ stateDir: dir, worktreeBase });
	await mgr.start();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new NoopDriver();
	// The exact unit shape POST /api/console (and glance here) creates — casual: console prompt, unpromoted.
	const dto = await mgr.create({ name: "chat", repo, approvalMode: "yolo", autoRoute: false, appendSystemPrompt: CONSOLE_SYSTEM_PROMPT });
	const rec = (mgr as unknown as { agents: Map<string, { options: PersistedAgent; agent: AgentDriver }> }).agents.get(dto.id);
	if (!rec) throw new Error("agent not resident");
	expect(rec.options.completionPushArmed).toBe(true); // casual arms by default (flag unset ⇒ ON)

	const server = new SquadServer(mgr, { port: 0, push });
	server.start();
	const lastPush = (server as unknown as { lastPush: Map<string, number> }).lastPush;
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(dir, { recursive: true, force: true });
		await fs.rm(worktreeBase, { recursive: true, force: true });
		await fs.rm(repo, { recursive: true, force: true });
	});

	// Phase 1: a REAL turn end-to-end — typed prompt, then the driver's own terminal agent_end. The
	// working→idle edge must fire the completion push and consume the latch.
	await mgr.applyCommand({ type: "prompt", id: dto.id, message: "hi" }, LOCAL_ACTOR);
	(rec.agent as unknown as EventEmitter).emit("event", { type: "agent_end" });
	await waitFor(() => calls.length === 1);
	await waitFor(() => rec.options.completionPushArmed === false); // sync-disarm consumed it

	// Phase 2: promote() flips the category casual→fleet mid-session. The next turn must NOT re-arm
	// (fleet completion defaults OFF) and its idle must NOT push. Clear the done: debounce slot first so
	// a silent push could only be blocked by the category decision, never by the 3s debounce window.
	expect((await mgr.promote(dto.id, {})).ok).toBe(true);
	lastPush.clear();
	await mgr.applyCommand({ type: "prompt", id: dto.id, message: "now build it" }, LOCAL_ACTOR);
	expect(rec.options.completionPushArmed).toBe(false); // fleet default OFF — no re-arm
	(rec.agent as unknown as EventEmitter).emit("event", { type: "agent_end" });
	await new Promise((r) => setTimeout(r, 25)); // give an erroneous dispatch a chance to run
	expect(calls).toHaveLength(1); // still just the casual push

	// Phase 3: OMP_SQUAD_PUSH_FLEET_DONE=1 re-enables completion pushes for the promoted unit.
	process.env.OMP_SQUAD_PUSH_FLEET_DONE = "1";
	lastPush.clear();
	await mgr.applyCommand({ type: "prompt", id: dto.id, message: "and again" }, LOCAL_ACTOR);
	expect(rec.options.completionPushArmed).toBe(true);
	expect(rec.options.completionPushKind).toBe("category");
	(rec.agent as unknown as EventEmitter).emit("event", { type: "agent_end" });
	await waitFor(() => calls.length === 2);
});

test("duration gate (daily-attention-w0 01): a short casual turn does NOT push and keeps the latch armed; a long one fires and consumes it", async () => {
	const priorEnv = { casual: process.env.OMP_SQUAD_PUSH_CASUAL_DONE, minTurn: process.env.OMP_SQUAD_PUSH_MIN_TURN_MS };
	delete process.env.OMP_SQUAD_PUSH_CASUAL_DONE; // casual default ON
	process.env.OMP_SQUAD_PUSH_MIN_TURN_MS = "20000"; // 20s floor under test
	cleanups.push(() => {
		if (priorEnv.casual === undefined) delete process.env.OMP_SQUAD_PUSH_CASUAL_DONE;
		else process.env.OMP_SQUAD_PUSH_CASUAL_DONE = priorEnv.casual;
		if (priorEnv.minTurn === undefined) delete process.env.OMP_SQUAD_PUSH_MIN_TURN_MS;
		else process.env.OMP_SQUAD_PUSH_MIN_TURN_MS = priorEnv.minTurn;
	});

	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pushgate-"));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "pushgate-wt-"));
	const repo = await makeRepo("pushgate-repo-");
	const calls: string[] = [];
	const send: PushSend = async (endpoint) => {
		calls.push(endpoint);
		return { status: 201 };
	};
	const push = new PushService(dir, { send });
	await push.init();
	const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const p256dh = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))).toString("base64url");
	const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
	await push.subscribe({ endpoint: "https://push.example.com/gate", keys: { p256dh, auth } });

	const mgr = new SquadManager({ stateDir: dir, worktreeBase });
	await mgr.start();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new NoopDriver();
	const dto = await mgr.create({ name: "chat", repo, approvalMode: "yolo", autoRoute: false, appendSystemPrompt: CONSOLE_SYSTEM_PROMPT });
	const rec = (mgr as unknown as { agents: Map<string, { options: PersistedAgent; agent: AgentDriver }> }).agents.get(dto.id);
	if (!rec) throw new Error("agent not resident");

	const server = new SquadServer(mgr, { port: 0, push });
	server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(dir, { recursive: true, force: true });
		await fs.rm(worktreeBase, { recursive: true, force: true });
		await fs.rm(repo, { recursive: true, force: true });
	});

	// Phase A — a SHORT turn (armedAt ≈ now, well under the 20s floor). The working→idle edge must be
	// gated: no push, and the latch stays armed (the owed push is not consumed, just deferred).
	await mgr.applyCommand({ type: "prompt", id: dto.id, message: "hi" }, LOCAL_ACTOR);
	(rec.agent as unknown as EventEmitter).emit("event", { type: "agent_end" });
	await new Promise((r) => setTimeout(r, 40)); // give an erroneous push a chance to fire
	expect(calls).toHaveLength(0);
	expect(rec.options.completionPushArmed).toBe(true); // still owed — not consumed by a gated non-push

	// Phase B — a LONG turn. Re-prompt (fresh working→idle edge + re-arm), then back-date the arm past
	// the floor to simulate a turn that actually ran long. Now the edge must push and consume the latch.
	await mgr.applyCommand({ type: "prompt", id: dto.id, message: "take your time" }, LOCAL_ACTOR);
	rec.options.completionArmedAt = Date.now() - 21_000; // 21s ago — over the 20s floor
	(rec.agent as unknown as EventEmitter).emit("event", { type: "agent_end" });
	await waitFor(() => calls.length === 1);
	expect(calls).toEqual(["https://push.example.com/gate"]);
	await waitFor(() => rec.options.completionPushArmed === false); // consumed only now
});

test("push fires on the first status change after a restart, with no snapshot/roster event ever sent (startup-seed fix)", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "pushseed-state-"));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "pushseed-wt-"));
	const repo = await makeRepo("pushseed-repo-");

	const mgr1 = new SquadManager({ stateDir, worktreeBase });
	await mgr1.start();
	(mgr1 as unknown as DriverFactoryHost).makeDriver = () => new NoopDriver();
	const seedDto = await mgr1.create({ name: "voiced", repo, approvalMode: "yolo" });
	// A dirty worktree — real produced work — so the restart-adopt path (squad-manager.ts's
	// persistedHasWork) actually re-creates this agent instead of dropping a genuinely clean idle one
	// (a separate, pre-existing policy unrelated to this seed fix).
	await fs.writeFile(path.join(seedDto.worktree, "output.txt"), "done\n");
	await mgr1.stop();

	const calls: string[] = [];
	let resolveSend: () => void = () => {};
	const sent = new Promise<void>((r) => {
		resolveSend = r;
	});
	const send: PushSend = async (endpoint) => {
		calls.push(endpoint);
		resolveSend();
		return { status: 201 };
	};
	const push = new PushService(stateDir, { send });
	await push.init();
	const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const p256dh = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))).toString("base64url");
	const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
	await push.subscribe({ endpoint: "https://push.example.com/restart-device", keys: { p256dh, auth } });

	const mgr2 = new SquadManager({ stateDir, worktreeBase });
	(mgr2 as unknown as DriverFactoryHost).makeDriver = () => new NoopDriver();
	await mgr2.start(); // reattach/adopt happens here — whatever id the agent comes back under
	const roster = mgr2.list();
	expect(roster.length).toBeGreaterThan(0);
	const id = roster[0].id;

	// server.start() is the fix under test: it must seed lastStatus + pushSeeded from manager.list()
	// itself — NO "snapshot" command (the only thing that used to seed it) is ever sent below.
	const server = new SquadServer(mgr2, { port: 0, push });
	server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr2.stop();
		await fs.rm(stateDir, { recursive: true, force: true });
		await fs.rm(worktreeBase, { recursive: true, force: true });
		await fs.rm(repo, { recursive: true, force: true });
	});

	mgr2.emit("event", { type: "agent", agent: agent("input", { id, name: "voiced", pending: [{ id: "p", source: "ui", kind: "select", title: "approve?", createdAt: 0 }] }) });

	await sent; // resolves when the push is dispatched — no polling, no roster/snapshot event ever sent
	expect(calls).toEqual(["https://push.example.com/restart-device"]);
});
