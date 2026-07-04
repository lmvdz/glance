import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileStore } from "../src/dal/store.ts";
import { ManagerRegistry } from "../src/manager-registry.ts";
import { SquadServer, type AuthInstance } from "../src/server.ts";
import type { Actor, AgentDTO, SquadEvent } from "../src/types.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const operator: Actor = { id: "test-op", origin: "local" };

type SessionKey = "orgA" | "orgB" | "no-org";

interface FakeManager {
	list(): AgentDTO[];
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

function fakeManager(agents: AgentDTO[]): FakeManager {
	return {
		list: () => agents,
		off: () => {},
		stop: async () => {},
	};
}

function seed(registry: ManagerRegistry, orgId: string, manager: FakeManager): void {
	const internals = registry as unknown as RegistryInternals;
	internals.managers.set(orgId, { manager, listener: () => {}, lastUsed: Date.now() });
}

function authStub(): AuthInstance {
	return {
		handler: async () => new Response("not found", { status: 404 }),
		api: {
			getSession: async ({ headers }) => {
				const cookie = headers.get("cookie") ?? "";
				const match = /(?:^|;\s*)session=(orgA|orgB|no-org)(?:;|$)/.exec(cookie);
				const key = match?.[1] as SessionKey | undefined;
				if (!key) return null;
				return {
					user: { id: `user-${key}`, name: `User ${key}`, email: `${key}@example.test` },
					session: { activeOrganizationId: key === "no-org" ? null : key },
				};
			},
			getActiveMemberRole: async () => ({ role: "member" }),
		},
	};
}

async function startedServer(opts: { token?: string } = {}): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "routing-"));
	const registry = new ManagerRegistry({ root: dir, store: (orgId) => new FileStore(path.join(dir, "orgs", orgId)), operator });
	seed(registry, "orgA", fakeManager([agent("agent-a")]));
	seed(registry, "orgB", fakeManager([agent("agent-b")]));
	const server = new SquadServer(undefined, { port: 0, auth: authStub(), registry, token: opts.token });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});
	return url;
}

const cookie = (key: SessionKey): { cookie: string } => ({ cookie: `session=${key}` });

async function agentIds(url: string, headers: HeadersInit, apiPath = "/api/agents"): Promise<string[]> {
	const res = await fetch(`${url}${apiPath}`, { headers });
	expect(res.status).toBe(200);
	const body = (await res.json()) as Array<{ id: string }>;
	return body.map((a) => a.id).sort();
}

test("DB-registry REST routing uses the session org, not request-supplied org", async () => {
	const url = await startedServer();

	expect(await agentIds(url, cookie("orgA"))).toEqual(["agent-a"]);
	expect(await agentIds(url, cookie("orgA"), "/api/agents?ignored=1")).toEqual(["agent-a"]);
	expect(await agentIds(url, cookie("orgB"))).toEqual(["agent-b"]);

	// The caller cannot select another org through request parameters; only the session's org routes.
	expect(await agentIds(url, cookie("orgA"), "/api/agents?org=orgB")).toEqual(["agent-a"]);

	expect(await agentIds(url, cookie("no-org"))).toEqual([]);

	const mutation = await fetch(`${url}/api/command`, {
		method: "POST",
		headers: { ...cookie("no-org"), "content-type": "application/json" },
		body: JSON.stringify({ type: "snapshot" }),
	});
	expect(mutation.status).toBe(403);

	expect((await fetch(`${url}/api/agents`)).status).toBe(401);
});

test("DB-registry loopback bearer list aggregates live org managers", async () => {
	const token = "bootstrap-admin-token-xxxxxxxx";
	const url = await startedServer({ token });

	expect(await agentIds(url, { authorization: `Bearer ${token}` })).toEqual(["agent-a", "agent-b"]);
	expect((await fetch(`${url}/api/command`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ type: "snapshot" }),
	})).status).toBe(403);
});
