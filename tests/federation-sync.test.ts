/**
 * Cross-host file leasing — coordinator relay + federation-sync, end to end.
 * No real timers: readiness is driven by awaiting socket/mirror events.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runCoordinator } from "../src/coordinator.ts";
import type { CoordinatorHandle } from "../src/coordinator.ts";
import { startFederationSync } from "../src/federation-sync.ts";
import type { FederationSyncHandle } from "../src/federation-sync.ts";
import { LocalFederationBus, type RemoteLeases } from "../src/federation.ts";
import { claimLease, holdersOf, type LeaseEntry, leasesFor, mirrorLease, releaseSession } from "../src/leases.ts";
import { normalizeGitUrl, repoIdentity } from "../src/repo-identity.ts";
import { SquadManager } from "../src/squad-manager.ts";

// Keep the daemon's background loops out of these transport tests.
process.env.OMP_SQUAD_AUTODISPATCH = "0";

let coordinator: CoordinatorHandle | undefined;
let sync: FederationSyncHandle | undefined;
let peer: WebSocket | undefined;
const liveBuses: LocalFederationBus[] = [];
const liveManagers: Array<{ manager: SquadManager; stateDir: string }> = [];
const cleanupRepos: Array<{ repo: string; sessions: string[] }> = [];

afterEach(async () => {
	if (sync) await sync.stop();
	if (peer) peer.close();
	for (const b of liveBuses.splice(0)) await b.stop().catch(() => {});
	for (const { manager, stateDir } of liveManagers.splice(0)) {
		await manager.stop().catch(() => {});
		await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
	}
	if (coordinator) coordinator.stop();
	sync = undefined;
	peer = undefined;
	coordinator = undefined;
	for (const c of cleanupRepos) for (const s of c.sessions) await releaseSession(s, c.repo);
	cleanupRepos.length = 0;
});

/** Poll a synchronous predicate to a deadline (readiness off real events, not fixed sleeps). */
async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error("waitFor: condition not met before timeout");
		await new Promise((r) => setTimeout(r, 10));
	}
}

async function gitRepo(origin: string): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "fed-"));
	const run = async (args: string[]): Promise<void> => {
		await Bun.spawn(["git", "-C", repo, ...args], { stdout: "ignore", stderr: "ignore" }).exited;
	};
	await run(["init", "-q"]);
	await run(["remote", "add", "origin", origin]);
	return repo;
}

function connect(url: string): Promise<WebSocket> {
	const ws = new WebSocket(url);
	const ready = Promise.withResolvers<WebSocket>();
	ws.onopen = () => ready.resolve(ws);
	ws.onerror = () => ready.reject(new Error("ws connect failed"));
	return ready.promise;
}

test("normalizeGitUrl collapses every remote form to host/owner/repo", () => {
	expect(normalizeGitUrl("git@github.com:acme/app.git")).toBe("github.com/acme/app");
	expect(normalizeGitUrl("https://github.com/Acme/App.git")).toBe("github.com/acme/app");
	expect(normalizeGitUrl("ssh://git@github.com/acme/app")).toBe("github.com/acme/app");
	expect(normalizeGitUrl("https://user:tok@gitlab.com/acme/app.git/")).toBe("gitlab.com/acme/app");
});

test("mirrorLease writes a peer's lease into the local registry, discoverable by leasesFor", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "fed-mirror-"));
	cleanupRepos.push({ repo, sessions: ["alice:1"] });
	const entry: LeaseEntry = { id: "x", repo: "/home/alice/app", file: "src/a.ts", operator: "alice", session: "alice:1", host: "alice-box", since: Date.now(), heartbeat: Date.now() };
	await mirrorLease(repo, entry);
	const live = await leasesFor(repo);
	expect(live.map((l) => l.file)).toContain("src/a.ts");
	const mirrored = live.find((l) => l.file === "src/a.ts");
	expect(mirrored?.operator).toBe("alice");
	expect(mirrored?.host).toBe("alice-box");
});

test("a sync publishes its own leases and mirrors a peer's leases for the same repo", async () => {
	const origin = "git@github.com:acme/shared.git";
	const repo = await gitRepo(origin);
	const repoId = repoIdentity(repo);
	expect(repoId).toBe("github.com/acme/shared");
	cleanupRepos.push({ repo, sessions: ["bob:1", "alice:1"] });

	coordinator = runCoordinator({ port: 0 });

	// A remote peer (raw client). Collect the leases frame Bob's sync publishes.
	peer = await connect(coordinator.url);
	const gotBobFrame = Promise.withResolvers<RemoteLeases>();
	peer.onmessage = (ev: MessageEvent) => {
		const frame = JSON.parse(typeof ev.data === "string" ? ev.data : "") as { kind?: string } & RemoteLeases;
		if (frame.kind === "leases" && frame.operator.id === "bob") gotBobFrame.resolve(frame);
	};

	// Bob owns a lease locally before the sync starts, so the initial publish carries it.
	await claimLease({ repo, file: "src/server.ts", session: "bob:1", operator: "bob" });

	const gotAliceMirror = Promise.withResolvers<RemoteLeases>();
	sync = await startFederationSync({
		coordinatorUrl: coordinator.url,
		operator: { id: "bob", origin: "local" },
		repos: [repo],
		publishIntervalMs: 10 * 60_000,
		onMirror: (frame) => {
			if (frame.operator.id === "alice") gotAliceMirror.resolve(frame);
		},
	});

	// Producer: the peer receives Bob's owned lease.
	const bobFrame = await gotBobFrame.promise;
	expect(bobFrame.repoId).toBe(repoId);
	expect(bobFrame.leases.map((l) => l.file)).toContain("src/server.ts");
	expect(bobFrame.leases.every((l) => l.operator === "bob")).toBe(true);

	// Consumer: the peer announces Alice's lease for the same repo; Bob's sync mirrors it locally.
	const aliceLease: LeaseEntry = { id: "al", repo: "/home/alice/shared", file: "src/server.ts", operator: "alice", session: "alice:1", host: "alice-box", since: Date.now(), heartbeat: Date.now() };
	peer.send(JSON.stringify({ kind: "leases", repoId, operator: { id: "alice", origin: "remote" }, leases: [aliceLease] }));
	await gotAliceMirror.promise;

	const live = await leasesFor(repo);
	const aliceHere = live.find((l) => l.operator === "alice" && l.file === "src/server.ts");
	expect(aliceHere).toBeDefined();
	expect(aliceHere?.host).toBe("alice-box");
	// Both Bob's own lease and Alice's mirrored lease now coexist on this repo → the file is contended.
	const onServer = live.filter((l) => l.file === "src/server.ts");
	expect(new Set(onServer.map((l) => l.operator))).toEqual(new Set(["bob", "alice"]));
});

test("a peer's lease gossiped through two LocalFederationBus instances mirrors under the normalized identity and surfaces via holdersOf", async () => {
	const origin = "git@github.com:acme/twohost.git";
	// Each "host" has its OWN checkout of the same origin at a different path.
	const aliceRepo = await gitRepo(origin);
	const bobRepo = await gitRepo(origin);
	const repoId = repoIdentity(aliceRepo);
	expect(repoId).toBe("github.com/acme/twohost");
	expect(repoIdentity(bobRepo)).toBe(repoId);
	cleanupRepos.push({ repo: aliceRepo, sessions: ["alice:1"] }, { repo: bobRepo, sessions: ["bob:1", "alice:1"] });

	coordinator = runCoordinator({ port: 0 });
	const aliceBus = new LocalFederationBus({ operator: { id: "alice", origin: "local" }, coordinatorUrl: coordinator.url });
	const bobBus = new LocalFederationBus({ operator: { id: "bob", origin: "local" }, coordinatorUrl: coordinator.url });
	liveBuses.push(aliceBus, bobBus);
	await Promise.all([aliceBus.start(), bobBus.start()]);
	await waitFor(() => coordinator?.clients() === 2);

	// Bob's side mirrors any inbound peer lease (not his own) into HIS local registry for the same identity.
	const mirrored = Promise.withResolvers<RemoteLeases>();
	bobBus.onLeases((frame) => {
		if (frame.operator.id === "bob") return; // never mirror our own loopback
		void (async () => {
			for (const lease of frame.leases) await mirrorLease(bobRepo, lease);
			mirrored.resolve(frame);
		})();
	});

	// Bob holds his own lease on the repo first.
	await claimLease({ repo: bobRepo, file: "src/index.ts", session: "bob:1", operator: "bob" });

	// Alice publishes a lease for the SAME repo identity (her own host-local path is irrelevant to bucketing).
	const aliceLease: LeaseEntry = { id: "al", repo: aliceRepo, file: "src/server.ts", operator: "alice", session: "alice:1", host: "alice-box", since: Date.now(), heartbeat: Date.now() };
	aliceBus.publishLeases(repoId, [aliceLease]);

	await mirrored.promise;

	// Alice's lease landed in Bob's identity bucket; both surface together via leasesFor (queried by BOB's path).
	const live = await leasesFor(bobRepo);
	expect(new Set(live.map((l) => l.file))).toEqual(new Set(["src/index.ts", "src/server.ts"]));
	const aliceHere = live.find((l) => l.operator === "alice" && l.file === "src/server.ts");
	expect(aliceHere).toBeDefined();
	expect(aliceHere?.host).toBe("alice-box");

	// And the lease-hook's contention check (holdersOf) sees the cross-host holder on Bob's box.
	const contenders = await holdersOf(bobRepo, "src/server.ts", "bob:1");
	expect(contenders.map((l) => l.operator)).toContain("alice");
});

test("SEAM 1: a lone SquadManager gossips its owned leases in-process — no standalone federation-sync worker", async () => {
	const origin = "git@github.com:acme/inproc.git";
	const repo = await gitRepo(origin);
	const repoId = repoIdentity(repo);
	expect(repoId).toBe("github.com/acme/inproc");
	cleanupRepos.push({ repo, sessions: ["carol:1"] });

	coordinator = runCoordinator({ port: 0 });

	// A raw peer on the hub collects the leases frame the DAEMON gossips (no startFederationSync here).
	peer = await connect(coordinator.url);
	const gotCarolFrame = Promise.withResolvers<RemoteLeases>();
	peer.onmessage = (ev: MessageEvent) => {
		const frame = JSON.parse(typeof ev.data === "string" ? ev.data : "") as { kind?: string } & RemoteLeases;
		// The manager also publishes once (empty) at start, before the lease is claimed — ignore that;
		// capture the frame that actually carries carol's owned lease.
		if (frame.kind === "leases" && frame.operator.id === "carol" && frame.leases.some((l) => l.file === "src/manager.ts")) gotCarolFrame.resolve(frame);
	};

	// A real daemon: SquadManager over its OWN LocalFederationBus joined to the coordinator. The
	// manager attaches the lease-gossip engine in start() — the standalone worker is never involved.
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fed-inproc-state-"));
	const operator = { id: "carol", origin: "local" as const };
	const bus = new LocalFederationBus({ operator, coordinatorUrl: coordinator.url, whois: async () => undefined });
	const manager = new SquadManager({ stateDir, operator, bus, fedRepos: [repo], leaseGossipIntervalMs: 10 * 60_000 });
	await manager.start();
	liveManagers.push({ manager, stateDir });

	// Both the daemon's single bus and the raw peer are on the hub — exactly one socket for the daemon.
	await waitFor(() => coordinator?.clients() === 2);

	// Carol owns a lease locally; the daemon's in-process gossip publishes it to the peer.
	await claimLease({ repo, file: "src/manager.ts", session: "carol:1", operator: "carol" });
	const published = await manager.gossipLeasesNow();
	expect(published).toContain(repoId);

	const carolFrame = await gotCarolFrame.promise;
	expect(carolFrame.repoId).toBe(repoId);
	expect(carolFrame.leases.map((l) => l.file)).toContain("src/manager.ts");
	expect(carolFrame.leases.every((l) => l.operator === "carol")).toBe(true);
});
