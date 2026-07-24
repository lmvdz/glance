import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileStore } from "../src/dal/store.ts";
import { ChannelStore, type ChannelEntry } from "../src/channels.ts";
import { SubagentTracker } from "../src/subagents.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { TRANSCRIPT_EVENT_GATE_VERDICT } from "../src/transcript-event-kinds.ts";
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
		agent: { detach: () => {} },
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

interface RouteStubHost {
	land(id: string): Promise<unknown>;
	applyHeldSync(id: string): Promise<unknown>;
	discardHeldSync(id: string): Promise<unknown>;
	acknowledgeBoundarySyncDivergence(id: string): Promise<unknown>;
	verifyAgentWork(id: string): Promise<boolean>;
	transitionMode(id: string): Promise<AgentDTO | undefined>;
	promote(id: string): Promise<unknown>;
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
	let revoked = false;
	const originalMemberUserIds = mgr.channelMemberUserIds.bind(mgr);
	mgr.channelMemberUserIds = async (channelId: string) => {
		if (channelId !== "ops") return originalMemberUserIds(channelId);
		return revoked ? ["alice"] : ["alice", "bob"];
	};
	const event: SquadEvent = { type: "channel-entry", channelId: "ops", entry };
	const frames: Record<string, string[]> = { alice: [], bob: [] };
	const host = server as unknown as DeliverHost;
	host.clients.add({
		data: { userId: "alice", orgId: "org-a", role: "admin", displayName: "alice" },
		send: (frame: string) => {
			frames.alice.push(frame);
			revoked = true;
		},
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
	const frames: Record<string, string[]> = { alice: [], carol: [] };
	const fakeSocket = (userId: string): DeliverSocket => ({ data: { userId, orgId: "org-a", role: "admin", displayName: userId }, send: (frame: string) => frames[userId]!.push(frame) });
	const host = server as unknown as DeliverHost;
	host.clients.add(fakeSocket("alice"));
	host.clients.add(fakeSocket("carol"));

	await host.deliverEvent(undefined, { type: "command-ack", clientTurnId: "turn-1", ok: true });
	expect(frames.alice.map((frame) => JSON.parse(frame))).toEqual([{ type: "command-ack", clientTurnId: "turn-1", ok: true }]);
	expect(frames.carol.map((frame) => JSON.parse(frame))).toEqual([{ type: "command-ack", clientTurnId: "turn-1", ok: true }]);
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
