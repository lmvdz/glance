/**
 * Generic TTL registry — deterministic, no model tokens. Writes under a throwaway
 * subdir of ~/.omp/squad and removes it afterward, so it never touches the real
 * presence/leases registries.
 */

import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { repoKey, type TtlRecord, ttlRegistry } from "../src/ttl-registry.ts";

interface Rec extends TtlRecord {
	value: string;
}

const isRec = (v: unknown): v is Rec =>
	!!v && typeof v === "object" && typeof (v as Record<string, unknown>).id === "string" && typeof (v as Record<string, unknown>).heartbeat === "number";

const subdir = `test-ttl-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const reg = ttlRegistry<Rec>({ subdir, ttlMs: 60_000, isRecord: isRec });

afterAll(async () => {
	await fsp.rm(reg.root, { recursive: true, force: true }).catch(() => {});
});

test("write/readOne/readAll round-trips a record", async () => {
	const repo = "/tmp/ttl-repo-a";
	const entry: Rec = { id: "x1", heartbeat: Date.now(), value: "hello" };
	await reg.write(repo, entry);
	expect(await reg.readOne(repo, "x1")).toEqual(entry);
	const all = await reg.readAll(repo);
	expect(all.length).toBe(1);
	expect(all[0].value).toBe("hello");
	await reg.remove(repo, "x1");
	expect(await reg.readOne(repo, "x1")).toBeUndefined();
});

test("prune-on-read deletes stale entries, not just filters them", async () => {
	const repo = "/tmp/ttl-repo-b";
	await reg.write(repo, { id: "stale", heartbeat: Date.now(), value: "old" });
	// Negative TTL puts the cutoff in the future → entry is stale and gets pruned during the read.
	expect((await reg.readAll(repo, -1)).length).toBe(0);
	// Pruned for real: the file is gone, so even a generous TTL finds nothing.
	expect((await reg.readAll(repo, 60_000)).length).toBe(0);
	expect(await reg.readOne(repo, "stale")).toBeUndefined();
});

test("repoKey is stable, path-resolved, and byte-compatible with the legacy formula", async () => {
	const repo = "/tmp/ttl-repo-c";
	const expected = createHash("sha1").update(path.resolve(repo)).digest("hex").slice(0, 16);
	expect(repoKey(repo)).toBe(expected);
	expect(repoKey(repo)).toBe(repoKey(repo)); // deterministic
	expect(repoKey("/tmp/ttl-repo-c/")).toBe(expected); // trailing slash resolves to the same key
	expect(repoKey("/tmp/other")).not.toBe(expected); // distinct repos → distinct keys
	expect(reg.dirFor(repo)).toBe(path.join(os.homedir(), ".omp", "squad", subdir, expected));
});

test("sweep removes repoKey dirs left with no live records, keeps live ones", async () => {
	const live = "/tmp/ttl-sweep-live";
	const dead = "/tmp/ttl-sweep-dead";
	await reg.write(live, { id: "a", heartbeat: Date.now(), value: "fresh" });
	await reg.write(dead, { id: "b", heartbeat: Date.now() - 120_000, value: "stale" }); // past the 60s TTL
	const removed = await reg.sweep();
	expect(removed).toBeGreaterThanOrEqual(1);
	expect(await reg.readAll(live)).toHaveLength(1); // live record survives
	expect(await fsp.stat(reg.dirFor(dead)).then(() => true, () => false)).toBe(false); // dead dir gone
});
