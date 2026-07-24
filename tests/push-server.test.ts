/**
 * Integration: a manager status change flows through the server and fires a push
 * (broadcast → maybePushAlert → escalationPayload/completionPayload → PushService dispatch).
 *
 * daily-attention-w0 concern 02: maybePushAlert reads `from`/`to` off the canonical
 * `{type:"transition"}` SquadEvent (squad-manager.ts's guarded transition()/recordTransition()
 * write path) — the private per-agent `lastStatus` diff over `{type:"agent"}` events is retired.
 * Synthetic-event tests below therefore drive the lane with transition entries against REAL
 * resident agents (getAgent(entry.agentId) supplies the DTO the payload builders need); the
 * real-flow tests (prompt → agent_end) are unchanged because the genuine machinery emits the
 * transition event itself.
 */

import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { _resetPushTapRateLimitsForTests } from "../src/authz.ts";
import { CONSOLE_SYSTEM_PROMPT } from "../src/console-prompt.ts";
import { LOCAL_ACTOR } from "../src/federation.ts";
import { completionPayload, escalationPayload, PushService, type PushPayload, type PushSend } from "../src/push.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer } from "../src/server.ts";
import { TRANSCRIPT_EVENT_NEEDS_YOU } from "../src/transcript-event-kinds.ts";
import type { ChannelEntry } from "../src/channels.ts";
import type { AgentDTO, AgentStatus, PersistedAgent, RpcSessionState, SquadEvent, TransitionEntry } from "../src/types.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

function agent(status: AgentStatus, over: Partial<AgentDTO> = {}): AgentDTO {
	return { id: "x1", name: "alpha", status, kind: "omp-operator", repo: "/r", worktree: "/w", approvalMode: "yolo", pending: [], lastActivity: 0, messageCount: 0, ...over };
}

/** The canonical push-lane input now: a recorded transition, exactly as recordTransition emits it. */
function transitionEvent(agentId: string, from: AgentStatus, to: AgentStatus, over: Partial<TransitionEntry> = {}): SquadEvent {
	return { type: "transition", entry: { agentId, from, to, reason: "pending-add", at: Date.now(), seq: crypto.randomUUID(), ...over } };
}

function needsYouChannelEvent(agentId: string, pendingId: string): SquadEvent {
	const entry: ChannelEntry = {
		id: crypto.randomUUID(),
		seq: 1,
		channelId: "fleet",
		authorActor: "manager",
		kind: "system",
		text: "needs you · approve?",
		ts: Date.now(),
		status: "ok",
		event: {
			kind: TRANSCRIPT_EVENT_NEEDS_YOU,
			payload: {
				refs: { unitId: agentId },
				doorSurface: "intervence",
				face: { unitId: agentId, pendingId, pendingStatus: "pending", title: "needs you · approve?" },
			},
		},
	};
	return { type: "channel-entry", channelId: "fleet", entry };
}

/** Never spawns a real process — for tests that need a REAL resident agent (so `getAgent` /
 *  `clearCompletionPushArmed` have a record to act on) but drive the push lane itself via synthetic
 *  transition events. */
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
	agents: Map<string, { dto: AgentDTO; options: PersistedAgent; agent: AgentDriver }>;
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

/** A live manager + one REAL resident agent (NoopDriver) whose dto the test mutates before emitting
 *  the corresponding transition event — the shape every synthetic-event test below shares. */
async function liveAgent(prefix: string): Promise<{ mgr: SquadManager; rec: { dto: AgentDTO; options: PersistedAgent; agent: AgentDriver }; dirs: string[] }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-state-`));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-wt-`));
	const repo = await makeRepo(`${prefix}-repo-`);
	const mgr = new SquadManager({ stateDir: dir, worktreeBase });
	await mgr.start();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new NoopDriver();
	const dto = await mgr.create({ name: "alpha", repo, approvalMode: "yolo" });
	const rec = (mgr as unknown as InternalHost).agents.get(dto.id);
	if (!rec) throw new Error("agent not resident");
	return { mgr, rec, dirs: [dir, worktreeBase, repo] };
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

	const { mgr, rec, dirs } = await liveAgent("pushint");
	const server = new SquadServer(mgr, { port: 0, push });
	server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(dir, { recursive: true, force: true });
		for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
	});

	// the state the transition left behind, then the canonical transition event itself
	rec.dto.status = "input";
	rec.dto.pending = [{ id: "p", source: "ui", kind: "select", title: "approve?", createdAt: 0 }];
	mgr.emit("event", transitionEvent(rec.dto.id, "working", "input"));

	await sent; // resolves when the push is dispatched — no polling
	expect(calls).toHaveLength(1);
	expect(calls[0].endpoint).toBe("https://push.example.com/device");
	expect(calls[0].enc).toBe("aes128gcm");
	expect(calls[0].len).toBeGreaterThan(80);
});

test("needs-you room card and status lane produce exactly one push for one pending request", async () => {
	const calls: PushPayload[] = [];
	// SquadServer only needs PushService.notify here; this focused latch test avoids encrypted WebPush
	// timing so "no double fire" is synchronous and deterministic.
	const push = {
		notify: async (payload: PushPayload) => {
			calls.push(payload);
		},
	} as PushService;

	const { mgr, rec, dirs } = await liveAgent("pushneeds");
	const server = new SquadServer(mgr, { port: 0, push });
	server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await Promise.resolve();
		for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
	});

	rec.dto.status = "input";
	rec.dto.pending = [{ id: "p", source: "ui", kind: "select", title: "approve?", createdAt: 0 }];
	mgr.emit("event", transitionEvent(rec.dto.id, "working", "input"));
	mgr.emit("event", needsYouChannelEvent(rec.dto.id, "p"));

	expect(calls).toHaveLength(1);
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
	const { mgr, rec, dirs } = await liveAgent("pushint2");
	const server = new SquadServer(mgr, { port: 0, push });
	server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(dir, { recursive: true, force: true });
		for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
	});

	mgr.emit("event", { type: "roster", agents: [agent("working", { id: rec.dto.id })] }); // seed (no-op: start() already seeded)
	rec.dto.status = "idle";
	mgr.emit("event", transitionEvent(rec.dto.id, "working", "idle", { reason: "turn-progress" })); // working→idle, calm
	// give any erroneous dispatch a chance to run before asserting
	await mgr.stop();
	expect(count).toBe(0);
});

// ── voice-loop completion push (plans/voice-loop concern 01) ────────────────

test("a voice-armed turn's REAL working→idle transition drives a completion push through the server, and disarms the manager's latch", async () => {
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
	const rec = (mgr as unknown as InternalHost).agents.get(dto.id);
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

	// The REAL turn: a voice-sourced prompt arms the latch, the driver's own terminal agent_end derives
	// idle — squad-manager's transition() records + emits the working→idle transition event the push
	// lane now consumes (the old synthetic `{type:"agent"}` drive is meaningless post-refactor).
	await mgr.applyCommand({ type: "prompt", id: dto.id, message: "go", source: "voice" }, LOCAL_ACTOR);
	expect(rec.options.completionPushArmed).toBe(true);
	(rec.agent as unknown as EventEmitter).emit("event", { type: "agent_end" });

	await sent; // resolves when the push is dispatched — no polling
	expect(calls).toEqual(["https://push.example.com/device"]);
	await waitFor(() => rec.options.completionPushArmed === false);
	expect(rec.options.completionPushArmed).toBe(false);
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

	const { mgr, rec, dirs } = await liveAgent("pushboth");
	const server = new SquadServer(mgr, { port: 0, push });
	server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(dir, { recursive: true, force: true });
		for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
	});

	// Escalation ("needs you") writes lastPush[id] — WITHOUT the done: namespace this would wrongly
	// debounce-block the completion push that follows a moment later for the SAME agent id.
	rec.dto.status = "input";
	rec.dto.pending = [{ id: "p", source: "ui", kind: "select", title: "approve?", createdAt: 0 }];
	mgr.emit("event", transitionEvent(rec.dto.id, "working", "input"));
	rec.dto.status = "idle";
	rec.dto.pending = [];
	rec.dto.completionPushArmed = true;
	rec.dto.completionPushKind = "voice";
	mgr.emit("event", transitionEvent(rec.dto.id, "input", "idle", { reason: "pending-answer" }));

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

test("duration gate (daily-attention-w0 01 + finding #4): a short casual turn does NOT push and DISARMS the latch (no deferral); a later Restart-like idle stays quiet; a subsequent long turn fires and consumes it", async () => {
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
	// gated: no push. Finding #4 (stale completion latch): the gate-suppressed exposure now DISARMS the
	// latch immediately (no deferral) — the old behavior left `completionPushArmed: true` with a stale
	// `completionArmedAt` sitting in `rec.options`/`rec.dto`, which a LATER unrelated idle transition
	// could ride to fire a spurious push (see the next assertion below).
	await mgr.applyCommand({ type: "prompt", id: dto.id, message: "hi" }, LOCAL_ACTOR);
	(rec.agent as unknown as EventEmitter).emit("event", { type: "agent_end" });
	await new Promise((r) => setTimeout(r, 40)); // give an erroneous push a chance to fire
	expect(calls).toHaveLength(0);
	expect(rec.options.completionPushArmed).toBe(false); // disarmed at exposure, not just deferred
	expect(rec.dto.completionPushArmed).toBe(false); // dto mirror disarmed together, never desyncs

	// Regression (finding #4): a LATER non-terminal idle transition on the SAME agent — e.g. an
	// operator Restart's `starting`→`idle` connect-ok, or a pending-expiry re-derive — must never
	// resurrect a "finished" push for the short turn above. Drive it through the exact canonical lane
	// every synthetic-transition test in this file uses (a raw `{type:"transition"}` SquadEvent against
	// the real, live record `mgr` just touched) — no field is hand-poked; this observes whatever state
	// the real agent_end handler left behind.
	rec.dto.status = "idle";
	mgr.emit("event", transitionEvent(dto.id, "starting", "idle", { reason: "connect-ok" }));
	await new Promise((r) => setTimeout(r, 40));
	expect(calls).toHaveLength(0); // still nothing — the gate-suppressed turn left no latch to resurrect

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
	const rec2 = (mgr2 as unknown as InternalHost).agents.get(id);
	if (!rec2) throw new Error("reattached agent not resident");

	// server.start() is the fix under test: it must flip pushSeeded itself — NO "snapshot" command
	// (the only thing that used to seed it) is ever sent below.
	const server = new SquadServer(mgr2, { port: 0, push });
	server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr2.stop();
		await fs.rm(stateDir, { recursive: true, force: true });
		await fs.rm(worktreeBase, { recursive: true, force: true });
		await fs.rm(repo, { recursive: true, force: true });
	});

	const from = rec2.dto.status;
	rec2.dto.status = "input";
	rec2.dto.pending = [{ id: "p", source: "ui", kind: "select", title: "approve?", createdAt: 0 }];
	mgr2.emit("event", transitionEvent(id, from, "input"));

	await sent; // resolves when the push is dispatched — no polling, no roster/snapshot event ever sent
	expect(calls).toEqual(["https://push.example.com/restart-device"]);
});

// ── boot-safety regression (daily-attention-w0 concern 02, MANDATORY) ───────
//
// The retired private `lastStatus` diff suppressed a boot-time push flood only ACCIDENTALLY:
// start() seeded the map from the post-reattach roster, so the first agent event per survivor read
// prev === status. Reading `from`/`to` off the transition event loses that side effect — a reattach
// transition carries the REAL pre-reattach status, and when derive() reclassifies a crashed turn
// (persisted "working" → derived "input") from !== to is true at every boot. The `pushSeeded` boot
// guard must suppress it DELIBERATELY: a daemon restart with reattached agents fires ZERO pushes.
test("boot safety: a daemon restart with reattached agents fires ZERO pushes, even for a reattach transition with from !== to", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "pushboot-state-"));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "pushboot-wt-"));
	const repo = await makeRepo("pushboot-repo-");

	const mgr1 = new SquadManager({ stateDir, worktreeBase });
	await mgr1.start();
	(mgr1 as unknown as DriverFactoryHost).makeDriver = () => new NoopDriver();
	const seedDto = await mgr1.create({ name: "survivor", repo, approvalMode: "yolo" });
	await fs.writeFile(path.join(seedDto.worktree, "output.txt"), "done\n"); // real work → restart-adopt keeps it
	await mgr1.stop();

	const calls: string[] = [];
	const send: PushSend = async (endpoint) => {
		calls.push(endpoint);
		return { status: 201 };
	};
	const push = new PushService(stateDir, { send });
	await push.init();
	const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const p256dh = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))).toString("base64url");
	const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
	await push.subscribe({ endpoint: "https://push.example.com/boot-device", keys: { p256dh, auth } });

	// The REAL daemon restart ordering (src/index.ts): manager.start() — where every reattach
	// transition fires — runs to completion BEFORE the server is constructed and started.
	const mgr2 = new SquadManager({ stateDir, worktreeBase });
	(mgr2 as unknown as DriverFactoryHost).makeDriver = () => new NoopDriver();
	await mgr2.start();
	const roster = mgr2.list();
	expect(roster.length).toBeGreaterThan(0);
	const id = roster[0].id;
	const rec = (mgr2 as unknown as InternalHost).agents.get(id);
	if (!rec) throw new Error("reattached agent not resident");

	const server = new SquadServer(mgr2, { port: 0, push });
	cleanups.push(async () => {
		server.stop();
		await mgr2.stop();
		await fs.rm(stateDir, { recursive: true, force: true });
		await fs.rm(worktreeBase, { recursive: true, force: true });
		await fs.rm(repo, { recursive: true, force: true });
	});

	// The trap, pinned at the seam: a boot-replay reattach transition whose derived status DIFFERS
	// from the persisted one (crash mid-run reclassified as "input" on restart), delivered before
	// start() flips pushSeeded — exactly what broadcast() would deliver under any wiring where the
	// subscription exists during boot. The explicit boot guard must drop it even though the DTO
	// genuinely reads "input" with a live pending question.
	rec.dto.status = "input";
	rec.dto.pending = [{ id: "p", source: "ui", kind: "select", title: "resume?", createdAt: 0 }];
	(server as unknown as { maybePushAlert(e: SquadEvent): void }).maybePushAlert(
		transitionEvent(id, "working", "input", { reason: "reattach" }),
	);
	server.start(); // boot hydration done — pushSeeded flips here
	await new Promise((r) => setTimeout(r, 25)); // give any erroneous boot dispatch a chance to run
	expect(calls).toHaveLength(0); // the quiet boot, now deliberate

	// And the lane is NOT dead after boot: a genuine post-boot escalation still pages.
	mgr2.emit("event", transitionEvent(id, "working", "input"));
	await waitFor(() => calls.length === 1);
	expect(calls).toEqual(["https://push.example.com/boot-device"]);
});

// ── diff-the-two-lanes (daily-attention-w0 concern 02, behavior preservation) ──
//
// For every payload class the old `{type:"agent"}` diff lane could fire, the transition lane must
// fire the IDENTICAL payload for the identical status change. The old lane's output is computed
// directly (same pure builders fed prev-from-map + DTO — exactly what maybePushAlert used to do);
// the new lane's output is whatever the server actually dispatches off the transition event.
test("diff-the-two-lanes: the transition lane fires byte-identical payloads to the old agent-diff lane for every payload class", async () => {
	const priorMinTurn = process.env.OMP_SQUAD_PUSH_MIN_TURN_MS;
	process.env.OMP_SQUAD_PUSH_MIN_TURN_MS = "20000"; // a real floor, so the category case exercises the gate identically in both lanes
	cleanups.push(() => {
		if (priorMinTurn === undefined) delete process.env.OMP_SQUAD_PUSH_MIN_TURN_MS;
		else process.env.OMP_SQUAD_PUSH_MIN_TURN_MS = priorMinTurn;
	});

	const captured: PushPayload[] = [];
	const fakePush = { notify: async (p: PushPayload) => (captured.push(p), 1), init: async () => {}, subscribe: async () => {}, publicKey: "pk" } as unknown as PushService;
	const { mgr, rec, dirs } = await liveAgent("pushdiff");
	const server = new SquadServer(mgr, { port: 0, push: fakePush });
	server.start();
	const lastPush = (server as unknown as { lastPush: Map<string, number> }).lastPush;
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
	});
	const id = rec.dto.id;

	const drive = async (from: AgentStatus): Promise<PushPayload[]> => {
		lastPush.clear(); // isolate every case from the 3s debounce
		captured.length = 0;
		mgr.emit("event", transitionEvent(id, from, rec.dto.status));
		await new Promise((r) => setTimeout(r, 10));
		return [...captured];
	};

	// 1. escalation into input, pending title
	rec.dto.status = "input";
	rec.dto.pending = [{ id: "p", source: "ui", kind: "select", title: "approve deploy?", createdAt: 0 }];
	let oldLane = escalationPayload("working", rec.dto, true);
	expect(oldLane).not.toBeNull();
	expect(await drive("working")).toEqual([oldLane!]);

	// 2. escalation into error, error text
	rec.dto.status = "error";
	rec.dto.pending = [];
	rec.dto.error = "child crashed";
	oldLane = escalationPayload("working", rec.dto, true);
	expect(oldLane).not.toBeNull();
	expect(await drive("working")).toEqual([oldLane!]);

	// 3. completion, voice-armed (duration-gate exempt)
	rec.dto.status = "idle";
	rec.dto.error = undefined;
	rec.dto.completionPushArmed = true;
	rec.dto.completionPushKind = "voice";
	rec.dto.completionArmedAt = Date.now();
	oldLane = completionPayload("working", rec.dto, true);
	expect(oldLane).not.toBeNull();
	expect(await drive("working")).toEqual([oldLane!]);

	// 4. completion, category-armed past the duration floor
	rec.dto.completionPushArmed = true;
	rec.dto.completionPushKind = "category";
	rec.dto.completionArmedAt = Date.now() - 30_000; // over the 20s floor pinned above
	oldLane = completionPayload("working", rec.dto, true);
	expect(oldLane).not.toBeNull();
	expect(await drive("working")).toEqual([oldLane!]);

	// 5. negative parity: a calm change produces nothing in either lane
	rec.dto.status = "working";
	rec.dto.completionPushArmed = undefined;
	rec.dto.completionPushKind = undefined;
	expect(escalationPayload("idle", rec.dto, true)).toBeNull();
	expect(completionPayload("idle", rec.dto, true)).toBeNull();
	expect(await drive("idle")).toEqual([]);
});

// ── denied entries (daily-attention-w0 concern 02) ──────────────────────────

test("a denied transition entry never pushes — it did not change dto.status", async () => {
	const captured: PushPayload[] = [];
	const fakePush = { notify: async (p: PushPayload) => (captured.push(p), 1), init: async () => {}, subscribe: async () => {}, publicKey: "pk" } as unknown as PushService;
	const { mgr, rec, dirs } = await liveAgent("pushdenied");
	const server = new SquadServer(mgr, { port: 0, push: fakePush });
	server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
	});

	// A denied attempt's entry says working→input but the DTO never moved; even a DTO that happens to
	// read "input" (raced by a later real change) must not ride a denied entry.
	rec.dto.status = "input";
	rec.dto.pending = [{ id: "p", source: "ui", kind: "select", title: "approve?", createdAt: 0 }];
	mgr.emit("event", transitionEvent(rec.dto.id, "working", "input", { denied: true }));
	await new Promise((r) => setTimeout(r, 15));
	expect(captured).toHaveLength(0);
});

// ── POST /api/push-tap write guards (review finding #6) ─────────────────────
// authz.ts keeps this route viewer-tier deliberately — safe only because the write site
// (SquadManager.recordPushTap) pairs it with shape/existence/rate guards. authz.test.ts covers the
// three pure helpers directly; these two exercise the actual wiring at the HTTP route.

test("POST /api/push-tap rejects a fabricated agentId that never named a real agent", async () => {
	_resetPushTapRateLimitsForTests();
	const { mgr, rec, dirs } = await liveAgent("pushtap-unknown");
	const server = new SquadServer(mgr, { port: 0 });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
	});

	// The REAL resident agent's id is accepted (sanity: the guard isn't rejecting everything).
	const real = await fetch(`${url}/api/push-tap`, { method: "POST", body: JSON.stringify({ agentId: rec.dto.id }) });
	expect(real.status).toBe(200);

	// An id that never named any live or removed agent must be rejected, not silently counted —
	// otherwise a viewer-tier credential could inflate pushTapsByDay with any string it likes.
	const fake = await fetch(`${url}/api/push-tap`, { method: "POST", body: JSON.stringify({ agentId: "totally-made-up-agent-id" }) });
	expect(fake.status).toBe(400);

	const counters = await mgr.adoptionCounters();
	const total = Object.values(counters.pushTapsByDay).reduce((a, b) => a + b, 0);
	expect(total).toBe(1); // only the real tap landed
});

test("POST /api/push-tap drops taps past the burst floor from one source, without erroring the route", async () => {
	_resetPushTapRateLimitsForTests();
	const { mgr, rec, dirs } = await liveAgent("pushtap-burst");
	const server = new SquadServer(mgr, { port: 0 });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
	});

	// The bucket holds 10 — the first 10 taps from this one source (same actor + loopback address)
	// must all land.
	for (let i = 0; i < 10; i++) {
		const res = await fetch(`${url}/api/push-tap`, { method: "POST", body: JSON.stringify({ agentId: rec.dto.id }) });
		expect(res.status).toBe(200);
	}
	// The 11th is rate-limited: the id may be perfectly genuine, just too frequent from this source, so
	// it is dropped quietly server-side (a warn log, not a caller-visible shape/existence error) — but
	// the route must be honest that it did NOT count (S2, blind review: this used to answer 200/ok:true
	// here, indistinguishable from a landed tap — a wrong instruction from an earlier pass). 429, not 200.
	const eleventh = await fetch(`${url}/api/push-tap`, { method: "POST", body: JSON.stringify({ agentId: rec.dto.id }) });
	expect(eleventh.status).toBe(429);
	expect(await eleventh.text()).toBe("rate-limited");

	// Read the manager's own in-memory ring directly rather than `adoptionCounters()` — its (ts,
	// agentId) merge-dedupe (file ∪ live source overlap) is a false positive here: 11 rapid-fire taps
	// of the SAME agentId can land within the same millisecond, which is a legitimate ambiguity for
	// that dedupe's actual job (file/live overlap) but would collapse several of OUR genuinely-distinct
	// ring entries and make this assertion meaningless either way.
	const ring = (mgr as unknown as { pushTapLog: { recent(): Array<{ ts: number; agentId: string }> } }).pushTapLog.recent();
	expect(ring).toHaveLength(10); // the 11th was dropped, not appended
});
