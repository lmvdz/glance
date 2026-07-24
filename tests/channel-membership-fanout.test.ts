import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { composeAfterAction, saveAfterAction } from "../src/after-action.ts";
import { saveAnswer } from "../src/answers.ts";
import { FileStore } from "../src/dal/store.ts";
import { ChannelStore, type ChannelEntry } from "../src/channels.ts";
import { SubagentTracker } from "../src/subagents.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { TRANSCRIPT_EVENT_GATE_VERDICT, TRANSCRIPT_EVENT_PR_OPENED, TRANSCRIPT_EVENT_UNIT_FAILED, TRANSCRIPT_EVENT_UNIT_SPAWNED, TRANSCRIPT_EVENT_UNIT_TURN_FINISHED, TRANSCRIPT_EVENT_VERIFICATION_RAN } from "../src/transcript-event-kinds.ts";
import { SquadServer, type AuthInstance, type SocketData } from "../src/server.ts";
import type { Actor, AgentDTO, PersistedAgent, SquadEvent, TranscriptEntry } from "../src/types.ts";

const cleanups: Array<() => Promise<void> | void> = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
	for (const ws of sockets.splice(0)) {
		try {
			ws.close();
		} catch {}
	}
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const actor = (userId: string): Actor => ({ id: `db:${userId}`, displayName: userId, origin: "local", role: "admin", orgId: "org-a" });

const agentDto = (id: string, channelId?: string): AgentDTO => ({
	id,
	name: id,
	status: "idle",
	kind: "omp-operator",
	repo: "/tmp/repo",
	worktree: "/tmp/worktree",
	channelId,
	approvalMode: "yolo",
	pending: [],
	lastActivity: 0,
	messageCount: 1,
});

function seedAgent(mgr: SquadManager, dto: AgentDTO, transcript: TranscriptEntry[] = []): void {
	const options: PersistedAgent = {
		id: dto.id,
		name: dto.name,
		repo: dto.repo,
		worktree: dto.worktree,
		channelId: dto.channelId,
		approvalMode: dto.approvalMode,
	};
	const record = {
		dto,
		agent: { detach: () => {}, stop: async () => {}, prompt: async () => {}, isReady: true, isAlive: true },
		options,
		transcript,
		assistantBuf: "",
		thinkingBuf: "",
		streaming: false,
		subs: new SubagentTracker(),
		toolEntries: new Map(),
	};
	mgr.agents.set(dto.id, record as never);
}

async function startedPrivateAgentServer(prefix: string): Promise<{ mgr: SquadManager; url: string; headers: Record<string, string>; agent: AgentDTO }> {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	await mgr.createChannel(actor("alice"), { id: "ops", name: "#ops", visibility: "private" });
	const agent = agentDto("unit-private", "ops");
	seedAgent(mgr, agent, [{ id: "t1", seq: 1, kind: "assistant", text: "private transcript", ts: 1 }]);
	const token = `${prefix}-token`;
	const server = new SquadServer(mgr, { port: 0, token });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(stateDir, { recursive: true, force: true });
	});
	return { mgr, url, headers: { authorization: `Bearer ${token}` }, agent };
}

interface DeliverSocket {
	data: SocketData;
	send(frame: string): void;
}

interface DeliverHost {
	clients: Set<DeliverSocket>;
	deliverEvent(orgId: string | undefined, event: SquadEvent): Promise<void>;
}

interface TranscriptEventHost {
	emitUnitTranscriptEvent(id: string | undefined, kind: string, text: string, payload: unknown): void;
}

interface TransitionHost {
	transition(record: unknown, status: AgentDTO["status"], reason: string, cause?: Record<string, unknown>): void;
}

interface RouteStubHost {
	land(id: string): Promise<unknown>;
	applyHeldSync(id: string): Promise<unknown>;
	discardHeldSync(id: string): Promise<unknown>;
	acknowledgeBoundarySyncDivergence(id: string): Promise<unknown>;
	verifyAgentWork(id: string): Promise<boolean>;
	transitionMode(id: string): Promise<AgentDTO | undefined>;
	promote(id: string): Promise<unknown>;
}

interface DeadPlaceholderHost {
	deadPlaceholders: Map<string, unknown>;
}

function stubDangerousAgentRouteMethods(mgr: SquadManager, agent: AgentDTO): void {
	const stubs = mgr as unknown as RouteStubHost;
	stubs.land = async () => ({ ok: true });
	stubs.applyHeldSync = async () => ({ ok: true });
	stubs.discardHeldSync = async () => ({ ok: true });
	stubs.acknowledgeBoundarySyncDivergence = async () => ({ ok: true });
	stubs.verifyAgentWork = async () => true;
	stubs.transitionMode = async () => agent;
	stubs.promote = async () => ({ ok: true });
}

function waitForChannelEntry(mgr: SquadManager, channelId: string, predicate: (entry: ChannelEntry) => boolean): Promise<ChannelEntry> {
	const { promise, resolve } = Promise.withResolvers<ChannelEntry>();
	const onEvent = (event: SquadEvent) => {
		if (event.type !== "channel-entry" || event.channelId !== channelId || !predicate(event.entry)) return;
		mgr.off("event", onEvent);
		resolve(event.entry);
	};
	mgr.on("event", onEvent);
	return promise;
}

function authStub(): AuthInstance {
	return {
		handler: async () => new Response("not found", { status: 404 }),
		api: {
			getSession: async ({ headers }) => {
				const cookie = headers.get("cookie") ?? "";
				const match = /(?:^|;\s*)session=(alice|bob|carol)(?:;|$)/.exec(cookie);
				const userId = match?.[1];
				return userId ? { user: { id: userId, name: userId, email: `${userId}@example.test` }, session: { activeOrganizationId: "org-a" } } : null;
			},
			getActiveMemberRole: async () => ({ role: "owner" }),
		},
	};
}

interface Client {
	ws: WebSocket;
	messages: SquadEvent[];
	waitForNext(match: (event: SquadEvent) => boolean): Promise<SquadEvent>;
}

function connect(url: string, userId: "alice" | "bob" | "carol"): Promise<Client> {
	const ready = Promise.withResolvers<Client>();
	const waiters: Array<{ match: (event: SquadEvent) => boolean; resolve: (event: SquadEvent) => void }> = [];
	const messages: SquadEvent[] = [];
	const ws = new WebSocket(url, { headers: { cookie: `session=${userId}` } });
	sockets.push(ws);
	const client: Client = {
		ws,
		messages,
		waitForNext: (match) => {
			const waiter = Promise.withResolvers<SquadEvent>();
			waiters.push({ match, resolve: waiter.resolve });
			return waiter.promise;
		},
	};
	ws.onopen = () => ready.resolve(client);
	ws.onerror = () => ready.reject(new Error(`failed to connect ${userId}`));
	ws.onmessage = (event: MessageEvent) => {
		const parsed = JSON.parse(String(event.data)) as SquadEvent;
		messages.push(parsed);
		for (let i = 0; i < waiters.length; i++) {
			const waiter = waiters[i]!;
			if (!waiter.match(parsed)) continue;
			waiters.splice(i, 1);
			waiter.resolve(parsed);
			i--;
		}
	};
	return ready.promise;
}

async function channelStore(name: string) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), name));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	return new ChannelStore(dir, new FileStore(dir), undefined, () => 1000);
}

test("private channels require positive membership rows for reads and search", async () => {
	const channels = await channelStore("channel-membership-");
	const privateChannel = await channels.createChannel(actor("alice"), { id: "ops", name: "#ops", visibility: "private" });
	expect(privateChannel.visibility).toBe("private");
	expect((await channels.listChannels(actor("alice"))).map((channel) => channel.id)).toContain("ops");
	expect((await channels.listChannels(actor("carol"))).map((channel) => channel.id)).not.toContain("ops");
	await expect(channels.entries("ops", 0, actor("carol"))).rejects.toThrow("channel forbidden");

	await channels.appendClient("ops", actor("alice"), { text: "private launch code" });
	expect(await channels.search("launch", 50, actor("carol"))).toEqual([]);

	await channels.setMember("ops", actor("alice"), { userId: "bob" }, true);
	expect((await channels.entries("ops", 0, actor("bob"))).map((entry) => entry.text)).toEqual(["private launch code"]);

	await channels.setMember("ops", actor("alice"), { userId: "bob" }, false);
	await expect(channels.entries("ops", 0, actor("bob"))).rejects.toThrow("channel forbidden");
	expect((await channels.memberUserIds("ops"))?.sort()).toEqual(["alice"]);
});

test("private channel fan-out sends zero wire frames to same-org non-members", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "channel-fanout-"));
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0 });
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(stateDir, { recursive: true, force: true });
	});

	await mgr.createChannel(actor("alice"), { id: "ops", name: "#ops", visibility: "private" });
	await mgr.addChannelMember("ops", actor("alice"), { userId: "bob" });
	const entry = await mgr.appendChannelPost("ops", actor("alice"), { text: "members only" });
	const event: SquadEvent = { type: "channel-entry", channelId: "ops", entry };
	const frames: Record<string, string[]> = { alice: [], bob: [], carol: [] };
	const fakeSocket = (userId: string): DeliverSocket => ({ data: { userId, orgId: "org-a", role: "admin", displayName: userId }, send: (frame: string) => frames[userId]!.push(frame) });
	const host = server as unknown as DeliverHost;
	host.clients.add(fakeSocket("alice"));
	host.clients.add(fakeSocket("bob"));
	host.clients.add(fakeSocket("carol"));

	await host.deliverEvent(undefined, event);
	expect(frames.alice).toHaveLength(1);
	expect(frames.bob).toHaveLength(1);
	expect(frames.carol).toEqual([]);
});

test("typing events are wire-only, debounced per channel, and never persisted as channel entries", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "channel-typing-"));
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0 });
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(stateDir, { recursive: true, force: true });
	});

	await mgr.createChannel(actor("alice"), { id: "ops", name: "#ops", visibility: "org-public" });
	await mgr.applyCommand({ type: "typing", channelId: "fleet", active: true });

	const frames: string[] = [];
	const source = { data: { id: 1, userId: "alice", orgId: "org-a", role: "admin", displayName: "Alice" }, send: () => {} };
	const peer = { data: { id: 2, userId: "bob", orgId: "org-a", role: "admin", displayName: "Bob" }, send: (frame: string) => frames.push(frame) };
	const host = server as unknown as {
		clients: Set<{ data: SocketData; send(frame: string): void }>;
		emitTyping(source: { data: SocketData; send(frame: string): void }, manager: SquadManager, channelId: string, active: boolean): Promise<void>;
	};
	host.clients.add(source);
	host.clients.add(peer);

	await host.emitTyping(source, mgr, "fleet", true);
	await host.emitTyping(source, mgr, "fleet", true);
	await host.emitTyping(source, mgr, "ops", true);
	await host.emitTyping(source, mgr, "fleet", false);

	expect(frames.map((frame) => JSON.parse(frame))).toEqual([
		{ type: "typing", channelId: "fleet", userId: "db:alice", displayName: "Alice", active: true, at: expect.any(Number) },
		{ type: "typing", channelId: "ops", userId: "db:alice", displayName: "Alice", active: true, at: expect.any(Number) },
		{ type: "typing", channelId: "fleet", userId: "db:alice", displayName: "Alice", active: false, at: expect.any(Number) },
	]);
	expect(await mgr.channelEntries("fleet")).toEqual([]);
	expect(await mgr.channelEntries("ops")).toEqual([]);
});

test("revocation during private fan-out stops later member frames", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "channel-fanout-revoke-"));
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0 });
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(stateDir, { recursive: true, force: true });
	});
	await mgr.createChannel(actor("alice"), { id: "ops", name: "#ops", visibility: "private" });
	await mgr.addChannelMember("ops", actor("alice"), { userId: "bob" });
	const entry = await mgr.appendChannelPost("ops", actor("alice"), { text: "members only" });
	let lookups = 0;
	const originalMemberUserIds = mgr.channelMemberUserIds.bind(mgr);
	mgr.channelMemberUserIds = async (channelId: string) => {
		if (channelId !== "ops") return originalMemberUserIds(channelId);
		return ++lookups === 1 ? ["alice", "bob"] : ["alice"];
	};
	const event: SquadEvent = { type: "channel-entry", channelId: "ops", entry };
	const frames: Record<string, string[]> = { alice: [], bob: [] };
	const host = server as unknown as DeliverHost;
	host.clients.add({
		data: { userId: "alice", orgId: "org-a", role: "admin", displayName: "alice" },
		send: (frame: string) => frames.alice.push(frame),
	});
	host.clients.add({ data: { userId: "bob", orgId: "org-a", role: "admin", displayName: "bob" }, send: (frame: string) => frames.bob.push(frame) });
	await host.deliverEvent(undefined, event);
	expect(frames.alice).toHaveLength(1);
	expect(frames.bob).toEqual([]);
});

test("command-ack reaches subscribed sockets while a private channel exists", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "channel-ack-fanout-"));
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0 });
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(stateDir, { recursive: true, force: true });
	});

	await mgr.createChannel(actor("alice"), { id: "ops", name: "#ops", visibility: "private" });
	seedAgent(mgr, agentDto("private-ack-unit", "ops"));
	const frames: Record<string, string[]> = { alice: [], carol: [] };
	const fakeSocket = (userId: string): DeliverSocket => ({ data: { userId, orgId: "org-a", role: "admin", displayName: userId }, send: (frame: string) => frames[userId]!.push(frame) });
	const host = server as unknown as DeliverHost;
	host.clients.add(fakeSocket("alice"));
	host.clients.add(fakeSocket("carol"));
	const { promise: ack, resolve: resolveAck } = Promise.withResolvers<SquadEvent>();
	const onEvent = (event: SquadEvent) => {
		if (event.type !== "command-ack") return;
		mgr.off("event", onEvent);
		resolveAck(event);
	};
	mgr.on("event", onEvent);

	await mgr.applyCommand({ type: "prompt", id: "private-ack-unit", message: "private command", channelId: "ops", clientTurnId: "turn-1" } as never, actor("alice"));
	const commandAck = await ack;
	expect(commandAck).toMatchObject({ type: "command-ack", clientTurnId: "turn-1" });
	await host.deliverEvent(undefined, commandAck);
	expect(frames.alice.map((frame) => JSON.parse(frame))).toEqual([commandAck]);
	expect(frames.carol.map((frame) => JSON.parse(frame))).toEqual([commandAck]);
});

test("creator-only membership management rejects non-creators and non-member self-add", async () => {
	const channels = await channelStore("channel-member-privileges-");
	await channels.createChannel(actor("alice"), { id: "ops", name: "#ops", visibility: "private" });

	await expect(channels.setMember("ops", actor("bob"), { userId: "carol" }, true)).rejects.toThrow("channel forbidden");
	await expect(channels.setMember("ops", actor("carol"), { userId: "carol" }, true)).rejects.toThrow("channel forbidden");

	await channels.setMember("ops", actor("alice"), { userId: "bob" }, true);
	expect((await channels.memberUserIds("ops"))?.sort()).toEqual(["alice", "bob"]);
	await expect(channels.setMember("ops", actor("bob"), { userId: "alice" }, false)).rejects.toThrow("channel forbidden");

	await channels.setMember("ops", actor("alice"), { userId: "bob" }, false);
	expect(await channels.entries("ops", 0, actor("alice"))).toEqual([]);
	await expect(channels.entries("ops", 0, actor("bob"))).rejects.toThrow("channel forbidden");
	expect((await channels.memberUserIds("ops"))?.sort()).toEqual(["alice"]);
});

test("non-members get 403 for every per-agent HTTP route", async () => {
	const { mgr, url, headers, agent } = await startedPrivateAgentServer("agent-route-membership-");
	stubDangerousAgentRouteMethods(mgr, agent);
	const routes: Array<{ name: string; method: "GET" | "POST"; suffix: string; body?: unknown }> = [
		{ name: "detail", method: "GET", suffix: "" },
		{ name: "transcript", method: "GET", suffix: "/transcript" },
		{ name: "transitions", method: "GET", suffix: "/transitions" },
		{ name: "subagents", method: "GET", suffix: "/subagents" },
		{ name: "receipts", method: "GET", suffix: "/receipts" },
		{ name: "checkpoints", method: "GET", suffix: "/checkpoints" },
		{ name: "commands", method: "GET", suffix: "/commands" },
		{ name: "diff", method: "GET", suffix: "/diff" },
		{ name: "tree", method: "GET", suffix: "/tree" },
		{ name: "land", method: "POST", suffix: "/land", body: {} },
		{ name: "open", method: "POST", suffix: "/open", body: {} },
		{ name: "apply-held-sync", method: "POST", suffix: "/apply-held-sync", body: {} },
		{ name: "discard-held-sync", method: "POST", suffix: "/discard-held-sync", body: {} },
		{ name: "ack-boundary-sync-divergence", method: "POST", suffix: "/ack-boundary-sync-divergence", body: {} },
		{ name: "verify", method: "POST", suffix: "/verify", body: {} },
		{ name: "mode", method: "POST", suffix: "/mode", body: { mode: "observe" } },
		{ name: "promote", method: "POST", suffix: "/promote", body: { task: "new task" } },
		{ name: "vision", method: "POST", suffix: "/vision", body: {} },
	];
	const failures: string[] = [];

	for (const route of routes) {
		const response = await fetch(`${url}/api/agents/${agent.id}${route.suffix}`, {
			method: route.method,
			headers: route.method === "POST" ? { ...headers, "content-type": "application/json" } : headers,
			body: route.method === "POST" ? JSON.stringify(route.body ?? {}) : undefined,
		});
		if (response.status !== 403) failures.push(`${route.method} ${route.suffix || "/"} -> ${response.status} (${route.name})`);
	}
	expect(failures).toEqual([]);
});

test("gate-verdict-proof returns 403 for private channel non-members", async () => {
	const { mgr, url, headers, agent } = await startedPrivateAgentServer("gate-proof-membership-");
	const host = mgr as unknown as TranscriptEventHost;
	const projected = waitForChannelEntry(mgr, "ops", (entry) => entry.event?.kind === TRANSCRIPT_EVENT_GATE_VERDICT);

	host.emitUnitTranscriptEvent(agent.id, TRANSCRIPT_EVENT_GATE_VERDICT, "gate verdict · pass", { verdict: "pass" });
	const card = await projected;
	if (!card.id) throw new Error("projected gate verdict entry missing id");

	const response = await fetch(`${url}/api/channels/ops/entries/${encodeURIComponent(card.id)}/gate-verdict-proof`, { headers });
	expect(response.status).toBe(403);
});

test("ordinary unit lifecycle projects a bounded five-card cycle from transition records", async () => {
	const { mgr, agent } = await startedPrivateAgentServer("lifecycle-projection-");
	const record = (mgr.agents as Map<string, unknown>).get(agent.id);
	if (!record) throw new Error("seed agent missing");
	const host = mgr as unknown as TransitionHost;
	const emit = async (reason: string, status: AgentDTO["status"], kind: string, cause?: Record<string, unknown>) => {
		const projected = waitForChannelEntry(mgr, "ops", (item) => item.event?.kind === kind);
		host.transition(record, status, reason, cause);
		return projected;
	};

	const cards = [await emit("spawn", "idle", TRANSCRIPT_EVENT_UNIT_SPAWNED)];
	host.transition(record, "working", "task-start");
	// Test-only structural assertion: seedAgent creates this internal manager record.
	const seededRecord = record as { transcript: TranscriptEntry[] };
	seededRecord.transcript.push({ id: "summary", seq: 2, kind: "assistant", text: "Implemented the lifecycle reader.", ts: 2 });
	cards.push(await emit("exit-clean", "idle", TRANSCRIPT_EVENT_UNIT_TURN_FINISHED));
	cards.push(await emit("verification", "idle", TRANSCRIPT_EVENT_VERIFICATION_RAN, { ok: true, detail: "12 pass" }));
	agent.prNumber = 27;
	agent.prUrl = "https://example.test/pr/27";
	cards.push(await emit("pr-open", "idle", TRANSCRIPT_EVENT_PR_OPENED));
	cards.push(await emit("fail", "error", TRANSCRIPT_EVENT_UNIT_FAILED, { error: "Error: gate failed\nstack" }));

	expect(cards.map((card) => card.event?.kind)).toEqual([
		TRANSCRIPT_EVENT_UNIT_SPAWNED,
		TRANSCRIPT_EVENT_UNIT_TURN_FINISHED,
		TRANSCRIPT_EVENT_VERIFICATION_RAN,
		TRANSCRIPT_EVENT_PR_OPENED,
		TRANSCRIPT_EVENT_UNIT_FAILED,
	]);
	expect(cards).toHaveLength(5);
});

test("a unit that keeps re-entering error projects ONE failure card, not one per transition", async () => {
	// Found by booting the room, not by a test: a single spawn timeout produced FIVE identical
	// "Unit failed" cards, because a failing unit re-enters `error` on every retry/reattach and each
	// one projected. That is the firehose shape concern 26 had to be filed to clean up, reappearing
	// inside the concern meant to prevent it. The happy-path volume test above cannot see it — there,
	// a unit enters `error` at most once.
	const { mgr, agent } = await startedPrivateAgentServer("lifecycle-repeat-error-");
	const record = (mgr.agents as Map<string, unknown>).get(agent.id);
	if (!record) throw new Error("seed agent missing");
	const host = mgr as unknown as TransitionHost;

	const cards: ChannelEntry[] = [];
	const collect = (event: SquadEvent) => {
		if (event.type === "channel-entry" && event.entry.event?.kind === TRANSCRIPT_EVENT_UNIT_FAILED) cards.push(event.entry);
	};
	mgr.on("event", collect);

	const first = waitForChannelEntry(mgr, "ops", (item) => item.event?.kind === TRANSCRIPT_EVENT_UNIT_FAILED);
	host.transition(record, "error", "fail", { error: "agent unit-private not ready within 4945ms" });
	await first;
	// Four more error→error transitions: the same failure, re-marked.
	for (let i = 0; i < 4; i++) host.transition(record, "error", "fail", { error: "agent unit-private not ready within 4945ms" });
	await Bun.sleep(150);
	mgr.off("event", collect);

	expect(cards).toHaveLength(1);

	// And the class must be a label a human can scan. The old rule took the leading token off the raw
	// message, so this exact string rendered a card whose entire body read "agent".
	const payload = (cards[0]!.event!.payload ?? {}) as { face?: { body?: string }; errorClass?: string };
	const face = payload.face ?? {};
	expect(face.body).not.toBe("agent");
	expect(face.body).toBe("fail");
});

test("a thrown error still yields its real class, not the transition reason", async () => {
	const { mgr, agent } = await startedPrivateAgentServer("lifecycle-thrown-error-");
	const record = (mgr.agents as Map<string, unknown>).get(agent.id);
	if (!record) throw new Error("seed agent missing");
	const host = mgr as unknown as TransitionHost;
	const projected = waitForChannelEntry(mgr, "ops", (item) => item.event?.kind === TRANSCRIPT_EVENT_UNIT_FAILED);
	host.transition(record, "error", "fail", { error: "TypeError: m.visibleAgents is not a function" });
	const card = await projected;
	const face = ((card.event!.payload ?? {}) as { face?: { body?: string } }).face ?? {};
	expect(face.body).toBe("TypeError");
});

test("WS subscribe after membership revocation replays no transcript frames", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-revoked-subscribe-"));
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	await mgr.createChannel(actor("alice"), { id: "ops", name: "#ops", visibility: "private" });
	const agent = agentDto("unit-private", "ops");
	seedAgent(mgr, agent, [{ id: "t1", seq: 1, kind: "assistant", text: "private transcript", ts: 1 }]);
	const server = new SquadServer(mgr, { port: 0, auth: authStub() });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(stateDir, { recursive: true, force: true });
	});

	const client = await connect(`${url.replace("http", "ws")}/ws`, "alice");
	await client.waitForNext((event) => event.type === "roster" && event.agents.some((item) => item.id === agent.id));
	await mgr.removeChannelMember("ops", actor("alice"), { userId: "alice" });

	const firstRevokedFrame = client.messages.length;
	client.ws.send(JSON.stringify({ type: "subscribe", id: agent.id }));
	client.ws.send(JSON.stringify({ type: "snapshot" }));
	await client.waitForNext((event) => event.type === "roster" && !event.agents.some((item) => item.id === agent.id));

	const replayed = client.messages.slice(firstRevokedFrame).filter((event) => event.type === "transcript" && event.id === agent.id);
	expect(replayed).toEqual([]);
});


test("HTTP private channel reads 403 and search is empty for non-member callers", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "channel-http-leak-"));
	const token = "channel-http-token";
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0, token });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(stateDir, { recursive: true, force: true });
	});

	await mgr.createChannel(actor("alice"), { id: "ops", name: "#ops", visibility: "private" });
	await mgr.appendChannelPost("ops", actor("alice"), { text: "hidden launch needle" });
	const headers = { authorization: `Bearer ${token}` };

	const read = await fetch(`${url}/api/channels/ops/entries`, { headers });
	expect(read.status).toBe(403);
	const search = await fetch(`${url}/api/channels/search?q=hidden%20launch`, { headers });
	expect(search.status).toBe(200);
	expect(await search.json()).toEqual({ results: [] });
});

test("private agent events, removals, bound logs, and missing channels never fan out to non-members", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "channel-event-scope-"));
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0 });
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(stateDir, { recursive: true, force: true });
	});
	await mgr.createChannel(actor("alice"), { id: "ops", name: "#ops", visibility: "private" });
	const unit = agentDto("private-unit", "ops");
	seedAgent(mgr, unit);
	const frames: Record<string, string[]> = { alice: [], carol: [] };
	const host = server as unknown as DeliverHost;
	for (const userId of ["alice", "carol"]) host.clients.add({ data: { userId, orgId: "org-a", role: "admin", displayName: userId }, send: (frame: string) => frames[userId]!.push(frame) });

	for (const event of [
		{ type: "agent", agent: unit },
		{ type: "transcript", id: unit.id, entry: { id: "t", seq: 1, kind: "assistant", text: "private", ts: 1 } },
		{ type: "commands", id: unit.id, commands: [] },
		{ type: "transition", entry: { agentId: unit.id, from: "working", to: "input", reason: "private", at: 1, seq: "1" } },
		{ type: "removed", id: unit.id, channelId: "ops" },
		{ type: "log", level: "error", text: "private failure", agentId: unit.id },
	] satisfies SquadEvent[]) await host.deliverEvent(undefined, event);

	seedAgent(mgr, agentDto("missing-unit", "missing"));
	await host.deliverEvent(undefined, { type: "agent", agent: agentDto("missing-unit", "missing") });
	expect(frames.alice).toHaveLength(6);
	expect(frames.carol).toEqual([]);
});

test("a failed membership recheck drops the event instead of using its stale member list", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "channel-recheck-failure-"));
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0 });
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(stateDir, { recursive: true, force: true });
	});
	await mgr.createChannel(actor("alice"), { id: "ops", name: "#ops", visibility: "private" });
	let calls = 0;
	mgr.channelMemberUserIds = async () => (++calls === 1 ? ["alice"] : []);
	const frames: string[] = [];
	const host = server as unknown as DeliverHost;
	host.clients.add({ data: { userId: "alice", orgId: "org-a", role: "admin", displayName: "alice" }, send: (frame: string) => frames.push(frame) });
	const entry = await mgr.appendChannelPost("ops", actor("alice"), { text: "private" });
	await host.deliverEvent(undefined, { type: "channel-entry", channelId: "ops", entry });
	expect(frames).toEqual([]);
});

test("a public-channel dead placeholder retains its documented dead response", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "public-dead-placeholder-"));
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	await mgr.createChannel(actor("alice"), { id: "public", name: "#public", visibility: "org-public" });
	const server = new SquadServer(mgr, { port: 0, token: "public-dead-placeholder-token" });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(stateDir, { recursive: true, force: true });
	});
	const placeholderHost = mgr as unknown as DeadPlaceholderHost;
	placeholderHost.deadPlaceholders.set("dead-public", {
		id: "dead-public",
		name: "dead public",
		repo: "/repo",
		harness: "claude-code",
		at: Date.now(),
		deadReason: "daemon restarted",
		channelId: "public",
		transcript: [],
	});

	const response = await fetch(`${url}/api/agents/dead-public`, { headers: { authorization: "Bearer public-dead-placeholder-token" } });
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ id: "dead-public", dead: true, deadReason: "daemon restarted" });
});

test("non-members cannot read private action items, answers, or after-actions after reaping", async () => {
	const { mgr, url, headers, agent } = await startedPrivateAgentServer("private-artifact-membership-");
	agent.status = "input";
	agent.pending = [{ id: "approval", source: "ui", kind: "confirm", title: "private approval", createdAt: 1 }];
	// `channelId` is what keeps the artifact authorizable once the roster row is gone — the same
	// binding the after-action arm below carries. Before answers retained it, the only thing denying a
	// non-member was `canReadAgent` returning false for an id it no longer knew, which is absence read
	// as denial: protected while the agent lived, open the moment it was reaped.
	await saveAnswer(mgr.stateDir, { id: agent.id, question: "private question", repo: agent.repo, markdown: "private answer", askedAt: 1, channelId: "ops" });
	await saveAfterAction(
		mgr.stateDir,
		composeAfterAction({
			id: agent.id,
			name: agent.name,
			repo: agent.repo,
			terminalReason: "private failure",
			channelId: "ops",
			terminalAt: 1,
			trajectory: [],
			commitsAhead: 0,
			dirtyFiles: 0,
			now: 1,
		}),
	);
	mgr.agents.delete(agent.id);

	const responses = await Promise.all([
		fetch(`${url}/api/action-items`, { headers }),
		fetch(`${url}/api/answers`, { headers }),
		fetch(`${url}/api/answers/${agent.id}`, { headers }),
		fetch(`${url}/api/after-action`, { headers }),
		fetch(`${url}/api/after-action/${agent.id}`, { headers }),
	]);
	expect(responses.map((response) => response.status)).toEqual([200, 200, 404, 200, 404]);
	// Assert the PRIVATE unit contributes nothing — not that the list is empty. `/api/action-items`
	// also carries fleet-derived items (a health warning fires under memory pressure, which the full
	// containerized suite reliably produces and a targeted run never does). Asserting emptiness made
	// this test pass or fail on how loaded the machine was, while testing nothing about membership.
	const actionItems = (await responses[0]!.json()) as { items: unknown[] };
	const leaked = actionItems.items.filter((item) => {
		const text = JSON.stringify(item);
		return text.includes(agent.id) || text.includes(agent.name) || text.includes("private approval");
	});
	expect(leaked).toEqual([]);
	expect(await responses[1]!.json()).toEqual([]);
	expect(await responses[3]!.json()).toEqual([]);
});

test("an answer with no retained channel binding is org-public, deliberately", async () => {
	// The migration stance, pinned rather than left incidental: an answer written before answers
	// carried a `channelId` predates private channels entirely, so there is no private channel it
	// could be leaking from, and it reads as org-public. Every answer this build writes for a
	// channel-bound unit records the binding, so `undefined` only ever means "pre-migration".
	// If that ever stops being true, this test is the one that should be revisited first.
	const { mgr, url, headers } = await startedPrivateAgentServer("legacy-answer-membership-");
	await saveAnswer(mgr.stateDir, { id: "legacy-unit", question: "legacy question", repo: "/repo", markdown: "legacy answer", askedAt: 1 });

	const response = await fetch(`${url}/api/answers/legacy-unit`, { headers });
	expect(response.status).toBe(200);
});

test("search continues past a private-heavy native-search page", async () => {
	class PrivateHeavySearchStore extends FileStore {
		override async searchChannelEntries(_q: string, _limit = 50, offset = 0) {
			if (offset === 0) {
				return Array.from({ length: 500 }, (_, i) => ({
					entry: { id: `private-${i}`, seq: i + 1, channelId: "private", authorActor: "db:alice", kind: "user" as const, text: `needle private ${i}`, ts: i, status: "ok" as const },
					snippet: `needle private ${i}`,
				}));
			}
			return [{ entry: { id: "public-needle", seq: 1, channelId: "public", authorActor: "db:alice", kind: "user" as const, text: "needle public", ts: 501, status: "ok" as const }, snippet: "needle public" }];
		}
	}
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "channel-search-overfetch-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	const channels = new ChannelStore(dir, new PrivateHeavySearchStore(dir), undefined, () => 1);
	await channels.createChannel(actor("alice"), { id: "private", name: "#private", visibility: "private" });
	await channels.createChannel(actor("alice"), { id: "public", name: "#public", visibility: "org-public" });

	expect((await channels.search("needle", 1, actor("carol"))).map((result) => result.entry.text)).toEqual(["needle public"]);
});

test("creator access remains available when the private membership write fails after channel persistence", async () => {
	class MembershipFailingStore extends FileStore {
		override async putChannelMembership(): Promise<void> {
			throw new Error("membership disk failure");
		}
	}
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "channel-create-membership-failure-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	const channels = new ChannelStore(dir, new MembershipFailingStore(dir), undefined, () => 1);

	await expect(channels.createChannel(actor("alice"), { id: "ops", name: "#ops", visibility: "private" })).rejects.toThrow("membership disk failure");
	expect(await channels.canReadChannel("ops", actor("alice"))).toBe(true);
	expect(await channels.canReadChannel("ops", actor("carol"))).toBe(false);
});

test("org-public channel events still fan out without membership rows", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "public-channel-fanout-"));
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0 });
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(stateDir, { recursive: true, force: true });
	});
	await mgr.createChannel(actor("alice"), { id: "public", name: "#public", visibility: "org-public" });
	const entry = await mgr.appendChannelPost("public", actor("alice"), { text: "visible to the org" });
	const frames: string[] = [];
	const host = server as unknown as DeliverHost;
	host.clients.add({ data: { userId: "carol", orgId: "org-a", role: "admin", displayName: "carol" }, send: (frame: string) => frames.push(frame) });

	await host.deliverEvent(undefined, { type: "channel-entry", channelId: "public", entry });
	expect(frames.map((frame) => JSON.parse(frame))).toEqual([{ type: "channel-entry", channelId: "public", entry }]);
});
