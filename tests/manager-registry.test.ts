/**
 * ManagerRegistry lifecycle — lazy create / idle evict + the machine-global janitor
 * UNION (lifecycle plan 05). The evict + union assertions run against injected fake
 * managers (no real omp spawn); the fresh-instance-after-evict path uses the real
 * registry over throwaway FileStore dirs. Nothing here touches a model or the network.
 */

import { afterAll, expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ManagerRegistry } from "../src/manager-registry.ts";
import type { RegistryDeps } from "../src/manager-registry.ts";
import { FileStore } from "../src/dal/store.ts";
import type { StateSnapshot, Store } from "../src/dal/store.ts";
import type { Actor, SquadEvent } from "../src/types.ts";

const operator: Actor = { id: "test-op", origin: "local" };

/** Minimal stand-in for the bits of SquadManager the registry's lifecycle paths touch. */
interface FakeManager {
	list(): Array<{ id: string; status: string }>;
	stop(): Promise<void>;
	off(event: "event", listener: (e: SquadEvent) => void): void;
}

interface FakeEntry {
	manager: FakeManager;
	listener: (e: SquadEvent) => void;
	lastUsed: number;
}

/** Named view of the registry's private map so a test can seed fake managers without an inline cast. */
interface RegistryInternals {
	managers: Map<string, FakeEntry>;
}

function makeFakeManager(agents: Array<{ id: string; status: string }>): { manager: FakeManager; stopped: () => boolean } {
	let didStop = false;
	return {
		manager: {
			list: () => agents,
			stop: async () => {
				didStop = true;
			},
			off: () => {},
		},
		stopped: () => didStop,
	};
}

function seed(reg: ManagerRegistry, orgId: string, manager: FakeManager, lastUsed: number): void {
	// Private-map seam: a named-interface cast (not an inline member-access cast) lets the test
	// inject fakes the public lazy-create path would otherwise build via `new SquadManager`.
	const internals = reg as unknown as RegistryInternals;
	internals.managers.set(orgId, { manager, listener: () => {}, lastUsed });
}

test("evictIdle stops + drops an idle, agent-less manager", async () => {
	const deps: RegistryDeps = { root: "/tmp/reg-noop", store: () => new FileStore("/tmp/reg-noop"), operator };
	const reg = new ManagerRegistry(deps);
	const a = makeFakeManager([]); // no agents
	seed(reg, "orgA", a.manager, 0); // lastUsed = epoch ⇒ far past any TTL

	const n = await reg.evictIdle(10_000_000);

	expect(n).toBe(1);
	expect(a.stopped()).toBe(true);
	expect(reg.peek("orgA")).toBeUndefined();
});

test("get waits for an in-progress eviction and returns a fresh manager, never the closing instance", async () => {
	const root = await fsp.mkdtemp(path.join(os.tmpdir(), "reg-evict-get-"));
	let releaseStop!: () => void;
	const stopGate = new Promise<void>((resolve) => {
		releaseStop = resolve;
	});
	const closing = {
		manager: {
			list: () => [],
			stop: async () => {
				await stopGate;
			},
			off: () => {},
		},
		stopped: () => false,
	};
	const reg = new ManagerRegistry({ root, store: (orgId) => new FileStore(path.join(root, "orgs", orgId)), operator });
	seed(reg, "orgRace", closing.manager, 0);
	const evicting = reg.evictIdle(10_000_000);
	const getting = reg.get("orgRace");
	let resolved = false;
	void getting.then(() => {
		resolved = true;
	});

	await Promise.resolve();
	expect(resolved).toBe(false);

	releaseStop();
	expect(await evicting).toBe(1);
	const fresh = await getting;
	expect(fresh).not.toBe(closing.manager);
	expect(reg.peek("orgRace")).toBe(fresh);

	await reg.stopAll();
	await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
});

test("evictIdle skips a manager with a live (working) agent", async () => {
	const deps: RegistryDeps = { root: "/tmp/reg-noop", store: () => new FileStore("/tmp/reg-noop"), operator };
	const reg = new ManagerRegistry(deps);
	const busy = makeFakeManager([{ id: "x1", status: "working" }]);
	seed(reg, "orgB", busy.manager, 0); // idle by clock, but busy by agent state

	const n = await reg.evictIdle(10_000_000);

	expect(n).toBe(0);
	expect(busy.stopped()).toBe(false);
	expect(reg.peek("orgB")).toBeDefined();
});

test("evictIdle keeps a recently-used manager even when agent-less", async () => {
	const deps: RegistryDeps = { root: "/tmp/reg-noop", store: () => new FileStore("/tmp/reg-noop"), operator, idleMs: 600_000 };
	const reg = new ManagerRegistry(deps);
	const fresh = makeFakeManager([]);
	const now = Date.now();
	seed(reg, "orgC", fresh.manager, now); // used just now

	const n = await reg.evictIdle(now + 1000); // 1s < 10min TTL

	expect(n).toBe(0);
	expect(reg.peek("orgC")).toBeDefined();
});

test("protectedIds is the UNION of every live manager's agent ids", async () => {
	const deps: RegistryDeps = { root: "/tmp/reg-noop", store: () => new FileStore("/tmp/reg-noop"), operator };
	const reg = new ManagerRegistry(deps);
	seed(reg, "orgA", makeFakeManager([{ id: "a1", status: "idle" }]).manager, Date.now());
	seed(reg, "orgB", makeFakeManager([{ id: "b1", status: "idle" }]).manager, Date.now());

	const ids = await reg.protectedIds();

	// Crucially {a1,b1} together — a single-org reap (only {a1}) would kill orgB's live host b1.
	expect([...ids].sort()).toEqual(["a1", "b1"]);
});

test("protectedIds is boot-seeded from persisted rosters before any manager starts", async () => {
	// At boot no manager exists yet; the union MUST come from the persisted rosters, or the global
	// reap would kill every surviving host awaiting lazy re-adoption.
	const rosters: Record<string, StateSnapshot> = {
		orgA: { agents: [{ id: "pa1", name: "a", repo: "/r", worktree: "/w" }], transcripts: {}, features: [] },
		orgB: { agents: [{ id: "pb1", name: "b", repo: "/r", worktree: "/w" }], transcripts: {}, features: [] },
	};
	const store = (orgId: string): Store => ({
		hasState: async () => true,
		load: async () => rosters[orgId] ?? { agents: [], transcripts: {}, features: [] },
		save: async () => {},
		loadFeedback: async () => ({ campaigns: [], items: [], validations: [], rewards: [] }),
		saveFeedback: async () => {},
		appendAudit: async () => {},
		appendUsage: async () => {},
	});
	const deps: RegistryDeps = { root: "/tmp/reg-noop", store, operator, listOrgIds: async () => ["orgA", "orgB"] };
	const reg = new ManagerRegistry(deps);

	const ids = await reg.protectedIds();

	expect([...ids].sort()).toEqual(["pa1", "pb1"]);
	expect(ids.size).toBeGreaterThan(0); // non-empty before any lazy start — the boot-safety invariant
});

test("protectedIds includes the root factory's roster (rootRosterIds) — the 2026-07-20 console-chat kill", async () => {
	// Live incident: the root factory (index.ts builds it OUTSIDE the registry, on the root
	// FileStore) was absent from the union, so reapGlobal judged every console chat's host an
	// orphan and shut it down (`__sq:shutdown` → SIGTERM → "agent exited (code 143)") within a
	// maintenance tick of spawning. The union must carry the root roster alongside org managers.
	const deps: RegistryDeps = {
		root: "/tmp/reg-noop",
		store: () => new FileStore("/tmp/reg-noop"),
		operator,
		rootRosterIds: async () => ["chat-root-1", "chat-root-2"],
	};
	const reg = new ManagerRegistry(deps);
	seed(reg, "orgA", makeFakeManager([{ id: "a1", status: "idle" }]).manager, Date.now());

	const ids = await reg.protectedIds();

	expect([...ids].sort()).toEqual(["a1", "chat-root-1", "chat-root-2"]);
});

test("a rejecting rootRosterIds rejects protectedIds — the registry fails CLOSED and skips the reap pass", async () => {
	// Degrading a failed root-roster read to [] would reap every surviving root host (the empty-union
	// mass-SIGTERM the protectedIds doc comment warns about) — the rejection must propagate instead.
	const deps: RegistryDeps = {
		root: "/tmp/reg-noop",
		store: () => new FileStore("/tmp/reg-noop"),
		operator,
		rootRosterIds: async () => {
			throw new Error("corrupt state.json");
		},
	};
	const reg = new ManagerRegistry(deps);
	expect(reg.protectedIds()).rejects.toThrow("corrupt state.json");
});

test("rootRosterIds accepts a plain (non-promise) iterable and an empty roster", async () => {
	const deps: RegistryDeps = { root: "/tmp/reg-noop", store: () => new FileStore("/tmp/reg-noop"), operator, rootRosterIds: () => ["r1"] };
	const reg = new ManagerRegistry(deps);
	expect([...(await reg.protectedIds())]).toEqual(["r1"]);

	const empty = new ManagerRegistry({ root: "/tmp/reg-noop", store: () => new FileStore("/tmp/reg-noop"), operator, rootRosterIds: () => [] });
	expect((await empty.protectedIds()).size).toBe(0);
});

test("rootRosterIds wired to a real FileStore protects the PERSISTED root roster before any manager starts (boot-safety half)", async () => {
	// The index.ts wiring reads the root FileStore each pass so a surviving host is protected even
	// before (or without) the root factory standing up — mirror of the per-org persisted-roster seed.
	const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "reg-rootstore-"));
	try {
		const rootStore = new FileStore(rootDir);
		await rootStore.save({ agents: [{ id: "chat-persisted-1", name: "chat", repo: "/r", worktree: "/w" }] as StateSnapshot["agents"], transcripts: {}, features: [] });
		const deps: RegistryDeps = {
			root: rootDir,
			store: () => new FileStore(rootDir),
			operator,
			rootRosterIds: async () => (await new FileStore(rootDir).load()).agents.map((a) => a.id),
		};
		const reg = new ManagerRegistry(deps);

		expect([...(await reg.protectedIds())]).toEqual(["chat-persisted-1"]);
	} finally {
		await fsp.rm(rootDir, { recursive: true, force: true }).catch(() => {});
	}
});

const tmpRoot = path.join(os.tmpdir(), `reg-lifecycle-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
afterAll(async () => {
	await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

test("get after evict returns a fresh instance", async () => {
	const deps: RegistryDeps = {
		root: tmpRoot,
		store: (orgId) => new FileStore(path.join(tmpRoot, "orgs", orgId)),
		operator,
		idleMs: 0, // evict as soon as a tick passes with no live agents
	};
	const reg = new ManagerRegistry(deps);
	const first = await reg.get("orgX"); // lazy create #1
	expect(reg.peek("orgX")).toBe(first);

	const evicted = await reg.evictIdle(Date.now() + 10_000); // agent-less + past 0ms TTL ⇒ evicted
	expect(evicted).toBe(1);
	expect(reg.peek("orgX")).toBeUndefined();

	const second = await reg.get("orgX"); // lazy create #2 — a brand-new manager
	expect(second).not.toBe(first);

	await reg.stopAll();
});

test("create fires a synthetic {type:'roster'} event through onEvent right after hydration — the S4 hydration-seed boundary the per-org push lane (SquadServer.maybePushAlertOrg) relies on", async () => {
	const deps: RegistryDeps = { root: tmpRoot, store: (orgId) => new FileStore(path.join(tmpRoot, "orgs", orgId)), operator };
	const reg = new ManagerRegistry(deps);
	const events: Array<{ orgId: string; e: SquadEvent }> = [];
	reg.onEvent = (orgId, e) => events.push({ orgId, e });

	await reg.get("orgHydrate");

	// Exactly one roster-typed event, fired for the org that just hydrated, AFTER get() resolved (so
	// the manager was fully started — any of its own boot-replay events, if it had persisted state,
	// would already be in `events` ahead of this one, in call order).
	const rosterEvents = events.filter((x) => x.orgId === "orgHydrate" && x.e.type === "roster");
	expect(rosterEvents).toHaveLength(1);

	await reg.stopAll();
});
