import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listFile, mapFile, openMapLedger, openSetLedger } from "../src/ledger.ts";

/**
 * The shared stateDir ledger idiom (src/ledger.ts) through its interface. The six declaring
 * modules' own tests (dispatch, removed-agent-durable, goal-overlap-ledger, race-once,
 * land-ledger, failure-memory) pin their policy; this file pins the shared contract those
 * policies stand on: corrupt→empty, best-effort durable writes, shape round-trips, retention.
 */

const dir = () => mkdtempSync(path.join(tmpdir(), "ledger-"));

describe("openSetLedger", () => {
	test("round-trips as a sorted array; add is idempotent and batchable", () => {
		const d = dir();
		const a = openSetLedger(d, "s.json");
		a.add("b", "a", "b");
		expect(JSON.parse(readFileSync(path.join(d, "s.json"), "utf8"))).toEqual(["a", "b"]);
		const b = openSetLedger(d, "s.json");
		expect(b.has("a")).toBeTrue();
		b.delete("a");
		expect(openSetLedger(d, "s.json").has("a")).toBeFalse();
	});

	test("corrupt or wrong-shaped file degrades to empty, never throws", () => {
		const d = dir();
		writeFileSync(path.join(d, "s.json"), "{not json");
		expect(openSetLedger(d, "s.json").has("x")).toBeFalse();
		writeFileSync(path.join(d, "s.json"), JSON.stringify({ an: "object" }));
		expect(openSetLedger(d, "s.json").has("x")).toBeFalse();
		writeFileSync(path.join(d, "s.json"), JSON.stringify(["ok", 7, ""]));
		const l = openSetLedger(d, "s.json");
		expect(l.has("ok")).toBeTrue(); // non-strings and empties filtered, valid ids kept
	});

	test("a throwing custom decode degrades to empty instead of crashing open", () => {
		const d = dir();
		writeFileSync(path.join(d, "s.json"), JSON.stringify(["a"]));
		const l = openSetLedger(d, "s.json", () => {
			throw new Error("bad decode");
		});
		expect(l.has("a")).toBeFalse();
	});
});

describe("openMapLedger", () => {
	test("get/put round-trip; conditional policies compose from get+put", () => {
		const d = dir();
		const a = openMapLedger<{ n: number }>(d, "m.json");
		expect(a.get("k")).toBeUndefined();
		a.put("k", { n: 1 });
		expect(openMapLedger<{ n: number }>(d, "m.json").get("k")).toEqual({ n: 1 });
	});

	test("corrupt/array file degrades to empty", () => {
		const d = dir();
		writeFileSync(path.join(d, "m.json"), JSON.stringify([1, 2]));
		expect(openMapLedger(d, "m.json").get("0")).toBeUndefined();
	});
});

describe("mapFile (uncached)", () => {
	test("every read is fresh — an out-of-band write is visible without reopening", () => {
		const d = dir();
		const f = mapFile<number>(d, "f.json");
		expect(f.read()).toEqual({});
		writeFileSync(path.join(d, "f.json"), JSON.stringify({ x: 1 }));
		expect(f.read()).toEqual({ x: 1 });
		f.write({ y: 2 });
		expect(f.read()).toEqual({ y: 2 });
	});
});

describe("listFile", () => {
	test("append returns the new count and preserves order, oldest first", () => {
		const d = dir();
		const f = listFile<string>(d, "l.json");
		expect(f.append("a")).toBe(1);
		expect(f.append("b")).toBe(2);
		expect(f.read()).toEqual(["a", "b"]);
	});

	test("retention guard drops oldest above maxEntries but never below minRetained", () => {
		const d = dir();
		const f = listFile<number>(d, "l.json", { maxEntries: 3, minRetained: 2 });
		for (let i = 1; i <= 5; i++) f.append(i);
		expect(f.read()).toEqual([3, 4, 5]); // capped at 3, oldest dropped
		const floorWins = listFile<number>(d, "floor.json", { maxEntries: 1, minRetained: 2 });
		floorWins.append(1);
		floorWins.append(2);
		floorWins.append(3);
		expect(floorWins.read()).toEqual([2, 3]); // the floor beats the cap on conflict
	});

	test("no retention by default — audit-trail semantics preserved", () => {
		const d = dir();
		const f = listFile<number>(d, "l.json");
		for (let i = 0; i < 50; i++) f.append(i);
		expect(f.read().length).toBe(50);
	});
});
