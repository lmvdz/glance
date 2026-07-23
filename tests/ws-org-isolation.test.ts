import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileStore } from "../src/dal/store.ts";
import { ManagerRegistry } from "../src/manager-registry.ts";
import { SquadServer, type AuthInstance } from "../src/server.ts";
import type { Actor, AgentDTO, ClientCommand, CommandInfo, SquadEvent, TranscriptEntry } from "../src/types.ts";

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

const operator: Actor = { id: "test-op", origin: "local" };

type SessionKey = "orgA" | "orgA2" | "orgB";

interface FakeManager {
	list(): AgentDTO[];
	commandsFor(id: string): CommandInfo[];
	getTranscript(id: string): TranscriptEntry[];
	applyCommand(cmd: ClientCommand, actor: Actor): Promise<void>;
	on(event: "event", listener: (e: SquadEvent) => void): void;
	off(event: "event", listener: (e: SquadEvent) => void): void;
	stop(): Promise<void>;
}

interface FakeEntry {
	manager: FakeManager;
	listener: (e: SquadEvent) => void;
	lastUsed: number;
}

interface RegistryInternals {
	managers: Map<string, FakeEntry>;
}

interface Client {
	ws: WebSocket;
	messages: SquadEvent[];
	waitFor(match: (event: SquadEvent) => boolean): Promise<SquadEvent>;
}

function agent(id: string): AgentDTO {
	return {
		id,
		name: id,
		status: "idle",
		kind: "omp-operator",
		repo: `/repo/${id}`,
		worktree: `/worktree/${id}`,
		approvalMode: "write",
		pending: [],
		lastActivity: 0,
		messageCount: 0,
	};
}

function fakeManager(agents: AgentDTO[], transcripts: Record<string, TranscriptEntry[]>, onSubscribe?: (id: string) => void, onCommand?: (cmd: ClientCommand, actor: Actor) => void): FakeManager {
	return {
		list: () => agents,
		commandsFor: () => [],
		getTranscript: (id) => {
			onSubscribe?.(id);
			return transcripts[id] ?? [];
		},
		applyCommand: async (cmd, actor) => {
			onCommand?.(cmd, actor);
		},
		on: () => {},
		off: () => {},
		stop: async () => {},
	};
}

function seed(registry: ManagerRegistry, orgId: string, manager: FakeManager): void {
	const internals = registry as unknown as RegistryInternals;
	internals.managers.set(orgId, { manager, listener: () => {}, lastUsed: Date.now() });
}

interface AuthStubOptions {
	onRoleLookup?: (organizationId: string | undefined) => void;
	roleLookupFails?: boolean;
}

function authStub(opts: AuthStubOptions = {}): AuthInstance {
	return {
		handler: async () => new Response("not found", { status: 404 }),
		api: {
			getSession: async ({ headers }) => {
				const cookie = headers.get("cookie") ?? "";
				const match = /(?:^|;\s*)session=(orgA|orgA2|orgB)(?:;|$)/.exec(cookie);
				const key = match?.[1] as SessionKey | undefined;
				if (!key) return null;
				const orgId = key === "orgA2" ? "orgA" : key;
				return {
					user: { id: `user-${key}`, name: `User ${key}`, email: `${key}@example.test` },
					session: { activeOrganizationId: orgId },
				};
			},
			getActiveMemberRole: async ({ query }) => {
				opts.onRoleLookup?.(query?.organizationId);
				if (opts.roleLookupFails) throw new Error("membership unavailable");
				return { role: "member" };
			},
		},
	};
}

function connect(url: string, key: SessionKey): Promise<Client> {
	const ready = Promise.withResolvers<Client>();
	const waiters: Array<{ match: (event: SquadEvent) => boolean; resolve: (event: SquadEvent) => void }> = [];
	const messages: SquadEvent[] = [];
	const ws = new WebSocket(url, { headers: { cookie: `session=${key}` } });
	sockets.push(ws);
	const client: Client = {
		ws,
		messages,
		waitFor: (match) => {
			const existing = messages.find(match);
			if (existing) return Promise.resolve(existing);
			const waiter = Promise.withResolvers<SquadEvent>();
			waiters.push({ match, resolve: waiter.resolve });
			return waiter.promise;
		},
	};
	ws.onopen = () => ready.resolve(client);
	ws.onerror = () => ready.reject(new Error(`failed to connect ${key}`));
	ws.onmessage = (event: MessageEvent) => {
		const parsed = JSON.parse(String(event.data)) as SquadEvent;
		messages.push(parsed);
		for (let i = 0; i < waiters.length; i++) {
			const waiter = waiters[i];
			if (!waiter.match(parsed)) continue;
			waiters.splice(i, 1);
			waiter.resolve(parsed);
			i--;
		}
	};
	return ready.promise;
}

function canOpen(url: string, cookie?: string): Promise<boolean> {
	const opened = Promise.withResolvers<boolean>();
	const ws = cookie ? new WebSocket(url, { headers: { cookie } }) : new WebSocket(url);
	sockets.push(ws);
	ws.onopen = () => {
		ws.close();
		opened.resolve(true);
	};
	ws.onerror = () => opened.resolve(false);
	ws.onclose = () => {
		if (ws.readyState !== WebSocket.OPEN) opened.resolve(false);
	};
	return opened.promise;
}

function connectFileMode(url: string): Promise<Client> {
	const ready = Promise.withResolvers<Client>();
	const waiters: Array<{ match: (event: SquadEvent) => boolean; resolve: (event: SquadEvent) => void }> = [];
	const messages: SquadEvent[] = [];
	const ws = new WebSocket(url, "ompsq-token");
	sockets.push(ws);
	const client: Client = {
		ws,
		messages,
		waitFor: (match) => {
			const existing = messages.find(match);
			if (existing) return Promise.resolve(existing);
			const waiter = Promise.withResolvers<SquadEvent>();
			waiters.push({ match, resolve: waiter.resolve });
			return waiter.promise;
		},
	};
	ws.onopen = () => ready.resolve(client);
	ws.onerror = () => ready.reject(new Error("failed to connect file-mode socket"));
	ws.onmessage = (event: MessageEvent) => {
		const parsed = JSON.parse(String(event.data)) as SquadEvent;
		messages.push(parsed);
		for (let i = 0; i < waiters.length; i++) {
			const waiter = waiters[i];
			if (!waiter.match(parsed)) continue;
			waiters.splice(i, 1);
			waiter.resolve(parsed);
			i--;
		}
	};
	return ready.promise;
}

function closeAndWait(ws: WebSocket): Promise<void> {
	if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
	const closed = Promise.withResolvers<void>();
	ws.onclose = () => closed.resolve();
	ws.close();
	return closed.promise;
}

function hasAgent(events: SquadEvent[], id: string): boolean {
	return events.some((event) => {
		if (event.type === "agent") return event.agent.id === id;
		if (event.type === "roster") return event.agents.some((agent) => agent.id === id);
		return false;
	});
}

async function startedServer(onOrgBSubscribe: (id: string) => void): Promise<{ url: string; registry: ManagerRegistry; agentA: AgentDTO; agentB: AgentDTO }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-org-"));
	const registry = new ManagerRegistry({ root: dir, store: (orgId) => new FileStore(path.join(dir, "orgs", orgId)), operator });
	const agentA = agent("agent-a");
	const agentB = agent("agent-b");
	seed(registry, "orgA", fakeManager([agentA], { "agent-a": [{ kind: "system", text: "org-a-secret", ts: 1 }] }));
	seed(registry, "orgB", fakeManager([agentB], { "agent-b": [{ kind: "system", text: "org-b-secret", ts: 2 }] }, onOrgBSubscribe));
	const server = new SquadServer(undefined, { port: 0, auth: authStub(), registry });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});
	return { url, registry, agentA, agentB };
}

test("DB-registry WebSocket events stay inside the socket's session org", async () => {
	const orgBSubscribe = Promise.withResolvers<string>();
	const { url, registry, agentA, agentB } = await startedServer((id) => orgBSubscribe.resolve(id));
	const wsUrl = `${url.replace("http", "ws")}/ws`;
	const orgA = await connect(wsUrl, "orgA");
	const orgB = await connect(wsUrl, "orgB");

	await orgA.waitFor((event) => event.type === "roster" && event.agents.some((agent) => agent.id === "agent-a"));
	await orgB.waitFor((event) => event.type === "roster" && event.agents.some((agent) => agent.id === "agent-b"));
	expect(hasAgent(orgA.messages, "agent-b")).toBe(false);
	expect(hasAgent(orgB.messages, "agent-a")).toBe(false);

	registry.onEvent("orgB", { type: "agent", agent: agentB });
	await orgB.waitFor((event) => event.type === "agent" && event.agent.id === "agent-b");

	registry.onEvent("orgB", { type: "roster", agents: [agentB], version: "" });
	await orgB.waitFor((event) => event.type === "roster" && event.agents.some((agent) => agent.id === "agent-b") && orgB.messages.filter((message) => message.type === "roster").length >= 2);

	registry.onEvent("orgB", { type: "transcript", id: "agent-b", entry: { kind: "system", text: "org-b-event", ts: 3 } });
	await orgB.waitFor((event) => event.type === "transcript" && event.id === "agent-b" && event.entry.text === "org-b-event");

	await closeAndWait(orgA.ws);
	expect(hasAgent(orgA.messages, "agent-b")).toBe(false);
	expect(orgA.messages.some((event) => event.type === "transcript" && event.id === "agent-b")).toBe(false);

	orgB.ws.send(JSON.stringify({ type: "subscribe", id: agentA.id }));
	expect(await orgBSubscribe.promise).toBe("agent-a");
	expect(orgB.messages.some((event) => event.type === "transcript" && event.id === "agent-a")).toBe(false);
});

test("DB-registry WebSocket identity stamps session user into commands and per-user presence", async () => {
	const command = Promise.withResolvers<Actor>();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-identity-"));
	const registry = new ManagerRegistry({ root: dir, store: (orgId) => new FileStore(path.join(dir, "orgs", orgId)), operator });
	const agentA = agent("agent-a");
	seed(registry, "orgA", fakeManager([agentA], {}, undefined, (_cmd, actor) => command.resolve(actor)));
	const roleLookups: Array<string | undefined> = [];
	const server = new SquadServer(undefined, { port: 0, auth: authStub({ onRoleLookup: (orgId) => roleLookups.push(orgId) }), registry });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});
	const wsUrl = `${url.replace("http", "ws")}/ws`;
	const tab1 = await connect(wsUrl, "orgA");
	await tab1.waitFor((event) => event.type === "presence" && event.presence.users.some((user) => user.id === "db:user-orgA" && user.socketCount === 1));
	const tab2 = await connect(wsUrl, "orgA");
	await tab1.waitFor((event) => event.type === "presence" && event.presence.users.some((user) => user.id === "db:user-orgA" && user.socketCount === 2));
	const otherUser = await connect(wsUrl, "orgA2");
	await tab1.waitFor((event) => event.type === "presence" && event.presence.users.some((user) => user.id === "db:user-orgA2" && user.socketCount === 1));

	tab1.ws.send(JSON.stringify({ type: "prompt", id: agentA.id, message: "hello" }));
	expect(await command.promise).toEqual({ id: "db:user-orgA", displayName: "User orgA", origin: "local", role: "operator", orgId: "orgA" });
	expect(roleLookups).toContain("orgA");

	const presence = await fetch(`${url}/api/room/presence`, { headers: { cookie: "session=orgA" } }).then((res) => res.json());
	expect(presence).toEqual({
		orgId: "orgA",
		users: [
			{ id: "db:user-orgA", displayName: "User orgA", socketCount: 2 },
			{ id: "db:user-orgA2", displayName: "User orgA2", socketCount: 1 },
		],
	});

	await closeAndWait(tab1.ws);
	await tab2.waitFor((event) => event.type === "presence" && event.presence.users.some((user) => user.id === "db:user-orgA" && user.socketCount === 1));
	await closeAndWait(tab2.ws);
	await otherUser.waitFor((event) => event.type === "presence" && !event.presence.users.some((user) => user.id === "db:user-orgA") && event.presence.users.some((user) => user.id === "db:user-orgA2" && user.socketCount === 1));
	const otherOnly = await fetch(`${url}/api/room/presence`, { headers: { cookie: "session=orgA2" } }).then((res) => res.json());
	expect(otherOnly).toEqual({ orgId: "orgA", users: [{ id: "db:user-orgA2", displayName: "User orgA2", socketCount: 1 }] });
	await closeAndWait(otherUser.ws);
	const empty = await fetch(`${url}/api/room/presence`, { headers: { cookie: "session=orgA" } }).then((res) => res.json());
	expect(empty).toEqual({ orgId: "orgA", users: [] });
});

test("auth-backed single-manager WS identity still stamps session user into commands and presence", async () => {
	const command = Promise.withResolvers<Actor>();
	const agentA = agent("agent-a");
	const manager = fakeManager([agentA], {}, undefined, (_cmd, actor) => command.resolve(actor));
	const server = new SquadServer(manager as never, { port: 0, auth: authStub(), operator });
	const url = server.start();
	cleanups.push(() => server.stop());

	const ws = await connect(`${url.replace("http", "ws")}/ws`, "orgA");
	await ws.waitFor((event) => event.type === "presence" && event.presence.users.some((user) => user.id === "db:user-orgA"));
	ws.ws.send(JSON.stringify({ type: "prompt", id: agentA.id, message: "hello" }));
	expect(await command.promise).toEqual({ id: "db:user-orgA", displayName: "User orgA", origin: "local", role: "operator", orgId: "orgA" });
	const presence = await fetch(`${url}/api/room/presence`, { headers: { cookie: "session=orgA" } }).then((res) => res.json());
	expect(presence).toEqual({ orgId: "orgA", users: [{ id: "db:user-orgA", displayName: "User orgA", socketCount: 1 }] });
	await closeAndWait(ws.ws);
	const empty = await fetch(`${url}/api/room/presence`, { headers: { cookie: "session=orgA" } }).then((res) => res.json());
	expect(empty).toEqual({ orgId: "orgA", users: [] });
});

test("file-mode WS commands and presence use the single shared operator identity", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-file-presence-"));
	const command = Promise.withResolvers<Actor>();
	const agentA = agent("agent-a");
	const manager = fakeManager([agentA], {}, undefined, (_cmd, actor) => command.resolve(actor));
	const server = new SquadServer(manager as never, { port: 0, operator });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});

	const ws = await connectFileMode(`${url.replace("http", "ws")}/ws`);
	await ws.waitFor((event) => event.type === "roster");
	ws.ws.send(JSON.stringify({ type: "prompt", id: agentA.id, message: "hello" }));
	expect(await command.promise).toEqual({ id: "test-op", origin: "local", role: "admin" });
	const presence = await fetch(`${url}/api/room/presence`).then((res) => res.json());
	expect(presence).toEqual({ users: [{ id: "test-op", displayName: "test-op", socketCount: 1 }] });
	await closeAndWait(ws.ws);
	const empty = await fetch(`${url}/api/room/presence`).then((res) => res.json());
	expect(empty).toEqual({ users: [] });
});

test("DB-registry WebSocket denies missing sessions and failed active-org membership lookups", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-identity-deny-"));
	const registry = new ManagerRegistry({ root: dir, store: (orgId) => new FileStore(path.join(dir, "orgs", orgId)), operator });
	seed(registry, "orgA", fakeManager([agent("agent-a")], {}));
	const roleLookups: Array<string | undefined> = [];
	const server = new SquadServer(undefined, { port: 0, auth: authStub({ roleLookupFails: true, onRoleLookup: (orgId) => roleLookups.push(orgId) }), registry });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});
	const wsUrl = `${url.replace("http", "ws")}/ws`;

	expect(await canOpen(wsUrl)).toBe(false);
	expect(await canOpen(wsUrl, "session=orgA")).toBe(false);
	expect(roleLookups).toEqual(["orgA"]);
});
