/**
 * Cross-operator federation layer — pure logic only (no live tailnet/coordinator).
 *
 * Covers mergeRosters (dedupe / newest-wins / self-first), detectCollisions
 * (cross-operator repo+branch overlap), and the TailnetFederationBus transport
 * resilience invariant (never throws without a reachable coordinator).
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	agentRepoId,
	type Collision,
	detectCollisions,
	federationView,
	LocalFederationBus,
	mergeRosters,
	PEER_PRESENCE_TTL_MS,
	PeerRoster,
	type RemoteLeases,
	remoteCommandActor,
	stampRepoIds,
	TailnetFederationBus,
} from "../src/federation.ts";
import { runCoordinator } from "../src/coordinator.ts";
import type { CoordinatorHandle } from "../src/coordinator.ts";
import type { LeaseEntry } from "../src/leases.ts";
import { effectiveRole } from "../src/auth.ts";
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

// ── detectCollisions keyed on cross-host repo identity (#9) ───────────────────

test("detectCollisions COLLIDES on the same repo identity even at DIFFERENT host-local paths", () => {
	// Two operators on the same GitHub repo, checked out at different absolute paths.
	// Pre-#9 this NEVER fired because the key was the raw path; now the wire-carried
	// repoId groups them.
	const id = "github.com/acme/app";
	const alice = presence({
		operator: op("alice"),
		agents: [agent({ id: "a1", repo: "/home/alice/projects/app", repoId: id, branch: "main" })],
	});
	const bob = presence({
		operator: op("bob"),
		agents: [agent({ id: "b1", repo: "/Users/bob/code/app-clone", repoId: id, branch: "main" })],
	});
	const collisions = detectCollisions([alice, bob]);
	expect(collisions).toHaveLength(1);
	expect(collisions[0]?.repoId).toBe(id);
	expect(new Set(collisions[0]?.operators)).toEqual(new Set(["alice", "bob"]));
	expect(new Set(collisions[0]?.agents)).toEqual(new Set(["a1", "b1"]));
});

test("detectCollisions does NOT false-collide two different repos that share a basename", () => {
	// Same basename "app", same path even — but different origins ⇒ different identities.
	const alice = presence({
		operator: op("alice"),
		agents: [agent({ id: "a1", repo: "/work/app", repoId: "github.com/acme/app", branch: "main" })],
	});
	const bob = presence({
		operator: op("bob"),
		agents: [agent({ id: "b1", repo: "/work/app", repoId: "github.com/widgets/app", branch: "main" })],
	});
	expect(detectCollisions([alice, bob])).toEqual([]);
});

test("agentRepoId prefers the wire-carried repoId and only derives from the path when absent", () => {
	expect(agentRepoId({ repo: "/anything", repoId: "github.com/acme/app" })).toBe("github.com/acme/app");
	// No repoId on the DTO ⇒ fall back to the path-derived identity (name:<basename> for a non-git path).
	const p = "/tmp/some-non-git-checkout";
	expect(agentRepoId({ repo: p })).toBe(`name:${path.basename(p)}`);
});

test("detectCollisions derives identity from real git origins when no repoId is on the DTO", async () => {
	const dirs: string[] = [];
	const gitRepo = async (origin: string): Promise<string> => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "fed-coll-"));
		dirs.push(repo);
		const run = async (args: string[]): Promise<void> => {
			await Bun.spawn(["git", "-C", repo, ...args], { stdout: "ignore", stderr: "ignore" }).exited;
		};
		await run(["init", "-q"]);
		await run(["remote", "add", "origin", origin]);
		return repo;
	};
	try {
		const origin = "git@github.com:acme/shared.git";
		const repoA = await gitRepo(origin); // same origin,
		const repoB = await gitRepo(origin); // different path
		const alice = presence({ operator: op("alice"), agents: [agent({ id: "a1", repo: repoA, branch: "main" })] });
		const bob = presence({ operator: op("bob"), agents: [agent({ id: "b1", repo: repoB, branch: "main" })] });
		const collisions = detectCollisions([alice, bob]);
		expect(collisions).toHaveLength(1);
		expect(collisions[0]?.repoId).toBe("github.com/acme/shared");

		// And two real repos with different origins do not collide.
		const repoC = await gitRepo("git@github.com:acme/other.git");
		const carol = presence({ operator: op("carol"), agents: [agent({ id: "c1", repo: repoC, branch: "main" })] });
		expect(detectCollisions([alice, carol])).toEqual([]);
	} finally {
		for (const d of dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
	}
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

// ── stampRepoIds (outgoing presence carries cross-host identity) ──────────────

test("stampRepoIds fills in repoId for each agent without mutating the input", () => {
	const presenceIn = presence({
		operator: { id: "me", origin: "local" },
		agents: [agent({ id: "a1", repo: "/some/path", branch: "main" })],
	});
	const stamped = stampRepoIds(presenceIn);
	// Non-git path ⇒ name:<basename> identity, derived locally.
	expect(stamped.agents[0]?.repoId).toBe("name:path");
	// Input roster untouched (no in-place mutation of the manager's DTOs).
	expect(presenceIn.agents[0]?.repoId).toBeUndefined();
});

test("stampRepoIds keeps an already-present repoId", () => {
	const presenceIn = presence({
		operator: { id: "me", origin: "local" },
		agents: [agent({ id: "a1", repo: "/x", repoId: "github.com/acme/app", branch: "main" })],
	});
	expect(stampRepoIds(presenceIn).agents[0]?.repoId).toBe("github.com/acme/app");
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

// ── federationView (the /api/federation surface) ──────────────────────────────

test("federationView merges self + peers and flags a cross-operator shared branch", () => {
	const self = presence({
		operator: { id: "me", origin: "local" },
		updatedAt: 10,
		agents: [agent({ id: "a1", repo: "/r", branch: "feat" })],
	});
	const peer = presence({
		operator: op("you"),
		updatedAt: 5,
		agents: [agent({ id: "b1", repo: "/r", branch: "feat" })],
	});
	const view = federationView(self, [peer]);
	expect(view.operators.map((o) => o.operator.id)).toEqual(["me", "you"]); // self pinned head
	expect(view.collisions).toHaveLength(1);
	expect(view.collisions[0].ref).toBe("feat");
	expect(new Set(view.collisions[0].operators)).toEqual(new Set(["me", "you"]));
});

test("federationView with no peers returns just self and no collisions", () => {
	const self = presence({ operator: { id: "me", origin: "local" }, updatedAt: 1, agents: [agent({ branch: "feat" })] });
	const view = federationView(self, []);
	expect(view.operators).toEqual([self]);
	expect(view.collisions).toEqual([]);
});

// ── PeerRoster (the listener-only peer-presence collector) ────────────────────

test("PeerRoster drops our own echo and remaps peers to remote origin", () => {
	const roster = new PeerRoster("me");
	roster.record(presence({ operator: { id: "me", origin: "local" }, updatedAt: 5 })); // our own echo
	roster.record(presence({ operator: { id: "you", origin: "local" }, updatedAt: 5 })); // a peer labelling itself local
	const live = roster.live(5);
	expect(live.map((p) => p.operator.id)).toEqual(["you"]);
	expect(live[0].operator.origin).toBe("remote");
});

test("PeerRoster keeps the newest frame per operator", () => {
	const roster = new PeerRoster("me");
	roster.record(presence({ operator: op("you"), updatedAt: 1, agents: [agent({ id: "old" })] }));
	roster.record(presence({ operator: op("you"), updatedAt: 3, agents: [agent({ id: "new" })] }));
	roster.record(presence({ operator: op("you"), updatedAt: 2, agents: [agent({ id: "stale" })] })); // older than current → ignored
	const live = roster.live(3);
	expect(live).toHaveLength(1);
	expect(live[0].agents.map((a) => a.id)).toEqual(["new"]);
});

test("PeerRoster prunes a peer once it goes quiet past the TTL", () => {
	const roster = new PeerRoster("me");
	roster.record(presence({ operator: op("you"), updatedAt: 1000 }));
	expect(roster.live(1000 + PEER_PRESENCE_TTL_MS)).toHaveLength(1); // still within TTL
	expect(roster.live(1000 + PEER_PRESENCE_TTL_MS + 1)).toHaveLength(0); // past TTL → pruned
	expect(roster.live(1000)).toHaveLength(0); // and forgotten (not just hidden)
});

// ── remoteCommandActor (OMPSQ-162: receive-path must not trust wire-asserted role/origin) ──

test("remoteCommandActor strips a peer's self-asserted admin role and local origin", () => {
	const forged: Actor = { id: "mallory", origin: "local", role: "admin" };
	const actor = remoteCommandActor(forged, undefined);
	expect(actor.origin).toBe("remote");
	expect(actor.role).toBeUndefined();
	expect(effectiveRole(actor)).toBe("viewer"); // ⇒ cannot mutate the fleet
});

test("remoteCommandActor takes identity from the verified actor, never the wire claim", () => {
	const forged: Actor = { id: "alice", origin: "local", role: "admin" };
	const verified: Actor = { id: "mallory@corp", displayName: "Mallory", origin: "remote" };
	const actor = remoteCommandActor(forged, verified);
	expect(actor.id).toBe("mallory@corp"); // verified id wins over the spoofed "alice"
	expect(actor.displayName).toBe("Mallory");
	expect(actor.origin).toBe("remote");
	expect(actor.role).toBeUndefined();
	expect(effectiveRole(actor)).toBe("viewer");
});

test("remoteCommandActor falls back to a sanitized claimed id when unverified", () => {
	expect(remoteCommandActor(undefined, undefined)).toEqual({ id: "unknown", origin: "remote" });
	expect(remoteCommandActor({ id: "", origin: "remote" }, undefined)).toEqual({ id: "unknown", origin: "remote" });
	expect(remoteCommandActor({ id: "bob", origin: "remote", role: "operator" }, undefined)).toEqual({ id: "bob", origin: "remote" });
});

test("the bus receive-path resolves a forged-admin command frame to a viewer actor", async () => {
	const bus = new TailnetFederationBus({
		coordinatorUrl: "ws://127.0.0.1:1/omp-squad",
		operator: { id: "me", origin: "local" },
		whois: async () => undefined, // no tailnet verification available
	});
	const seen: Actor[] = [];
	bus.onRemoteCommand((r) => seen.push(r.actor));
	// A peer crafts a command claiming admin/local with a privileged "kill".
	const frame = { kind: "command", cmd: { type: "kill", id: "a1" }, actor: { id: "mallory", origin: "local", role: "admin" } };
	await (bus as unknown as { handleFrame(d: unknown): Promise<void> }).handleFrame(JSON.stringify(frame));
	expect(seen).toHaveLength(1);
	expect(seen[0]?.origin).toBe("remote");
	expect(seen[0]?.role).toBeUndefined();
	expect(effectiveRole(seen[0] as Actor)).toBe("viewer");
});

// ── LocalFederationBus: local-only loopback (the single-host default) ──────────

test("LocalFederationBus with no coordinator loops publishes back to local subscribers and never throws", async () => {
	const bus = new LocalFederationBus({ operator: { id: "me", origin: "local" } });
	expect(bus.federated).toBe(false);
	const gotPresence: OperatorPresence[] = [];
	const gotLeases: RemoteLeases[] = [];
	bus.onPresence((p) => gotPresence.push(p));
	bus.onLeases((f) => gotLeases.push(f));

	// start() must resolve immediately with no coordinator and never block.
	await bus.start();

	const self = presence({ operator: { id: "me", origin: "local" }, updatedAt: 1, agents: [agent({ id: "a1", repo: "/some/path", branch: "main" })] });
	expect(() => bus.publishPresence(self)).not.toThrow();
	const lease: LeaseEntry = { id: "l1", repo: "/some/path", file: "src/a.ts", operator: "me", session: "me:1", host: "box", since: 0, heartbeat: 0 };
	expect(() => bus.publishLeases("github.com/acme/app", [lease])).not.toThrow();

	// Loopback delivered our own publishes synchronously to local subscribers.
	expect(gotPresence).toHaveLength(1);
	// repoId was stamped on the way out (the wire-carried cross-host identity).
	expect(gotPresence[0]?.agents[0]?.repoId).toBe("name:path");
	expect(gotLeases).toHaveLength(1);
	expect(gotLeases[0]?.operator.id).toBe("me");
	expect(gotLeases[0]?.leases[0]?.file).toBe("src/a.ts");

	// Our own presence is NOT recorded as a peer (own-id echo is dropped by the roster).
	expect(bus.roster.live()).toEqual([]);
	await bus.stop();
});

// ── LocalFederationBus: two buses gossiping in-process via a real coordinator ──

let coord: CoordinatorHandle | undefined;
const liveBuses: LocalFederationBus[] = [];

afterEach(async () => {
	for (const b of liveBuses.splice(0)) await b.stop().catch(() => {});
	coord?.stop();
	coord = undefined;
});

/** Two LocalFederationBus instances joined to a throwaway in-process coordinator. */
async function twoBuses(opA: Actor, opB: Actor): Promise<[LocalFederationBus, LocalFederationBus]> {
	coord = runCoordinator({ port: 0 });
	const a = new LocalFederationBus({ operator: opA, coordinatorUrl: coord.url });
	const b = new LocalFederationBus({ operator: opB, coordinatorUrl: coord.url });
	liveBuses.push(a, b);
	expect(a.federated).toBe(true);
	expect(b.federated).toBe(true);
	await Promise.all([a.start(), b.start()]);
	// The coordinator only fans out to clients connected at receive time; wait until BOTH sockets are up.
	await waitFor(() => coord?.clients() === 2);
	return [a, b];
}

/** Poll a synchronous predicate to a deadline (drives readiness off real events, not fixed sleeps). */
async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error("waitFor: condition not met before timeout");
		await new Promise((r) => setTimeout(r, 10));
	}
}

test("two LocalFederationBus instances gossip presence + leases through the coordinator", async () => {
	const [a, b] = await twoBuses({ id: "alice", origin: "local" }, { id: "bob", origin: "local" });

	const gotPresence = Promise.withResolvers<OperatorPresence>();
	const gotLeases = Promise.withResolvers<RemoteLeases>();
	// B observes A. (B's onPresence also fires for B's OWN loopback publishes, so filter to alice.)
	b.onPresence((p) => {
		if (p.operator.id === "alice") gotPresence.resolve(p);
	});
	b.onLeases((f) => {
		if (f.operator.id === "alice") gotLeases.resolve(f);
	});

	const alicePresence = presence({
		operator: { id: "alice", origin: "local" },
		// A live wall-clock timestamp so the frame survives the PeerRoster TTL (90s) on the receive side.
		updatedAt: Date.now(),
		agents: [agent({ id: "a1", name: "auth", repo: "/home/alice/app", repoId: "github.com/acme/app", branch: "main" })],
	});
	a.publishPresence(alicePresence);

	const aliceLease: LeaseEntry = { id: "al", repo: "/home/alice/app", file: "src/server.ts", operator: "alice", session: "alice:1", host: "alice-box", since: 1, heartbeat: 1 };
	a.publishLeases("github.com/acme/app", [aliceLease]);

	const seenPresence = await gotPresence.promise;
	expect(seenPresence.operator.id).toBe("alice");
	// The raw onPresence frame carries what the peer published; the PeerRoster is what remaps
	// origin → "remote" (asserted below). repoId was stamped on the way out.
	expect(seenPresence.agents[0]?.repoId).toBe("github.com/acme/app");

	const seenLeases = await gotLeases.promise;
	expect(seenLeases.repoId).toBe("github.com/acme/app");
	expect(seenLeases.leases[0]?.file).toBe("src/server.ts");
	expect(seenLeases.leases.every((l) => l.operator === "alice")).toBe(true);

	// B's PeerRoster now holds alice (and not bob/itself), remapped to a remote-origin peer.
	await waitFor(() => b.roster.live().some((p) => p.operator.id === "alice"));
	const peers = b.roster.live();
	expect(peers.map((p) => p.operator.id)).toEqual(["alice"]);
	expect(peers[0]?.operator.origin).toBe("remote");
});

test("identity-keyed collision detection fires across two buses for the same repo at different paths", async () => {
	const [a, b] = await twoBuses({ id: "alice", origin: "local" }, { id: "bob", origin: "local" });

	const aliceSeen = Promise.withResolvers<void>();
	a.onPresence((p) => {
		if (p.operator.id === "bob") aliceSeen.resolve();
	});

	// Bob and Alice work the SAME GitHub repo at DIFFERENT absolute paths, same branch.
	const repoId = "github.com/acme/app";
	b.publishPresence(
		presence({
			operator: { id: "bob", origin: "local" },
			// Live wall-clock timestamp so bob's frame survives alice's PeerRoster TTL.
			updatedAt: Date.now(),
			agents: [agent({ id: "b1", repo: "/Users/bob/code/app", repoId, branch: "main" })],
		}),
	);
	await aliceSeen.promise;

	// Alice's own roster (self) merged with the peer roster (bob) yields a cross-host collision.
	const self = presence({
		operator: { id: "alice", origin: "local" },
		updatedAt: Date.now(),
		agents: [agent({ id: "a1", repo: "/home/alice/projects/app", repoId, branch: "main" })],
	});
	await waitFor(() => a.roster.live().some((p) => p.operator.id === "bob"));
	const view = federationView(self, a.roster.live());
	expect(view.operators.map((o) => o.operator.id)).toEqual(["alice", "bob"]);
	expect(view.collisions).toHaveLength(1);
	expect(view.collisions[0]?.repoId).toBe(repoId);
	expect(view.collisions[0]?.ref).toBe("main");
	expect(new Set(view.collisions[0]?.operators)).toEqual(new Set(["alice", "bob"]));
});

test("OMP_SQUAD_FEDERATION opt-out: a bus with no coordinator is local-only and never reaches a peer", async () => {
	// Two LOCAL-ONLY buses (no coordinator) are fully isolated — nothing crosses between them.
	const a = new LocalFederationBus({ operator: { id: "alice", origin: "local" } });
	const b = new LocalFederationBus({ operator: { id: "bob", origin: "local" } });
	liveBuses.push(a, b);
	await Promise.all([a.start(), b.start()]);
	const bSaw: OperatorPresence[] = [];
	b.onPresence((p) => bSaw.push(p));
	a.publishPresence(presence({ operator: { id: "alice", origin: "local" }, updatedAt: 1, agents: [agent({ branch: "main" })] }));
	// No coordinator ⇒ no path from A to B; B's roster + subscribers stay empty.
	expect(bSaw).toEqual([]);
	expect(a.roster.live()).toEqual([]);
	expect(b.roster.live()).toEqual([]);
});
