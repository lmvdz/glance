/**
 * plane-throttle — the single rate-limited + cached chokepoint for all Plane API access.
 *
 * Covers: makeCache single-flight (concurrent get()s share one fn call), TTL expiry, shouldCache gating
 * (failed reads aren't cached), clear(); and throttledFetch 429 retry + network-error→null + passthrough.
 */

import { afterEach, expect, test } from "bun:test";
import { makeCache, throttledFetch } from "../src/plane-throttle.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const savedInterval = process.env.OMP_SQUAD_PLANE_MIN_INTERVAL_MS;
const savedBackoff = process.env.OMP_SQUAD_PLANE_BACKOFF_BASE_MS;
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
	if (savedInterval === undefined) delete process.env.OMP_SQUAD_PLANE_MIN_INTERVAL_MS;
	else process.env.OMP_SQUAD_PLANE_MIN_INTERVAL_MS = savedInterval;
	if (savedBackoff === undefined) delete process.env.OMP_SQUAD_PLANE_BACKOFF_BASE_MS;
	else process.env.OMP_SQUAD_PLANE_BACKOFF_BASE_MS = savedBackoff;
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

function serveStatuses(statuses: number[]): { url: string; calls: () => number } {
	let calls = 0;
	const server = Bun.serve({
		port: 0,
		fetch: () => new Response("", { status: statuses[Math.min(calls++, statuses.length - 1)] }),
	});
	servers.push(server);
	return { url: `http://127.0.0.1:${server.port}/plane`, calls: () => calls };
}

test("throttledFetch retries a 429 then returns the eventual success", async () => {
	process.env.OMP_SQUAD_PLANE_MIN_INTERVAL_MS = "5";
	process.env.OMP_SQUAD_PLANE_BACKOFF_BASE_MS = "5"; // keep the 429 retry fast (real default is 500ms)
	const { url, calls } = serveStatuses([429, 200]);
	const res = await throttledFetch(url);
	expect(calls()).toBe(2);
	expect(res?.status).toBe(200);
});

test("throttledFetch returns null on a network error (never throws)", async () => {
	process.env.OMP_SQUAD_PLANE_MIN_INTERVAL_MS = "5";
	process.env.OMP_SQUAD_PLANE_BACKOFF_BASE_MS = "5";
	const probe = Bun.serve({ port: 0, fetch: () => new Response("closed") });
	const url = `http://127.0.0.1:${probe.port}/closed`;
	probe.stop(true);
	expect(await throttledFetch(url)).toBeNull();
});

test("throttledFetch passes a non-429 response straight through", async () => {
	process.env.OMP_SQUAD_PLANE_MIN_INTERVAL_MS = "5";
	const { url, calls } = serveStatuses([404]);
	const res = await throttledFetch(url);
	expect(calls()).toBe(1);
	expect(res?.status).toBe(404);
});
