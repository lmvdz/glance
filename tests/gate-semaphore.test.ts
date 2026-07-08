/**
 * gate-semaphore — unit coverage for the concurrency limiter that serializes expensive verify/gate
 * commands across concurrent units (the fix for the "concurrent full-suite verify commands flake
 * each other under host load, burning the escalate visit-cap" incident).
 *
 * Covers: serialization (two slow "gates" run sequentially, never overlapping), env-tunable
 * capacity, the >30s queued-wait log callback, and release-on-throw (no deadlock when a gated
 * command rejects).
 */

import { afterEach, expect, test } from "bun:test";
import { GateSemaphore, gateConcurrency, resetSharedGateSemaphoreForTests, sharedGateSemaphore } from "../src/gate-semaphore.ts";

afterEach(() => {
	delete process.env.OMP_SQUAD_GATE_CONCURRENCY;
	resetSharedGateSemaphoreForTests();
});

test("concurrency 1: two acquirers never hold a slot at the same time — the second waits for the first's release", async () => {
	const sem = new GateSemaphore(1);
	const order: string[] = [];
	let releaseFirst: (() => void) | undefined;

	const first = (async () => {
		const release = await sem.acquire();
		order.push("first-acquired");
		await new Promise<void>((resolve) => {
			releaseFirst = () => {
				resolve();
			};
		});
		order.push("first-releasing");
		release();
	})();

	// Give `first` a tick to actually acquire before starting `second`.
	await new Promise((r) => setTimeout(r, 10));
	expect(order).toEqual(["first-acquired"]);

	const second = (async () => {
		const release = await sem.acquire(); // must block until first releases
		order.push("second-acquired");
		release();
	})();

	// Second should still be queued — give it a moment and confirm it hasn't jumped the queue.
	await new Promise((r) => setTimeout(r, 10));
	expect(order).toEqual(["first-acquired"]);
	expect(sem.queueDepth).toBe(1);

	releaseFirst?.();
	await first;
	await second;

	expect(order).toEqual(["first-acquired", "first-releasing", "second-acquired"]);
});

test("concurrency N: N acquirers run concurrently, the (N+1)th queues", async () => {
	const sem = new GateSemaphore(2);
	const active: string[] = [];
	const maxActiveSeen: number[] = [];

	const hold = async (label: string, holdMs: number) => {
		const release = await sem.acquire();
		active.push(label);
		maxActiveSeen.push(active.length);
		await new Promise((r) => setTimeout(r, holdMs));
		active.splice(active.indexOf(label), 1);
		release();
	};

	await Promise.all([hold("a", 40), hold("b", 40), hold("c", 40)]);
	expect(Math.max(...maxActiveSeen)).toBeLessThanOrEqual(2); // never more than capacity concurrently
	expect(maxActiveSeen).toContain(2); // and it DID reach capacity (proves real concurrency, not accidental serialization)
});

test("no deadlock on throw: a rejecting gated command still releases its slot for the next queued caller", async () => {
	const sem = new GateSemaphore(1);

	async function runGated(fn: () => Promise<void>): Promise<{ threw: boolean }> {
		const release = await sem.acquire();
		try {
			await fn();
			return { threw: false };
		} catch {
			return { threw: true };
		} finally {
			release();
		}
	}

	const first = runGated(async () => {
		await new Promise((r) => setTimeout(r, 20));
		throw new Error("gate command exploded");
	});

	// Queue a second caller behind the first WHILE the first is still "running" (about to throw).
	await new Promise((r) => setTimeout(r, 5));
	const second = runGated(async () => {
		/* succeeds */
	});

	const [r1, r2] = await Promise.all([first, second]);
	expect(r1.threw).toBe(true);
	expect(r2.threw).toBe(false); // second was NOT deadlocked behind the first's slot
});

test("onWait fires once, after warnAfterMs, with elapsed time and queue depth — and never blocks acquisition", async () => {
	const sem = new GateSemaphore(1);
	const release1 = await sem.acquire();

	const waits: Array<{ elapsedMs: number; aheadInQueue: number }> = [];
	const acquire2 = sem.acquire((elapsedMs, aheadInQueue) => waits.push({ elapsedMs, aheadInQueue }), 25);

	await new Promise((r) => setTimeout(r, 60)); // well past warnAfterMs=25ms while still queued
	expect(waits.length).toBe(1);
	expect(waits[0]!.aheadInQueue).toBe(1);
	expect(waits[0]!.elapsedMs).toBeGreaterThanOrEqual(20);

	release1();
	const release2 = await acquire2; // still resolves fine after the warning fired
	release2();
});

test("onWait never fires when the slot is free immediately", async () => {
	const sem = new GateSemaphore(1);
	let fired = false;
	const release = await sem.acquire(() => {
		fired = true;
	}, 5);
	await new Promise((r) => setTimeout(r, 20));
	expect(fired).toBe(false);
	release();
});

test("gateConcurrency() reads OMP_SQUAD_GATE_CONCURRENCY, default 1, floors at 1", () => {
	delete process.env.OMP_SQUAD_GATE_CONCURRENCY;
	expect(gateConcurrency()).toBe(1);

	process.env.OMP_SQUAD_GATE_CONCURRENCY = "4";
	expect(gateConcurrency()).toBe(4);

	process.env.OMP_SQUAD_GATE_CONCURRENCY = "0"; // floors at 1 — a gate of 0 would deadlock everyone forever
	expect(gateConcurrency()).toBe(1);

	process.env.OMP_SQUAD_GATE_CONCURRENCY = "-3";
	expect(gateConcurrency()).toBe(1);
});

test("sharedGateSemaphore() is a process-wide singleton honoring the env var read at first use", async () => {
	process.env.OMP_SQUAD_GATE_CONCURRENCY = "2";
	resetSharedGateSemaphoreForTests();
	const a = sharedGateSemaphore();
	const b = sharedGateSemaphore();
	expect(a).toBe(b); // same instance — every manager (root + org) importing this module shares it

	// Prove the capacity really is 2: two acquires should both succeed without queuing.
	const r1 = await a.acquire();
	const r2 = await a.acquire();
	expect(a.queueDepth).toBe(0);
	r1();
	r2();
});
