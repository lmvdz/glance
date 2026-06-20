/**
 * File-lease registry — deterministic, no model tokens. Cleans up its own leases.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { claimLease, heartbeatSession, holdersOf, leasesFor, releaseSession } from "../src/leases.ts";

const sessions: Array<{ session: string; repo: string }> = [];

afterEach(async () => {
	for (const s of sessions) await releaseSession(s.session, s.repo);
	sessions.length = 0;
});

async function tmpRepo(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "lease-"));
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
