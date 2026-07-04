/**
 * Presence registry — deterministic, no model tokens. Uses real temp repos and
 * the real on-disk registry under <stateDir>/presence (entries are namespaced
 * by resolved path, and the test cleans up its own claims).
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { all, claim, heartbeat, release, who } from "../src/presence.ts";

const made: Array<{ id: string; repo: string }> = [];

afterEach(async () => {
	for (const c of made) await release(c.id, c.repo);
	made.length = 0;
});

async function tmpDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "presence-"));
}

test("claim is discoverable via who()", async () => {
	const repo = await tmpDir();
	const id = await claim({ repo, agent: "alpha", branch: "squad/x", task: "do a thing", source: "squad" });
	made.push({ id, repo });
	const live = await who(repo);
	expect(live.length).toBe(1);
	expect(live[0].agent).toBe("alpha");
	expect(live[0].branch).toBe("squad/x");
	expect(live[0].source).toBe("squad");
	expect(live[0].repo).toBe(path.resolve(repo));
});

test("reattached flag round-trips through the registry", async () => {
	const repo = await tmpDir();
	const fresh = await claim({ repo, agent: "fresh", source: "squad" });
	const back = await claim({ repo, agent: "back", source: "squad", reattached: true });
	made.push({ id: fresh, repo }, { id: back, repo });
	const live = await who(repo);
	expect(live.find((e) => e.agent === "back")?.reattached).toBe(true);
	expect(live.find((e) => e.agent === "fresh")?.reattached).toBeFalsy();
});

test("two agents on the same repo are both visible (collision-safe)", async () => {
	const repo = await tmpDir();
	const a = await claim({ repo, agent: "a", source: "squad" });
	const b = await claim({ repo, agent: "b", source: "omp" });
	made.push({ id: a, repo }, { id: b, repo });
	const live = await who(repo);
	expect(live.length).toBe(2);
	expect(new Set(live.map((e) => e.agent))).toEqual(new Set(["a", "b"]));
});

test("stale claims (no heartbeat within TTL) are excluded", async () => {
	const repo = await tmpDir();
	const id = await claim({ repo, agent: "stale", source: "omp" });
	made.push({ id, repo });
	expect((await who(repo, 60_000)).length).toBe(1);
	// Let the heartbeat age, then query with a 1ms TTL → it's stale and excluded.
	await Bun.sleep(8);
	expect((await who(repo, 1)).length).toBe(0);
});

test("heartbeat keeps a claim live; release removes it", async () => {
	const repo = await tmpDir();
	const id = await claim({ repo, agent: "hb", source: "omp" });
	made.push({ id, repo });
	await heartbeat(id, repo);
	expect((await who(repo)).length).toBe(1);
	await release(id, repo);
	expect((await who(repo)).length).toBe(0);
});

test("all() surfaces claims across different repos", async () => {
	const r1 = await tmpDir();
	const r2 = await tmpDir();
	const a = await claim({ repo: r1, agent: "one", source: "squad" });
	const b = await claim({ repo: r2, agent: "two", source: "omp" });
	made.push({ id: a, repo: r1 }, { id: b, repo: r2 });
	const everything = await all();
	const repos = new Set(everything.map((e) => e.repo));
	expect(repos.has(path.resolve(r1))).toBe(true);
	expect(repos.has(path.resolve(r2))).toBe(true);
});
