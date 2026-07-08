/**
 * gate-semaphore — a process-wide concurrency limiter for EXPENSIVE verify/gate commands.
 *
 * INCIDENT: fresh factory units were dying at the workflow escalate visit-cap. The dispatcher
 * runs up to OMP_SQUAD_MAX_WIP concurrent units, and each unit's workflow (`implement → verify →
 * fixup → escalate`) runs the FULL project test suite (`bun run check && bun run test`) inside its
 * own worktree, on the SAME host, at the SAME time. Under 2-3x concurrent full suites on a modest
 * host, spawn-heavy tests (subprocess-spawning tests such as harness-scorecard/codex-ingest, which
 * shell out to `git`) flake under process/fd/scheduler pressure — they fail in the full suite under
 * load but pass in isolation. A red gate routes to fixup, fixup's retry ALSO races the same
 * contention, stays red, and the run escalates and burns its visit cap on host noise rather than a
 * real defect.
 *
 * FIX: serialize expensive gate commands host-wide behind a shared semaphore, so concurrent units'
 * full-suite runs queue instead of thrash each other. This is a MODULE-LEVEL singleton (mirrors
 * `repoLands` in land.ts, which serializes lands the same way) — every manager in this process
 * (root + org managers) imports the same module instance, so the limit is enforced across the
 * WHOLE process, not per-repo. Concurrency defaults to 1 (fully serialized) and is tunable via
 * `OMP_SQUAD_GATE_CONCURRENCY` for hosts with more headroom.
 *
 * Waiting for a slot never touches the workflow engine's visit-cap math: the engine increments a
 * node's visit count once, BEFORE calling into the executor (see engine.ts `run()`), so a long wait
 * inside the executor's `runCommand` never causes an extra visit or a premature escalate — it just
 * delays when the (single) counted attempt actually executes. See gate-semaphore.test.ts for the
 * end-to-end proof.
 */

import { envInt } from "./config.ts";

/** Env-tunable concurrency for gated commands. Read lazily (like envInt itself) so tests can flip it per-case. */
export function gateConcurrency(): number {
	return Math.max(1, envInt("OMP_SQUAD_GATE_CONCURRENCY", 1));
}

/** How long a caller must wait before we consider the queue worth logging about. */
export const GATE_WARN_AFTER_MS = 30_000;

/**
 * A standard counting semaphore. `release()` hands a freed slot DIRECTLY to the next queued waiter
 * (rather than incrementing `available` and letting the waiter re-acquire), so there is no race
 * window where a concurrent `acquire()` could steal a slot that was already promised to someone
 * queued ahead of it — JS's single-threaded run-to-completion semantics make the hand-off atomic.
 */
export class GateSemaphore {
	private available: number;
	private readonly queue: Array<() => void> = [];

	constructor(capacity: number) {
		this.available = Math.max(1, capacity);
	}

	/** Number of callers currently queued (not yet holding a slot). */
	get queueDepth(): number {
		return this.queue.length;
	}

	/**
	 * Acquire a slot, resolving a release function once one is free. If the wait exceeds
	 * `warnAfterMs`, `onWait(elapsedMs, aheadInQueue)` fires once (best-effort logging — never
	 * blocks or throws into the caller). The release function is idempotent-safe to call exactly
	 * once; call it from a `finally` so a thrown command still frees the slot (no deadlock).
	 */
	async acquire(onWait?: (elapsedMs: number, aheadInQueue: number) => void, warnAfterMs = GATE_WARN_AFTER_MS): Promise<() => void> {
		if (this.available > 0) {
			this.available--;
			return () => this.release();
		}
		const aheadInQueue = this.queue.length + 1; // this waiter counts as 1 of the N now queued
		const start = Date.now();
		const timer = onWait
			? setTimeout(() => {
					try {
						onWait(Date.now() - start, aheadInQueue);
					} catch {
						// best-effort: a logging callback must never break the gate
					}
				}, warnAfterMs)
			: undefined;
		try {
			await new Promise<void>((resolve) => {
				this.queue.push(resolve);
			});
		} finally {
			if (timer) clearTimeout(timer);
		}
		return () => this.release();
	}

	private release(): void {
		const next = this.queue.shift();
		if (next) {
			next(); // hand the freed slot straight to the next waiter — `available` is unchanged
		} else {
			this.available++;
		}
	}
}

// The process-wide singleton every manager (root + org) shares, mirroring `repoLands` in land.ts.
// Capacity is fixed at construction; `OMP_SQUAD_GATE_CONCURRENCY` is read once, at first use, since a
// semaphore's capacity can't safely change while callers hold slots against the old capacity. Tests
// that need a specific concurrency should construct their own `GateSemaphore` instance directly
// rather than relying on env + the shared singleton.
let singleton: GateSemaphore | undefined;

/** The shared, process-wide gate semaphore. Lazily constructed on first use from `OMP_SQUAD_GATE_CONCURRENCY`. */
export function sharedGateSemaphore(): GateSemaphore {
	if (!singleton) singleton = new GateSemaphore(gateConcurrency());
	return singleton;
}

/** Test-only: drop the singleton so the next `sharedGateSemaphore()` call re-reads the env var. */
export function resetSharedGateSemaphoreForTests(): void {
	singleton = undefined;
}
