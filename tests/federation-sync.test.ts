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
import type { RemoteLeases } from "../src/federation.ts";
import { claimLease, type LeaseEntry, leasesFor, mirrorLease, releaseSession } from "../src/leases.ts";
import { normalizeGitUrl, repoIdentity } from "../src/repo-identity.ts";

let coordinator: CoordinatorHandle | undefined;
let sync: FederationSyncHandle | undefined;
let peer: WebSocket | undefined;
const cleanupRepos: Array<{ repo: string; sessions: string[] }> = [];

afterEach(async () => {
	if (sync) await sync.stop();
	if (peer) peer.close();
	if (coordinator) coordinator.stop();
	sync = undefined;
	peer = undefined;
	coordinator = undefined;
	for (const c of cleanupRepos) for (const s of c.sessions) await releaseSession(s, c.repo);
	cleanupRepos.length = 0;
});

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
