/**
 * Operator-attention substrate (comprehension concern 01, src/attention.ts): the compacted
 * last-seen map is fog's ONLY read source, so its three invariants — monotone merge, idempotent
 * replay coalescing, and a hard per-actor rate ceiling — are load-bearing, not incidental. Plus the
 * tenant-scoping redaction functions, which DESIGN.md calls out by name as needing "a tested
 * deliverable with an acceptance test" rather than prose.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AttentionStore, redactAttentionForActor, redactSeenMapForActor, type AttentionEvent } from "../src/attention.ts";

function tmp(): string {
	return mkdtempSync(path.join(os.tmpdir(), "attention-"));
}

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dir(): string {
	const d = tmp();
	dirs.push(d);
	return d;
}

describe("record: kill switch", () => {
	test("GLANCE_ATTENTION=0 disables record() — no writes, ok:false", () => {
		const original = process.env.GLANCE_ATTENTION;
		process.env.GLANCE_ATTENTION = "0";
		try {
			const store = new AttentionStore({ stateDir: dir() });
			expect(store.record({ kind: "diff-viewed", repo: "/r", file: "a.ts" }, "actor")).toEqual({ ok: false, reason: "disabled" });
			expect(store.recentEvents()).toEqual([]);
			expect(store.lastSeen("/r", "a.ts")).toBeUndefined();
			expect(store.disabled()).toBe(true);
		} finally {
			if (original === undefined) delete process.env.GLANCE_ATTENTION;
			else process.env.GLANCE_ATTENTION = original;
		}
	});

	test("unset (or any non-'0' value) leaves attention enabled", () => {
		const original = process.env.GLANCE_ATTENTION;
		delete process.env.GLANCE_ATTENTION;
		try {
			const store = new AttentionStore({ stateDir: dir() });
			expect(store.disabled()).toBe(false);
			expect(store.record({ kind: "diff-viewed", repo: "/r", file: "a.ts" }, "actor").ok).toBe(true);
		} finally {
			if (original === undefined) delete process.env.GLANCE_ATTENTION;
			else process.env.GLANCE_ATTENTION = original;
		}
	});

	// Batch-3 review: `.env.example` documented OMP_SQUAD_ATTENTION as a legacy alias for
	// GLANCE_ATTENTION, but `disabled()` used to read ONLY the new name — the legacy alias silently
	// did nothing. These exercise the real flag pair end-to-end through the real `disabled()` method
	// (not just `envBoolAliased` in isolation, which config.test.ts already covers generically).
	test("the legacy OMP_SQUAD_ATTENTION=0 alone (GLANCE_ATTENTION unset) still disables attention", () => {
		const originalNew = process.env.GLANCE_ATTENTION;
		const originalLegacy = process.env.OMP_SQUAD_ATTENTION;
		delete process.env.GLANCE_ATTENTION;
		process.env.OMP_SQUAD_ATTENTION = "0";
		try {
			const store = new AttentionStore({ stateDir: dir() });
			expect(store.disabled()).toBe(true);
			expect(store.record({ kind: "diff-viewed", repo: "/r", file: "a.ts" }, "actor")).toEqual({ ok: false, reason: "disabled" });
		} finally {
			if (originalNew === undefined) delete process.env.GLANCE_ATTENTION; else process.env.GLANCE_ATTENTION = originalNew;
			if (originalLegacy === undefined) delete process.env.OMP_SQUAD_ATTENTION; else process.env.OMP_SQUAD_ATTENTION = originalLegacy;
		}
	});

	test("GLANCE_ATTENTION=1 wins over a conflicting legacy OMP_SQUAD_ATTENTION=0 (primary always wins)", () => {
		const originalNew = process.env.GLANCE_ATTENTION;
		const originalLegacy = process.env.OMP_SQUAD_ATTENTION;
		process.env.GLANCE_ATTENTION = "1";
		process.env.OMP_SQUAD_ATTENTION = "0";
		try {
			const store = new AttentionStore({ stateDir: dir() });
			expect(store.disabled()).toBe(false);
		} finally {
			if (originalNew === undefined) delete process.env.GLANCE_ATTENTION; else process.env.GLANCE_ATTENTION = originalNew;
			if (originalLegacy === undefined) delete process.env.OMP_SQUAD_ATTENTION; else process.env.OMP_SQUAD_ATTENTION = originalLegacy;
		}
	});
});

describe("record: 30s coalesce", () => {
	test("an identical {kind,repo,file,agentId,viewerId} replay within 30s is a no-op 200, not a second entry", () => {
		let now = 1_000_000;
		const store = new AttentionStore({ stateDir: dir(), now: () => now });
		const evt = { kind: "diff-viewed" as const, repo: "/r", file: "a.ts", agentId: "u1" };

		expect(store.record(evt, "actor")).toEqual({ ok: true });
		now += 5_000; // well within the 30s window
		expect(store.record(evt, "actor")).toEqual({ ok: true, reason: "coalesced" });
		expect(store.recentEvents().length).toBe(1); // no duplicate raw entry

		now += 30_000; // now 35s after the first — past the window
		expect(store.record(evt, "actor")).toEqual({ ok: true });
		expect(store.recentEvents().length).toBe(2);
	});

	test("coalescing is keyed on {kind,repo,file,agentId,viewerId} — a different file is a distinct event", () => {
		const now = 1_000_000;
		const store = new AttentionStore({ stateDir: dir(), now: () => now });
		store.record({ kind: "diff-viewed", repo: "/r", file: "a.ts" }, "actor");
		store.record({ kind: "diff-viewed", repo: "/r", file: "b.ts" }, "actor");
		expect(store.recentEvents().length).toBe(2);
	});
});

describe("record: per-actor rate limit", () => {
	test("beyond the configured events/min for one actor is rejected 429-shaped, other actors unaffected", () => {
		const now = 1_000_000;
		const store = new AttentionStore({ stateDir: dir(), now: () => now, rateLimitPerMin: 2 });
		expect(store.record({ kind: "diff-viewed", repo: "/r", file: "a.ts" }, "actorA")).toEqual({ ok: true });
		expect(store.record({ kind: "diff-viewed", repo: "/r", file: "b.ts" }, "actorA")).toEqual({ ok: true });
		expect(store.record({ kind: "diff-viewed", repo: "/r", file: "c.ts" }, "actorA")).toEqual({ ok: false, reason: "rate-limited" });
		// A different actor has its own bucket — never starved by actorA's burst.
		expect(store.record({ kind: "diff-viewed", repo: "/r", file: "d.ts" }, "actorB")).toEqual({ ok: true });
	});
});

describe("the compacted last-seen map: max-merge, never backward", () => {
	test("lastSeenAt is the max over every event, even when a later call reports an earlier time", () => {
		let now = 1_000;
		const store = new AttentionStore({ stateDir: dir(), now: () => now });
		store.record({ kind: "diff-viewed", repo: "/r", file: "a.ts" }, "actor");
		expect(store.lastSeen("/r", "a.ts")?.lastSeenAt).toBe(1_000);

		now = 5_000; // a genuinely later view moves it forward
		store.record({ kind: "pr-reviewed", repo: "/r", file: "a.ts" }, "actor");
		expect(store.lastSeen("/r", "a.ts")?.lastSeenAt).toBe(5_000);

		now = 2_000; // a stale/out-of-order replay must NEVER move it backward
		store.record({ kind: "surprise", repo: "/r", file: "a.ts" }, "actor");
		expect(store.lastSeen("/r", "a.ts")?.lastSeenAt).toBe(5_000);
	});

	test("per-viewer timestamps also max-merge independently", () => {
		let now = 1_000;
		const store = new AttentionStore({ stateDir: dir(), now: () => now });
		store.record({ kind: "diff-viewed", repo: "/r", file: "a.ts", viewerId: "db:alice" }, "alice");
		now = 500; // alice's own stale replay
		store.record({ kind: "diff-viewed", repo: "/r", file: "a.ts", viewerId: "db:alice" }, "alice");
		now = 2_000;
		store.record({ kind: "diff-viewed", repo: "/r", file: "a.ts", viewerId: "db:bob" }, "bob");

		const entry = store.lastSeen("/r", "a.ts");
		expect(entry?.lastSeenAt).toBe(2_000);
		expect(entry?.byViewer).toEqual({ "db:alice": 1_000, "db:bob": 2_000 });
	});

	test("answer-read/debrief-heard never touch the seen map — only diff-viewed/pr-reviewed/surprise do", () => {
		const store = new AttentionStore({ stateDir: dir(), now: () => 1_000 });
		store.record({ kind: "answer-read", repo: "/r", file: "a.ts", answerId: "ans1" }, "actor");
		store.record({ kind: "debrief-heard", repo: "/r", file: "a.ts" }, "actor");
		expect(store.lastSeen("/r", "a.ts")).toBeUndefined();
		expect(store.recentEvents().length).toBe(2); // still recorded to the raw feed
	});

	test("an event with no `file` never updates the map, whatever its kind", () => {
		const store = new AttentionStore({ stateDir: dir(), now: () => 1_000 });
		store.record({ kind: "diff-viewed", repo: "/r" }, "actor");
		expect(Object.keys(store.seenMapFor())).toEqual([]);
	});

	test("seenMapFor scopes by repo, normalized on both sides", () => {
		const store = new AttentionStore({ stateDir: dir(), now: () => 1_000 });
		store.record({ kind: "diff-viewed", repo: "/srv/app/", file: "a.ts" }, "actor"); // trailing slash
		store.record({ kind: "diff-viewed", repo: "/srv/other", file: "b.ts" }, "actor");

		expect(Object.keys(store.seenMapFor(["/srv/app"])).length).toBe(1); // no trailing slash on the query
		expect(Object.keys(store.seenMapFor()).length).toBe(2); // unrestricted
		expect(Object.keys(store.seenMapFor(["/nowhere"])).length).toBe(0);
	});

	/**
	 * Fail-closed regression: `undefined` (no `repos` argument at all) and an EXPLICIT empty array
	 * are different requests and must never collapse to the same "show everything" behavior. A
	 * caller whose actor-visible repo set is genuinely empty (comprehension concern 01's tenant
	 * scoping) passes `[]` on purpose — treating that the same as "unrestricted" would silently hand
	 * a viewer who can see no repo at all every OTHER tenant's seen map.
	 */
	test("an explicit empty repos array restricts to NOTHING — it is not the same as unrestricted", () => {
		const store = new AttentionStore({ stateDir: dir(), now: () => 1_000 });
		store.record({ kind: "diff-viewed", repo: "/srv/app", file: "a.ts" }, "actor");

		expect(store.seenMapFor(undefined)).not.toEqual({}); // undefined ⇒ unrestricted ⇒ has the entry
		expect(store.seenMapFor([])).toEqual({}); // [] ⇒ nothing, even though data exists
	});
});

describe("redactAttentionForActor: viewer-vs-admin acceptance test", () => {
	const events: AttentionEvent[] = [
		{ kind: "diff-viewed", repo: "/r", file: "a.ts", viewerId: "db:alice", at: 1 },
		{ kind: "diff-viewed", repo: "/r", file: "b.ts", viewerId: "db:bob", at: 2 },
		{ kind: "diff-viewed", repo: "/r", file: "c.ts", at: 3 }, // file mode: no viewer identity at all
	];

	test("a non-admin viewer sees their own viewerId intact and everyone else's stripped", () => {
		const out = redactAttentionForActor(events, { viewerId: "db:alice", isAdmin: false });
		expect(out.length).toBe(3); // no events dropped — only identity is redacted
		expect(out.find((e) => e.file === "a.ts")?.viewerId).toBe("db:alice"); // own
		expect(out.find((e) => e.file === "b.ts")?.viewerId).toBeUndefined(); // someone else's
		expect(out.find((e) => e.file === "c.ts")?.viewerId).toBeUndefined(); // already anonymous
	});

	test("an admin sees every event's real viewerId, unredacted", () => {
		const out = redactAttentionForActor(events, { viewerId: "db:alice", isAdmin: true });
		expect(out).toEqual(events);
	});

	test("a viewer with no identity (file mode) sees only anonymized aggregates", () => {
		const out = redactAttentionForActor(events, { isAdmin: false });
		expect(out.every((e) => e.viewerId === undefined)).toBe(true);
	});
});

describe("redactSeenMapForActor", () => {
	const map = {
		"/r\0a.ts": { lastSeenAt: 5, byViewer: { "db:alice": 5, "db:bob": 3 } },
		"/r\0b.ts": { lastSeenAt: 2 }, // no byViewer at all (file mode)
	};

	test("a non-admin keeps lastSeenAt (never identity-bearing) and only their own byViewer entry", () => {
		const out = redactSeenMapForActor(map, { viewerId: "db:bob", isAdmin: false });
		expect(out["/r\0a.ts"].lastSeenAt).toBe(5);
		expect(out["/r\0a.ts"].byViewer).toEqual({ "db:bob": 3 });
		expect(out["/r\0b.ts"]).toEqual({ lastSeenAt: 2 });
	});

	test("a non-admin with no viewerId sees no byViewer entries at all", () => {
		const out = redactSeenMapForActor(map, { isAdmin: false });
		expect(out["/r\0a.ts"].byViewer).toBeUndefined();
	});

	test("an admin sees the map unchanged", () => {
		expect(redactSeenMapForActor(map, { viewerId: "db:bob", isAdmin: true })).toEqual(map);
	});
});

describe("markUnitVisited/unitVisitedAt: t3-face concern 06's per-unit last-visited map", () => {
	test("file mode (no viewerId): every caller collapses onto the one lastSeenAt — the single-implicit-viewer rule", () => {
		const store = new AttentionStore({ stateDir: dir(), now: () => 1_000 });
		expect(store.unitVisitedAt("unit1", undefined)).toBeUndefined(); // absence ≠ seen
		store.markUnitVisited("unit1", undefined);
		expect(store.unitVisitedAt("unit1", undefined)).toBe(1_000);
	});

	/** The load-bearing acceptance test the concern's Verify section names: marking a unit seen by
	 *  one viewer must not resolve as seen for a DIFFERENT viewer — that's the entire reason this
	 *  map is per-viewer and daemon-side rather than a client-local store. */
	test("mark seen by viewer A leaves it unseen for viewer B until B visits it too", () => {
		const store = new AttentionStore({ stateDir: dir(), now: () => 5_000 });
		store.markUnitVisited("unit1", "db:alice");
		expect(store.unitVisitedAt("unit1", "db:alice")).toBe(5_000);
		expect(store.unitVisitedAt("unit1", "db:bob")).toBeUndefined(); // still unseen for bob

		store.markUnitVisited("unit1", "db:bob");
		expect(store.unitVisitedAt("unit1", "db:bob")).toBe(5_000);
		expect(store.unitVisitedAt("unit1", "db:alice")).toBe(5_000); // alice's own visit is untouched
	});

	test("two clients under the SAME viewer identity agree: a mark from one is visible to the other's next read", () => {
		let now = 1_000;
		const store = new AttentionStore({ stateDir: dir(), now: () => now });
		// "cockpit" marks it seen
		store.markUnitVisited("unit1", "db:alice");
		now = 1_500;
		// "a second poller" (same viewer) reads it independently — must see the SAME visited timestamp
		expect(store.unitVisitedAt("unit1", "db:alice")).toBe(1_000);
	});

	test("max-merge, never backward — a stale replay must not move the stamp earlier", () => {
		let now = 5_000;
		const store = new AttentionStore({ stateDir: dir(), now: () => now });
		store.markUnitVisited("unit1", "db:alice");
		now = 1_000; // an out-of-order replay
		store.markUnitVisited("unit1", "db:alice");
		expect(store.unitVisitedAt("unit1", "db:alice")).toBe(5_000);
	});

	test("visits to different units never cross-contaminate", () => {
		const store = new AttentionStore({ stateDir: dir(), now: () => 1_000 });
		store.markUnitVisited("unit1", "db:alice");
		expect(store.unitVisitedAt("unit2", "db:alice")).toBeUndefined();
	});

	test("survives a restart via its own durable unit-visited.json file", () => {
		const d = dir();
		const store = new AttentionStore({ stateDir: d, now: () => 42 });
		store.markUnitVisited("unit1", "db:alice");
		store.stop(); // forces the debounced write out synchronously

		const reloaded = new AttentionStore({ stateDir: d });
		expect(reloaded.unitVisitedAt("unit1", "db:alice")).toBe(42);
		expect(reloaded.unitVisitedAt("unit1", undefined)).toBe(42); // lastSeenAt survives too
	});

	test("a corrupt unit-visited.json on boot loads as empty, never throws", () => {
		const d = dir();
		writeFileSync(path.join(d, "unit-visited.json"), "{ not json");
		const store = new AttentionStore({ stateDir: d });
		expect(store.unitVisitedAt("unit1", undefined)).toBeUndefined();
	});

	test("markUnitVisited is never gated by the GLANCE_ATTENTION kill switch — it is a core ladder function, not file-viewing telemetry", () => {
		const original = process.env.GLANCE_ATTENTION;
		process.env.GLANCE_ATTENTION = "0";
		try {
			const store = new AttentionStore({ stateDir: dir(), now: () => 1_000 });
			expect(store.disabled()).toBe(true);
			store.markUnitVisited("unit1", "db:alice");
			expect(store.unitVisitedAt("unit1", "db:alice")).toBe(1_000);
		} finally {
			if (original === undefined) delete process.env.GLANCE_ATTENTION;
			else process.env.GLANCE_ATTENTION = original;
		}
	});

	// t3-face concern 06 MINOR finding (grok-4.5/codex cross-lineage review): the prior loader cast
	// the raw parsed object straight to `UnitVisitMap` with no shape narrowing at all. A malformed
	// stored value (valid JSON syntax, wrong shape) is a DIFFERENT failure mode than the "corrupt
	// JSON.parse" case above — it must be caught too, since a garbage `lastSeenAt` compares as
	// `NaN < completedAt` ⇒ `false` ⇒ the cascade read it as SEEN (`idle`), not unseen. This is the
	// exact fail-open codex confirmed against the live code before the fix.
	test("a corrupt (non-numeric) unit-visited entry reads as unseen (fail closed), not seen", () => {
		const d = dir();
		writeFileSync(path.join(d, "unit-visited.json"), JSON.stringify({ unit1: { lastSeenAt: "nope" } }));
		const store = new AttentionStore({ stateDir: d });
		expect(store.unitVisitedAt("unit1", undefined)).toBeUndefined();
		expect(store.unitVisitEntry("unit1")).toBeUndefined();
	});

	test("a corrupt per-viewer unit-visited stamp is dropped, but a valid sibling entry survives", () => {
		const d = dir();
		writeFileSync(path.join(d, "unit-visited.json"), JSON.stringify({ unit1: { lastSeenAt: 100, byViewer: { "db:alice": 100, "db:bob": "nope" } } }));
		const store = new AttentionStore({ stateDir: d });
		expect(store.unitVisitedAt("unit1", "db:alice")).toBe(100);
		expect(store.unitVisitedAt("unit1", "db:bob")).toBeUndefined();
	});

	test("a top-level JSON ARRAY (not an object) loads as empty, never leaks numeric indices as unit ids", () => {
		const d = dir();
		writeFileSync(path.join(d, "unit-visited.json"), JSON.stringify([{ lastSeenAt: 100 }]));
		const store = new AttentionStore({ stateDir: d });
		expect(store.unitVisitedAt("0", undefined)).toBeUndefined();
	});

	test("a wildly-future stamp (past the clock-skew bound) is dropped as corrupt, not trusted as 'always after'", () => {
		const d = dir();
		writeFileSync(path.join(d, "unit-visited.json"), JSON.stringify({ unit1: { lastSeenAt: 99_999_999_999_999 } }));
		const store = new AttentionStore({ stateDir: d });
		expect(store.unitVisitedAt("unit1", undefined)).toBeUndefined();
	});
});

describe("recordCompletion/completedAt: SquadManager's durable per-agent completion stamp (t3-face concern 06)", () => {
	test("absent until recorded — never coerced into a completion out of nothing", () => {
		const store = new AttentionStore({ stateDir: dir() });
		expect(store.completedAt("unit1")).toBeUndefined();
	});

	test("records and reads back the stamp", () => {
		const store = new AttentionStore({ stateDir: dir() });
		store.recordCompletion("unit1", 1_000);
		expect(store.completedAt("unit1")).toBe(1_000);
	});

	test("max-merge, never backward — an out-of-order re-record must not move the stamp earlier", () => {
		const store = new AttentionStore({ stateDir: dir() });
		store.recordCompletion("unit1", 5_000);
		store.recordCompletion("unit1", 1_000);
		expect(store.completedAt("unit1")).toBe(5_000);
	});

	test("survives a restart via its own durable unit-completed.json file — immune to the transitionLog ring's cap", () => {
		const d = dir();
		const store = new AttentionStore({ stateDir: d });
		store.recordCompletion("unit1", 42);
		store.stop(); // forces the debounced write out synchronously

		const reloaded = new AttentionStore({ stateDir: d });
		expect(reloaded.completedAt("unit1")).toBe(42);
	});

	test("a corrupt unit-completed.json entry is dropped, fail closed", () => {
		const d = dir();
		writeFileSync(path.join(d, "unit-completed.json"), JSON.stringify({ unit1: "nope" }));
		const store = new AttentionStore({ stateDir: d });
		expect(store.completedAt("unit1")).toBeUndefined();
	});
});

describe("stop() closes the store (t3-face concern 06 addition D): no write scheduled after can resurrect a timer", () => {
	test("a markUnitVisited call AFTER stop() never re-arms a write, and never corrupts the flushed file", () => {
		const d = dir();
		const store = new AttentionStore({ stateDir: d, now: () => 1_000 });
		store.markUnitVisited("unit1", "db:alice");
		store.stop(); // flushes, then closes

		// Simulates the manager-eviction race: a request lands in the gap between stop() and this
		// instance actually being discarded from the registry.
		store.markUnitVisited("unit1", "db:bob");
		// In-memory, the closed instance still reflects the late write (harmless — it's about to be
		// discarded) — but nothing was scheduled to persist it.
		expect(store.unitVisitedAt("unit1", "db:bob")).toBe(1_000);

		// A fresh instance for the same stateDir (standing in for the replacement manager) must see
		// exactly what was flushed at stop() — never a write the closed instance scheduled afterward.
		const reloaded = new AttentionStore({ stateDir: d });
		expect(reloaded.unitVisitedAt("unit1", "db:bob")).toBeUndefined();
		expect(reloaded.unitVisitedAt("unit1", "db:alice")).toBe(1_000);
	});
});

describe("stop()/flush()", () => {
	test("flush() persists the debounced seen-map write immediately, and a fresh store reloads it", () => {
		const d = dir();
		const store = new AttentionStore({ stateDir: d, now: () => 42 });
		store.record({ kind: "diff-viewed", repo: "/r", file: "a.ts" }, "actor");
		store.stop(); // forces the ≤2s debounce out synchronously

		const reloaded = new AttentionStore({ stateDir: d });
		expect(reloaded.lastSeen("/r", "a.ts")?.lastSeenAt).toBe(42);
	});

	test("a corrupt attention-seen.json on boot loads as empty, never throws", () => {
		const d = dir();
		writeFileSync(path.join(d, "attention-seen.json"), "{ not json");
		const store = new AttentionStore({ stateDir: d });
		expect(store.seenMapFor()).toEqual({});
	});
});

describe("surpriseCountsFor: concern-08 durable per-file surprise-tap count (comprehension concern 08)", () => {
	test("a surprise event increments the count for that (repo,file)", () => {
		const store = new AttentionStore({ stateDir: dir(), now: () => 1_000 });
		store.record({ kind: "surprise", repo: "/r", file: "a.ts" }, "actor");
		expect(store.surpriseCountsFor()).toEqual({ "/r\0a.ts": 1 });
	});

	test("repeated surprise taps (past the 30s coalesce window) accumulate", () => {
		let now = 1_000;
		const store = new AttentionStore({ stateDir: dir(), now: () => now });
		store.record({ kind: "surprise", repo: "/r", file: "a.ts" }, "actor");
		now += 31_000; // clear of the 30s coalesce window
		store.record({ kind: "surprise", repo: "/r", file: "a.ts" }, "actor");
		now += 31_000;
		store.record({ kind: "surprise", repo: "/r", file: "a.ts" }, "actor");
		expect(store.surpriseCountsFor()).toEqual({ "/r\0a.ts": 3 });
	});

	test("a coalesced replay within 30s does NOT double-increment the count", () => {
		let now = 1_000;
		const store = new AttentionStore({ stateDir: dir(), now: () => now });
		store.record({ kind: "surprise", repo: "/r", file: "a.ts", agentId: "u1" }, "actor");
		now += 5_000; // well inside the 30s coalesce window
		const result = store.record({ kind: "surprise", repo: "/r", file: "a.ts", agentId: "u1" }, "actor");
		expect(result).toEqual({ ok: true, reason: "coalesced" });
		expect(store.surpriseCountsFor()).toEqual({ "/r\0a.ts": 1 });
	});

	test("other event kinds never touch the surprise-count map", () => {
		const store = new AttentionStore({ stateDir: dir(), now: () => 1_000 });
		store.record({ kind: "diff-viewed", repo: "/r", file: "a.ts" }, "actor");
		store.record({ kind: "pr-reviewed", repo: "/r", file: "a.ts" }, "actor");
		expect(store.surpriseCountsFor()).toEqual({});
	});

	test("surpriseCountsFor scopes by repo, normalized, same fail-closed contract as seenMapFor", () => {
		const store = new AttentionStore({ stateDir: dir(), now: () => 1_000 });
		store.record({ kind: "surprise", repo: "/srv/app/", file: "a.ts" }, "actor"); // trailing slash
		store.record({ kind: "surprise", repo: "/srv/other", file: "b.ts" }, "actor");

		expect(store.surpriseCountsFor(["/srv/app"])).toEqual({ "/srv/app\0a.ts": 1 });
		expect(Object.keys(store.surpriseCountsFor()).length).toBe(2); // unrestricted
		expect(store.surpriseCountsFor([])).toEqual({}); // explicit empty ⇒ nothing, not unrestricted
	});

	test("the surprise count survives a restart via its own durable file — NOT the rotating raw feed", () => {
		const d = dir();
		const store = new AttentionStore({ stateDir: d, now: () => 42 });
		store.record({ kind: "surprise", repo: "/r", file: "a.ts" }, "actor");
		store.stop(); // forces the debounced write out synchronously

		const reloaded = new AttentionStore({ stateDir: d });
		expect(reloaded.surpriseCountsFor()).toEqual({ "/r\0a.ts": 1 });
	});

	test("a corrupt attention-surprise.json on boot loads as empty, never throws", () => {
		const d = dir();
		writeFileSync(path.join(d, "attention-surprise.json"), "{ not json");
		const store = new AttentionStore({ stateDir: d });
		expect(store.surpriseCountsFor()).toEqual({});
	});

	test("a non-numeric or negative stored count is dropped on load, never trusted verbatim", () => {
		const d = dir();
		writeFileSync(path.join(d, "attention-surprise.json"), JSON.stringify({ "/r\0a.ts": "not a number", "/r\0b.ts": -1, "/r\0c.ts": 3 }));
		const store = new AttentionStore({ stateDir: d });
		expect(store.surpriseCountsFor()).toEqual({ "/r\0c.ts": 3 });
	});

	test("a surprise event ALSO updates the seen map (it is itself a genuine 'looked at this' signal)", () => {
		const store = new AttentionStore({ stateDir: dir(), now: () => 1_000 });
		store.record({ kind: "surprise", repo: "/r", file: "a.ts" }, "actor");
		expect(store.lastSeen("/r", "a.ts")?.lastSeenAt).toBe(1_000);
		expect(store.surpriseCountsFor()).toEqual({ "/r\0a.ts": 1 });
	});
});

describe("surprise is cleared by a later genuine view (batch-3 review adjudication)", () => {
	test("tap → boost active; a later diff-viewed → boost gone; a fresh tap → boost active again", () => {
		let now = 1_000;
		const store = new AttentionStore({ stateDir: dir(), now: () => now });

		// tap → boost active
		store.record({ kind: "surprise", repo: "/r", file: "a.ts" }, "actor");
		expect(store.surpriseCountsFor()).toEqual({ "/r\0a.ts": 1 });

		// later diff-viewed → boost gone
		now += 60_000; // clear of the 30s coalesce window
		store.record({ kind: "diff-viewed", repo: "/r", file: "a.ts" }, "actor");
		expect(store.surpriseCountsFor()).toEqual({});

		// tap after that → boost again
		now += 60_000;
		store.record({ kind: "surprise", repo: "/r", file: "a.ts" }, "actor");
		expect(store.surpriseCountsFor()).toEqual({ "/r\0a.ts": 1 });
	});

	test("pr-reviewed also clears an existing surprise count, same as diff-viewed", () => {
		let now = 1_000;
		const store = new AttentionStore({ stateDir: dir(), now: () => now });
		store.record({ kind: "surprise", repo: "/r", file: "a.ts" }, "actor");
		expect(store.surpriseCountsFor()).toEqual({ "/r\0a.ts": 1 });

		now += 60_000;
		store.record({ kind: "pr-reviewed", repo: "/r", file: "a.ts" }, "actor");
		expect(store.surpriseCountsFor()).toEqual({});
	});

	test("repeated taps accumulate a count > 1, and a single later view still clears it entirely (reset, not decrement)", () => {
		let now = 1_000;
		const store = new AttentionStore({ stateDir: dir(), now: () => now });
		store.record({ kind: "surprise", repo: "/r", file: "a.ts" }, "actor");
		now += 60_000;
		store.record({ kind: "surprise", repo: "/r", file: "a.ts" }, "actor");
		now += 60_000;
		store.record({ kind: "surprise", repo: "/r", file: "a.ts" }, "actor");
		expect(store.surpriseCountsFor()).toEqual({ "/r\0a.ts": 3 });

		now += 60_000;
		store.record({ kind: "diff-viewed", repo: "/r", file: "a.ts" }, "actor");
		expect(store.surpriseCountsFor()).toEqual({});
	});

	test("a diff-viewed on a DIFFERENT file never clears another file's surprise count", () => {
		let now = 1_000;
		const store = new AttentionStore({ stateDir: dir(), now: () => now });
		store.record({ kind: "surprise", repo: "/r", file: "a.ts" }, "actor");
		now += 60_000;
		store.record({ kind: "diff-viewed", repo: "/r", file: "b.ts" }, "actor");
		expect(store.surpriseCountsFor()).toEqual({ "/r\0a.ts": 1 });
	});

	test("diff-viewed with no prior surprise count is a harmless no-op (no dirty write, nothing to clear)", () => {
		const store = new AttentionStore({ stateDir: dir(), now: () => 1_000 });
		expect(store.record({ kind: "diff-viewed", repo: "/r", file: "a.ts" }, "actor")).toEqual({ ok: true });
		expect(store.surpriseCountsFor()).toEqual({});
	});

	test("the reset survives a restart via the durable surprise-count file", () => {
		const d = dir();
		let now = 1_000;
		const store = new AttentionStore({ stateDir: d, now: () => now });
		store.record({ kind: "surprise", repo: "/r", file: "a.ts" }, "actor");
		now += 60_000;
		store.record({ kind: "diff-viewed", repo: "/r", file: "a.ts" }, "actor");
		store.stop(); // forces the debounced write out synchronously

		const reloaded = new AttentionStore({ stateDir: d });
		expect(reloaded.surpriseCountsFor()).toEqual({});
	});
});
