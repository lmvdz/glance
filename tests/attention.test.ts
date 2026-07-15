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
