/**
 * trace-cache.test.ts — server.ts's per-runId trace cache in front of manager.trace()
 * (concern 04, inspectable-topology). Exercises `tracePayload` directly (exported for
 * testability) rather than through HTTP, so TTL expiry can be driven with a fake clock
 * instead of a real 30s wait.
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendReceipt } from "../src/receipts.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { tracePayload, traceCache, sweepExpiredTraceCache, TRACE_CACHE_TTL_MS, TRACE_CACHE_MAX } from "../src/server.ts";
import type { RunReceipt } from "../src/types.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function makeManager(): Promise<{ mgr: SquadManager; dir: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trace-cache-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	return { mgr: new SquadManager({ stateDir: dir }), dir };
}

/** Wraps SquadManager.trace with a call counter, without touching its behavior. */
function spyOnTrace(mgr: SquadManager): { calls: () => number } {
	const original = mgr.trace.bind(mgr);
	let count = 0;
	mgr.trace = (async (id: string) => {
		count += 1;
		return original(id);
	}) as SquadManager["trace"];
	return { calls: () => count };
}

test("finalized run: two tracePayload calls return the identical cached response object, manager.trace called once", async () => {
	const { mgr, dir } = await makeManager();
	const receipt: RunReceipt = { agentId: "a1", name: "alpha", repo: "/repo", runId: "r1", startedAt: 1, endedAt: 2, durationMs: 1, status: "idle", toolCalls: 1, toolTally: {}, filesTouched: [], traceId: "feat:cache-finalized-1", featureId: "cache-finalized-1" };
	await appendReceipt(dir, receipt);
	const spy = spyOnTrace(mgr);

	const first = await tracePayload(mgr, "feat:cache-finalized-1");
	const second = await tracePayload(mgr, "feat:cache-finalized-1");

	expect(second).toBe(first); // reference equality — served from cache, not recomputed
	expect(spy.calls()).toBe(1);
});

test("in-flight run (a receipt with no endedAt) bypasses the cache on every call", async () => {
	const { mgr, dir } = await makeManager();
	const receipt: RunReceipt = { agentId: "a1", name: "alpha", repo: "/repo", runId: "r1", startedAt: 1, status: "working", toolCalls: 0, toolTally: {}, filesTouched: [], traceId: "feat:cache-inflight-1", featureId: "cache-inflight-1" };
	await appendReceipt(dir, receipt);
	const spy = spyOnTrace(mgr);

	const first = await tracePayload(mgr, "feat:cache-inflight-1");
	const second = await tracePayload(mgr, "feat:cache-inflight-1");

	expect(spy.calls()).toBe(2); // never cached — every call re-scans
	expect(traceCache.has("feat:cache-inflight-1")).toBe(false);
	expect(first).not.toBe(second); // distinct objects each call
});

test("a cached entry expires after TRACE_CACHE_TTL_MS", async () => {
	const { mgr, dir } = await makeManager();
	const receipt: RunReceipt = { agentId: "a1", name: "alpha", repo: "/repo", runId: "r1", startedAt: 1, endedAt: 2, durationMs: 1, status: "idle", toolCalls: 1, toolTally: {}, filesTouched: [], traceId: "feat:cache-ttl-1", featureId: "cache-ttl-1" };
	await appendReceipt(dir, receipt);
	const spy = spyOnTrace(mgr);

	const realNow = Date.now;
	let fakeNow = realNow();
	Date.now = () => fakeNow;
	cleanups.push(() => { Date.now = realNow; });

	const first = await tracePayload(mgr, "feat:cache-ttl-1");
	expect(spy.calls()).toBe(1);

	fakeNow += TRACE_CACHE_TTL_MS + 1; // past the TTL
	const second = await tracePayload(mgr, "feat:cache-ttl-1");

	expect(spy.calls()).toBe(2); // recomputed — the old entry had expired
	expect(second).not.toBe(first);
});

test("sweepExpiredTraceCache evicts EVERY TTL-expired entry, not just an id someone happens to re-request", () => {
	// Regression guard for the unbounded-growth finding: before the sweep, an expired entry only got
	// evicted on a same-id re-request after its TTL — a never-repeated id just sat in the map forever.
	// This drives the sweep directly against hand-seeded entries so it doesn't depend on tracePayload's
	// own finalized-response shape.
	const now = Date.now();
	traceCache.set("sweep-old-1", { at: now - TRACE_CACHE_TTL_MS - 1, response: {} as never });
	traceCache.set("sweep-old-2", { at: now - TRACE_CACHE_TTL_MS - 1, response: {} as never });
	traceCache.set("sweep-fresh-1", { at: now, response: {} as never });

	sweepExpiredTraceCache(now);

	expect(traceCache.has("sweep-old-1")).toBe(false);
	expect(traceCache.has("sweep-old-2")).toBe(false);
	expect(traceCache.has("sweep-fresh-1")).toBe(true);
	traceCache.delete("sweep-fresh-1"); // leave the shared module-level cache clean for other tests
});

test("distinct never-repeated finalized traces never grow the cache past TRACE_CACHE_MAX — FIFO evicts the oldest", async () => {
	const { mgr, dir } = await makeManager();
	const n = TRACE_CACHE_MAX + 5;
	for (let i = 0; i < n; i++) {
		const featureId = `cache-cap-${i}`;
		const receipt: RunReceipt = { agentId: "a1", name: "alpha", repo: "/repo", runId: `r${i}`, startedAt: 1, endedAt: 2, durationMs: 1, status: "idle", toolCalls: 1, toolTally: {}, filesTouched: [], traceId: `feat:${featureId}`, featureId };
		await appendReceipt(dir, receipt);
		await tracePayload(mgr, `feat:${featureId}`);
	}

	expect(traceCache.size).toBeLessThanOrEqual(TRACE_CACHE_MAX);
	// FIFO: the very first inserted entries were evicted to make room for later ones.
	expect(traceCache.has("feat:cache-cap-0")).toBe(false);
	expect(traceCache.has(`feat:cache-cap-${n - 1}`)).toBe(true); // the most recent survives
});
