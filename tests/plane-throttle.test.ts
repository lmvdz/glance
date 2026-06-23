/**
 * plane-throttle — the single rate-limited + cached chokepoint for all Plane API access.
 *
 * Covers: makeCache single-flight (concurrent get()s share one fn call), TTL expiry, shouldCache gating
 * (failed reads aren't cached), clear(); and throttledFetch 429 retry + network-error→null + passthrough.
 */

import { afterEach, expect, test } from "bun:test";
import { makeCache, throttledFetch } from "../src/plane-throttle.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const realFetch = globalThis.fetch;
const savedInterval = process.env.OMP_SQUAD_PLANE_MIN_INTERVAL_MS;
afterEach(() => {
	globalThis.fetch = realFetch;
	if (savedInterval === undefined) delete process.env.OMP_SQUAD_PLANE_MIN_INTERVAL_MS;
	else process.env.OMP_SQUAD_PLANE_MIN_INTERVAL_MS = savedInterval;
});

// ── makeCache ────────────────────────────────────────────────────────────────

test("makeCache: concurrent get()s for one key share a single fn() call (single-flight)", async () => {
	const c = makeCache<number>();
	let n = 0;
	const fn = async () => { n++; await sleep(20); return n; };
	const [a, b] = await Promise.all([c.get("k", 1000, fn), c.get("k", 1000, fn)]);
	expect(n).toBe(1);
	expect(a).toBe(b);
});

test("makeCache: result is served from cache within TTL, refetched after it", async () => {
	const c = makeCache<number>();
	let n = 0;
	const fn = async () => { n++; return n; };
	expect(await c.get("k", 40, fn)).toBe(1);
	expect(await c.get("k", 40, fn)).toBe(1); // within TTL ⇒ cached
	await sleep(55);
	expect(await c.get("k", 40, fn)).toBe(2); // TTL elapsed ⇒ refetched
});

test("makeCache: shouldCache=false results are never stored (failed reads retry)", async () => {
	const c = makeCache<number | null>();
	let n = 0;
	const fn = async () => { n++; return null; }; // simulate a failed read
	await c.get("k", 1000, fn, (v) => v !== null);
	await c.get("k", 1000, fn, (v) => v !== null);
	expect(n).toBe(2); // not cached ⇒ called again
});

test("makeCache: clear() drops the cache", async () => {
	const c = makeCache<number>();
	let n = 0;
	const fn = async () => { n++; return n; };
	await c.get("k", 10000, fn);
	c.clear();
	await c.get("k", 10000, fn);
	expect(n).toBe(2);
});

// ── throttledFetch ───────────────────────────────────────────────────────────

function fakeRes(status: number, retryAfter?: string): Response {
	return { status, ok: status >= 200 && status < 300, headers: { get: (h: string) => (h.toLowerCase() === "retry-after" ? (retryAfter ?? null) : null) } } as unknown as Response;
}

test("throttledFetch retries a 429 then returns the eventual success", async () => {
	process.env.OMP_SQUAD_PLANE_MIN_INTERVAL_MS = "5";
	let calls = 0;
	globalThis.fetch = (async () => {
		calls++;
		return calls === 1 ? fakeRes(429) : fakeRes(200);
	}) as typeof fetch;
	const res = await throttledFetch("https://x/y");
	expect(calls).toBe(2);
	expect(res?.status).toBe(200);
});

test("throttledFetch returns null on a network error (never throws)", async () => {
	process.env.OMP_SQUAD_PLANE_MIN_INTERVAL_MS = "5";
	globalThis.fetch = (async () => { throw new Error("ECONNRESET"); }) as typeof fetch;
	expect(await throttledFetch("https://x/y")).toBeNull();
});

test("throttledFetch passes a non-429 response straight through", async () => {
	process.env.OMP_SQUAD_PLANE_MIN_INTERVAL_MS = "5";
	let calls = 0;
	globalThis.fetch = (async () => { calls++; return fakeRes(404); }) as typeof fetch;
	const res = await throttledFetch("https://x/y");
	expect(calls).toBe(1);
	expect(res?.status).toBe(404);
});
