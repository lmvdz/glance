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
import { tracePayload, traceCache, TRACE_CACHE_TTL_MS } from "../src/server.ts";
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
