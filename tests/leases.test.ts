/**
 * File-lease registry — deterministic, no model tokens. Cleans up its own leases.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { claimLease, type LeaseEntry, heartbeatSession, holdersOf, leasesFor, mirrorLease, reapDeadSessions, releaseSession } from "../src/leases.ts";
import { repoIdentity } from "../src/repo-identity.ts";

const sessions: Array<{ session: string; repo: string }> = [];
const dirs: string[] = [];

afterEach(async () => {
	for (const s of sessions) await releaseSession(s.session, s.repo);
	sessions.length = 0;
	for (const d of dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
	dirs.length = 0;
});

async function tmpRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "lease-"));
	dirs.push(repo);
	return repo;
}

async function gitRepo(origin: string): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "lease-git-"));
	dirs.push(repo);
	const run = async (args: string[]): Promise<void> => {
		await Bun.spawn(["git", "-C", repo, ...args], { stdout: "ignore", stderr: "ignore" }).exited;
	};
	await run(["init", "-q"]);
	await run(["remote", "add", "origin", origin]);
	return repo;
}

test("claimLease is discoverable via leasesFor", async () => {
	const repo = await tmpRepo();
	await claimLease({ repo, file: "src/a.ts", session: "s1" });
	sessions.push({ session: "s1", repo });
	const live = await leasesFor(repo);
	expect(live.length).toBe(1);
	expect(live[0].file).toBe("src/a.ts");
	expect(live[0].session).toBe("s1");
	expect(live[0].repo).toBe(path.resolve(repo));
});

test("holdersOf reveals a conflicting session on the same file", async () => {
	const repo = await tmpRepo();
	await claimLease({ repo, file: "src/hot.ts", session: "alice" });
	await claimLease({ repo, file: "src/hot.ts", session: "bob" });
	sessions.push({ session: "alice", repo }, { session: "bob", repo });
	const fromBob = await holdersOf(repo, "src/hot.ts", "bob");
	expect(fromBob.length).toBe(1);
	expect(fromBob[0].session).toBe("alice"); // bob sees alice holding it
	// A file only bob holds → no other holders.
	await claimLease({ repo, file: "src/only-bob.ts", session: "bob" });
	expect((await holdersOf(repo, "src/only-bob.ts", "bob")).length).toBe(0);
});

test("re-claiming the same file by the same session updates one lease", async () => {
	const repo = await tmpRepo();
	await claimLease({ repo, file: "src/x.ts", session: "s" });
	await claimLease({ repo, file: "src/x.ts", session: "s" });
	sessions.push({ session: "s", repo });
	expect((await leasesFor(repo)).filter((l) => l.file === "src/x.ts").length).toBe(1);
});

test("releaseSession drops all of a session's leases", async () => {
	const repo = await tmpRepo();
	await claimLease({ repo, file: "a", session: "s" });
	await claimLease({ repo, file: "b", session: "s" });
	expect((await leasesFor(repo)).length).toBe(2);
	await releaseSession("s", repo);
	expect((await leasesFor(repo)).length).toBe(0);
});

// ── identity-keyed buckets + cross-host mirroring (#9) ────────────────────────

test("leases bucket on repo identity: a second checkout of the same origin sees the same leases", async () => {
	const origin = "git@github.com:acme/shared.git";
	const repoA = await gitRepo(origin); // operator's checkout
	const repoB = await gitRepo(origin); // a DIFFERENT path, same origin (e.g. a worktree / second clone)
	expect(repoA).not.toBe(repoB);
	expect(repoIdentity(repoA)).toBe(repoIdentity(repoB));

	await claimLease({ repo: repoA, file: "src/server.ts", session: "s1" });
	sessions.push({ session: "s1", repo: repoA });

	// Querying via the OTHER path resolves to the same identity bucket.
	const fromB = await leasesFor(repoB);
	expect(fromB.map((l) => l.file)).toContain("src/server.ts");
	// The stored repo FIELD stays the host-local display path of the claimer.
	expect(fromB.find((l) => l.file === "src/server.ts")?.repo).toBe(path.resolve(repoA));
});

test("a mirrored peer lease is stored/queried under the normalized identity, not the peer's path", async () => {
	const origin = "git@github.com:acme/app.git";
	const localRepo = await gitRepo(origin); // OUR checkout of the shared repo
	sessions.push({ session: "local:1", repo: localRepo });

	// We hold a local lease on one file.
	await claimLease({ repo: localRepo, file: "src/a.ts", session: "local:1", operator: "me" });

	// A peer (on another host, different absolute path) gossiped a lease for the SAME repo.
	const peerLease: LeaseEntry = {
		id: "ignored", // mirrorLease rekeys into the mirror id space
		repo: "/home/alice/elsewhere/app", // peer's host-local path — irrelevant to bucketing
		file: "src/b.ts",
		operator: "alice",
		session: "alice:7",
		host: "alice-box",
		since: Date.now(),
		heartbeat: Date.now(),
	};
	await mirrorLease(localRepo, peerLease);
	sessions.push({ session: "alice:7", repo: localRepo }); // clean the mirrored entry out of the identity bucket too

	// Both surface together for OUR repo because both buckets key on github.com/acme/app.
	const live = await leasesFor(localRepo);
	expect(new Set(live.map((l) => l.file))).toEqual(new Set(["src/a.ts", "src/b.ts"]));
	const mirrored = live.find((l) => l.file === "src/b.ts");
	expect(mirrored?.operator).toBe("alice"); // remote operator/host preserved for display
	expect(mirrored?.host).toBe("alice-box");

	// And holdersOf (the lease-hook's contention warning) sees the cross-host holder.
	const contenders = await holdersOf(localRepo, "src/b.ts", "local:1");
	expect(contenders.map((l) => l.operator)).toContain("alice");
});

test("stale leases (no heartbeat within TTL) drop out", async () => {
	const repo = await tmpRepo();
	await claimLease({ repo, file: "a", session: "s" });
	sessions.push({ session: "s", repo });
	expect((await leasesFor(repo, 60_000)).length).toBe(1);
	// heartbeat keeps it live under a normal TTL
	await heartbeatSession("s", repo);
	expect((await leasesFor(repo, 60_000)).length).toBe(1);
	// A negative TTL puts the cutoff in the future → the entry is treated as stale (and pruned), deterministically, no sleep.
	expect((await leasesFor(repo, -1)).length).toBe(0);
});

// ── pid-liveness backstop (removal/reap release, GRAPH-FOLD U4) ──────────────
//
// Federation observed leases 22h-4d old belonging to agents that had been REMOVED — the graceful
// release path (lease-hook.ts's own session_shutdown, or the manager releasing by known pid on an
// explicit remove) never runs for a hard kill / crash / orphan-host reap. `reapDeadSessions` is the
// repo-agnostic backstop: a lease's session is minted verbatim as `omp:<pid>` (lease-hook.ts), so a
// dead local pid is unambiguous proof the session is gone, independent of heartbeat freshness.

/** A definitely-dead, definitely-not-reused-within-this-test pid: spawn a trivial process and wait for
 *  Bun to reap it — `process.kill(pid, 0)` then reliably throws ESRCH. */
async function deadPid(): Promise<number> {
	const proc = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
	await proc.exited;
	return proc.pid;
}

test("reapDeadSessions releases a lease whose omp:<pid> session's process is gone; live pids and non-omp sessions are untouched", async () => {
	const repo = await tmpRepo();
	const dead = await deadPid();

	await claimLease({ repo, file: "dead.ts", session: `omp:${dead}` });
	await claimLease({ repo, file: "live.ts", session: `omp:${process.pid}` }); // this test process — definitely alive
	await claimLease({ repo, file: "other.ts", session: "alice:7" }); // not omp:<pid>-shaped at all
	sessions.push({ session: `omp:${dead}`, repo }, { session: `omp:${process.pid}`, repo }, { session: "alice:7", repo });
	expect((await leasesFor(repo)).length).toBe(3);

	// reapDeadSessions scans EVERY repo bucket on the host (it's a machine-wide backstop, by design —
	// see its own doc comment), so its total `removed` count is not scoped to this test's repo when the
	// suite runs other files' lease fixtures concurrently; assert the effect on THIS repo's bucket
	// instead of the global count (mirrors ttl-registry.test.ts's own `toBeGreaterThanOrEqual` sweep
	// assertion, for the same cross-test-isolation reason).
	const removed = await reapDeadSessions();
	expect(removed).toBeGreaterThanOrEqual(1);

	const live = await leasesFor(repo);
	expect(live.map((l) => l.file).sort()).toEqual(["live.ts", "other.ts"]);
});

test("reapDeadSessions never touches a mirrored cross-host lease, even one whose session happens to be pid-shaped and locally dead", async () => {
	const repo = await tmpRepo();
	const dead = await deadPid();
	const peerLease: LeaseEntry = {
		id: "ignored",
		repo: "/peer/path",
		file: "src/peer.ts",
		operator: "alice",
		session: `omp:${dead}`, // coincidentally shaped like a local session, but it's alice's REMOTE pid
		host: "alice-box",
		since: Date.now(),
		heartbeat: Date.now(),
	};
	await mirrorLease(repo, peerLease);
	sessions.push({ session: `omp:${dead}`, repo });

	await reapDeadSessions();
	const live = await leasesFor(repo);
	expect(live.map((l) => l.file)).toContain("src/peer.ts"); // untouched — host mismatch guards it
});
