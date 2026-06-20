/**
 * Cross-operator federation layer — pure logic only (no live tailnet/coordinator).
 *
 * Covers mergeRosters (dedupe / newest-wins / self-first), detectCollisions
 * (cross-operator repo+branch overlap), and the TailnetFederationBus transport
 * resilience invariant (never throws without a reachable coordinator).
 */

import { expect, test } from "bun:test";
import {
	type Collision,
	detectCollisions,
	mergeRosters,
	TailnetFederationBus,
} from "../src/federation.ts";
import type { Actor, AgentDTO, Availability, OperatorPresence } from "../src/types.ts";

function agent(over: Partial<AgentDTO> = {}): AgentDTO {
	return {
		id: "a",
		name: "a",
		status: "idle",
		repo: "/repo",
		worktree: "/wt",
		approvalMode: "write",
		pending: [],
		lastActivity: 0,
		messageCount: 0,
		...over,
	};
}

function presence(over: Partial<OperatorPresence> & { operator: Actor }): OperatorPresence {
	return {
		availability: "active",
		agents: [],
		updatedAt: 0,
		...over,
	};
}

function op(id: string): Actor {
	return { id, origin: "remote" };
}

// ── mergeRosters ──────────────────────────────────────────────────────────────

test("mergeRosters keeps self first and appends distinct peers", () => {
	const self = presence({ operator: { id: "me", origin: "local" }, updatedAt: 100 });
	const a = presence({ operator: op("alice"), updatedAt: 50 });
	const b = presence({ operator: op("bob"), updatedAt: 999 });
	const merged = mergeRosters(self, [a, b]);
	// self stays first even though "bob" has a far newer timestamp.
	expect(merged.map((p) => p.operator.id)).toEqual(["me", "alice", "bob"]);
});

test("mergeRosters dedupes a repeated operator, newest updatedAt winning", () => {
	const self = presence({ operator: { id: "me", origin: "local" }, updatedAt: 0 });
	const older = presence({ operator: op("alice"), updatedAt: 10, availability: "away" });
	const newer = presence({ operator: op("alice"), updatedAt: 20, availability: "active" });

	const merged = mergeRosters(self, [older, newer]);
	const alice = merged.filter((p) => p.operator.id === "alice");
	expect(alice).toHaveLength(1);
	expect(alice[0]?.updatedAt).toBe(20);
	expect(alice[0]?.availability).toBe("active");

	// Newest wins regardless of arrival order.
	const reversed = mergeRosters(self, [newer, older]);
	const aliceRev = reversed.filter((p) => p.operator.id === "alice");
	expect(aliceRev).toHaveLength(1);
	expect(aliceRev[0]?.updatedAt).toBe(20);
});

test("mergeRosters never duplicates self and never lets an older echo overwrite it", () => {
	const self = presence({ operator: { id: "me", origin: "local" }, updatedAt: 5, availability: "active" });
	const echo = presence({ operator: { id: "me", origin: "remote" }, updatedAt: 1, availability: "offline" });
	const merged = mergeRosters(self, [echo]);
	expect(merged).toHaveLength(1);
	expect(merged[0]?.operator.id).toBe("me");
	// self is strictly newer, so its local origin + availability survive.
	expect(merged[0]?.operator.origin).toBe("local");
	expect(merged[0]?.availability).toBe("active");
});

test("mergeRosters with no peers returns just self", () => {
	const self = presence({ operator: { id: "me", origin: "local" }, updatedAt: 7 });
	expect(mergeRosters(self, [])).toEqual([self]);
});

// ── detectCollisions ────────────────────────────────────────────────────────

test("detectCollisions flags one collision for the same repo+branch across two operators", () => {
	const alice = presence({
		operator: op("alice"),
		agents: [agent({ id: "a1", name: "auth", repo: "/r", branch: "main" })],
	});
	const bob = presence({
		operator: op("bob"),
		agents: [agent({ id: "b1", name: "fix", repo: "/r", branch: "main" })],
	});
	const collisions = detectCollisions([alice, bob]);
	expect(collisions).toHaveLength(1);
	const c = collisions[0] as Collision;
	expect(c.repo).toBe("/r");
	expect(c.ref).toBe("main");
	expect(new Set(c.operators)).toEqual(new Set(["alice", "bob"]));
	expect(new Set(c.agents)).toEqual(new Set(["a1", "b1"]));
});

test("detectCollisions ignores same-operator overlap on one repo+branch", () => {
	const alice = presence({
		operator: op("alice"),
		agents: [
			agent({ id: "a1", repo: "/r", branch: "main" }),
			agent({ id: "a2", repo: "/r", branch: "main" }),
		],
	});
	expect(detectCollisions([alice])).toEqual([]);
});

test("detectCollisions ignores a shared repo on different branches", () => {
	const alice = presence({ operator: op("alice"), agents: [agent({ id: "a1", repo: "/r", branch: "main" })] });
	const bob = presence({ operator: op("bob"), agents: [agent({ id: "b1", repo: "/r", branch: "dev" })] });
	expect(detectCollisions([alice, bob])).toEqual([]);
});

test("detectCollisions ignores the same branch name on different repos", () => {
	const alice = presence({ operator: op("alice"), agents: [agent({ id: "a1", repo: "/r1", branch: "main" })] });
	const bob = presence({ operator: op("bob"), agents: [agent({ id: "b1", repo: "/r2", branch: "main" })] });
	expect(detectCollisions([alice, bob])).toEqual([]);
});

test("detectCollisions skips agents that have no branch (no comparable ref)", () => {
	const alice = presence({ operator: op("alice"), agents: [agent({ id: "a1", repo: "/r" })] });
	const bob = presence({ operator: op("bob"), agents: [agent({ id: "b1", repo: "/r" })] });
	expect(detectCollisions([alice, bob])).toEqual([]);
});

test("detectCollisions reports all operators and agents when three operators overlap", () => {
	const presences = ["alice", "bob", "carol"].map((id) =>
		presence({ operator: op(id), agents: [agent({ id: `${id}-1`, repo: "/r", branch: "main" })] }),
	);
	const collisions = detectCollisions(presences);
	expect(collisions).toHaveLength(1);
	expect(new Set(collisions[0]?.operators)).toEqual(new Set(["alice", "bob", "carol"]));
	expect(new Set(collisions[0]?.agents)).toEqual(new Set(["alice-1", "bob-1", "carol-1"]));
});

test("detectCollisions returns one entry per distinct overlapping repo+branch", () => {
	const alice = presence({
		operator: op("alice"),
		agents: [
			agent({ id: "a1", repo: "/r", branch: "main" }),
			agent({ id: "a2", repo: "/r", branch: "feat" }),
		],
	});
	const bob = presence({
		operator: op("bob"),
		agents: [
			agent({ id: "b1", repo: "/r", branch: "main" }),
			agent({ id: "b2", repo: "/r", branch: "feat" }),
		],
	});
	const collisions = detectCollisions([alice, bob]);
	expect(collisions).toHaveLength(2);
	expect(new Set(collisions.map((c) => c.ref))).toEqual(new Set(["main", "feat"]));
});

// ── TailnetFederationBus (no coordinator) ─────────────────────────────────────

test("TailnetFederationBus is inert and non-throwing without a reachable coordinator", async () => {
	const calls: { ip: string }[] = [];
	const bus = new TailnetFederationBus({
		coordinatorUrl: "ws://127.0.0.1:1/omp-squad",
		operator: { id: "me", origin: "local" },
		whois: async (ip: string) => {
			calls.push({ ip });
			return undefined;
		},
	});
	bus.onPresence(() => {});
	bus.onRemoteCommand(() => {});
	bus.onMessage(() => {});

	// Pre-connection: publishing/sending must not throw (nothing is wired yet).
	const self = presence({ operator: { id: "me", origin: "local" }, updatedAt: 1, availability: "active" satisfies Availability });
	expect(() => bus.publishPresence(self)).not.toThrow();
	expect(() => bus.sendMessage("hi")).not.toThrow();

	// start() kicks off a background connect to an unreachable port; it must resolve,
	// and a follow-up publish (socket not open) must still be swallowed silently.
	await bus.start();
	expect(() => bus.publishPresence(self)).not.toThrow();
	await bus.stop();

	// whois was injected but never exercised (no inbound command frames arrived).
	expect(calls).toHaveLength(0);
});
