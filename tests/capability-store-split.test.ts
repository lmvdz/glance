import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "../src/dal/store.ts";
import type { CapabilitySnapshot } from "../src/capabilities/index.ts";

/**
 * Concern 12, slice 1: the capability lane escapes the state.json blob into its own split file
 * (capabilities.json), mirroring feedback's escape. These tests pin the three load-bearing
 * behaviours: the split round-trip, the legacy fallback (embedded copy read until the split
 * file exists — and the split file WINNING once it does), and the stranded-legacy-copy hazard:
 * a blob save no longer carries capabilities, so the fallback order is what keeps a legacy
 * deployment's only copy readable until the one-time migration write lands.
 */

function capSnap(sourceId: string): CapabilitySnapshot {
	// A source that survives normalizeCapabilitySnapshot's readSource (id + name required).
	return {
		sources: [{ id: sourceId, name: sourceId, trusted: true, createdAt: 1, updatedAt: 1 } as CapabilitySnapshot["sources"][number]],
		packs: [],
		installs: [],
		verifications: [],
		audit: [],
	};
}

test("saveCapabilities writes the split file and loadCapabilities round-trips it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cap-split-"));
	const store = new FileStore(dir);
	await store.saveCapabilities(capSnap("src-a"));
	expect(existsSync(join(dir, "capabilities.json"))).toBe(true);
	const loaded = await store.loadCapabilities();
	expect(loaded.sources.map((s) => s.id)).toEqual(["src-a"]);
});

test("legacy fallback: capabilities embedded in state.json load until the split file exists — then the split file wins", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cap-legacy-"));
	writeFileSync(
		join(dir, "state.json"),
		JSON.stringify({ version: 1, agents: [], transcripts: {}, features: [], capabilities: capSnap("legacy-src") }),
	);
	const store = new FileStore(dir);
	// No split file yet: the embedded legacy copy is the readable one — both via loadCapabilities…
	expect((await store.loadCapabilities()).sources.map((s) => s.id)).toEqual(["legacy-src"]);
	// …and folded into the full load() (what loadPersisted hydrates from).
	expect((await store.load()).capabilities?.sources.map((s) => s.id)).toEqual(["legacy-src"]);
	// After a split write, the split file wins even though the stale embedded copy still exists.
	await store.saveCapabilities(capSnap("split-src"));
	expect((await store.loadCapabilities()).sources.map((s) => s.id)).toEqual(["split-src"]);
	expect((await store.load()).capabilities?.sources.map((s) => s.id)).toEqual(["split-src"]);
});

test("a blob save without capabilities does not strand or wipe the lane (split write amplification)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cap-amp-"));
	const store = new FileStore(dir);
	await store.saveCapabilities(capSnap("keeper"));
	const before = readFileSync(join(dir, "capabilities.json"), "utf8");
	// The concern's headline: a roster/transcript checkpoint (no capabilities field) must neither
	// rewrite the capability file nor reintroduce an embedded copy in state.json.
	await store.save({ agents: [], transcripts: {}, features: [] });
	expect(readFileSync(join(dir, "capabilities.json"), "utf8")).toBe(before);
	expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).capabilities).toBeUndefined();
	expect((await store.loadCapabilities()).sources.map((s) => s.id)).toEqual(["keeper"]);
});

test("save() still honors an explicitly passed capabilities field through the split file", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cap-honor-"));
	const store = new FileStore(dir);
	await store.save({ agents: [], transcripts: {}, features: [], capabilities: capSnap("via-blob") });
	expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).capabilities).toBeUndefined();
	expect((await store.loadCapabilities()).sources.map((s) => s.id)).toEqual(["via-blob"]);
});

test("a capabilities-only store counts as persisted state and load() folds it in (codex H3)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cap-only-"));
	const store = new FileStore(dir);
	expect(await store.hasState()).toBe(false);
	await store.saveCapabilities(capSnap("lone-survivor"));
	// The split file landed but no blob ever did (crash before first persist): a restart must
	// still see state, and load() must hydrate the lane — otherwise the next import overwrites
	// the only copy from an apparently-empty lane.
	expect(await store.hasState()).toBe(true);
	expect((await store.load()).capabilities?.sources.map((s) => s.id)).toEqual(["lone-survivor"]);
});

test("a corrupt split file is set aside loudly, never silently outranked by the stale legacy copy (codex M3)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cap-corrupt-"));
	writeFileSync(
		join(dir, "state.json"),
		JSON.stringify({ version: 1, agents: [], transcripts: {}, features: [], capabilities: capSnap("stale-legacy") }),
	);
	writeFileSync(join(dir, "capabilities.json"), "{ not json");
	const store = new FileStore(dir);
	const loaded = await store.loadCapabilities();
	// NOT the stale legacy copy (that would resurrect superseded state on the next write) —
	// the lane starts empty, and the corrupt bytes are preserved for recovery.
	expect(loaded.sources).toEqual([]);
	expect(existsSync(join(dir, "capabilities.json"))).toBe(false);
	const aside = (await import("node:fs")).readdirSync(dir).filter((f) => f.startsWith("capabilities.json.corrupt-"));
	expect(aside.length).toBe(1);
});
