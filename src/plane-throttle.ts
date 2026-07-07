/**
 * Plane API throttle — the single rate-limited chokepoint every plane.ts request goes through.
 *
 * Plane cloud rate-limits per workspace token, and omp-squad has many in-process callers sharing that
 * one token (dispatcher poll, observer poll + filing, worktree reaper, scout). Independently they burst
 * past the limit and 429 each other — and any external caller on the same token (the Plane MCP, other
 * agent sessions) too. `throttledFetch` serializes ALL Plane requests through one global min-interval
 * queue with central 429/Retry-After backoff; `makeCache` gives reads (listPlaneIssues) a short-TTL
 * single-flight cache so concurrent polls collapse to one call. Together they keep the shared token
 * under budget, which is what frees it for everyone else.
 *
 * ponytail: a process-local limiter (serialized, min-spaced). Ceiling — it only coordinates THIS
 * process; a second daemon/MCP on the same token still competes. Upgrade path: the standalone Plane
 * gateway all processes call (docs/plane-gateway.md).
 */

import { envInt } from "./config.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const MAX_429_RETRIES = 4;

/** Backoff for a 429: honour Retry-After (seconds) when present, else exponential from a configurable
 * base (OMP_SQUAD_PLANE_BACKOFF_BASE_MS, default 500). Capped at 5s. */
function retryAfterMs(res: Response, attempt: number): number {
	const ra = Number(res.headers.get("retry-after"));
	if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 5000);
	const base = envInt("OMP_SQUAD_PLANE_BACKOFF_BASE_MS", 500);
	return Math.min(base * 2 ** attempt, 5000);
}

// Global serialization: every request chains onto the previous, then waits out the min interval — so
// the process never bursts. Module-level by design (one limiter per process, shared by all callers).
let chain: Promise<unknown> = Promise.resolve();
let lastAt = 0;

/**
 * Rate-limited fetch: serialized globally with a min interval between requests (OMP_SQUAD_PLANE_MIN_INTERVAL_MS,
 * default 500ms), retrying 429s with Retry-After/backoff. Returns the Response, or null on a network
 * error / exhausted retries (callers already treat null as failure). NEVER throws.
 */
export async function throttledFetch(url: string, init?: RequestInit): Promise<Response | null> {
	const run = chain.then(async () => {
		const interval = envInt("OMP_SQUAD_PLANE_MIN_INTERVAL_MS", 500);
		for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
			const wait = lastAt + interval - Date.now();
			if (wait > 0) await sleep(wait);
			const res = await fetch(url, init).catch(() => null);
			lastAt = Date.now();
			if (!res) return null; // network error
			if (res.status !== 429) return res;
			if (attempt === MAX_429_RETRIES) return res; // exhausted — hand back the 429 for the caller to see
			await sleep(retryAfterMs(res, attempt));
			lastAt = Date.now();
		}
		return null;
	});
	// Keep the chain alive regardless of this request's outcome so the next request still serializes.
	chain = run.then(() => {}, () => {});
	return run;
}

/**
 * Generic single-flight TTL cache. Concurrent get()s for the same key share ONE fn() call; its result
 * is cached for ttlMs. `shouldCache` gates whether a result is stored (default: always) — e.g. skip
 * caching a null/failed read so the next call retries instead of serving a stale failure.
 */
export function makeCache<T>() {
	const store = new Map<string, { at: number; val: T }>();
	const inflight = new Map<string, Promise<T>>();
	return {
		async get(key: string, ttlMs: number, fn: () => Promise<T>, shouldCache: (v: T) => boolean = () => true): Promise<T> {
			const hit = store.get(key);
			if (hit && Date.now() - hit.at < ttlMs) return hit.val;
			const inf = inflight.get(key);
			if (inf) return inf;
			const p = (async () => {
				try {
					const val = await fn();
					if (shouldCache(val)) store.set(key, { at: Date.now(), val });
					return val;
				} finally {
					inflight.delete(key);
				}
			})();
			inflight.set(key, p);
			return p;
		},
		clear(): void {
			store.clear();
		},
	};
}
