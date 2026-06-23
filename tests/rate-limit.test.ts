/**
 * RateLimitGate — pause auto-dispatch while the model subscription is rate-limited.
 *
 * Deterministic: the clock is injected, so cooldown windows are pinned without sleeping. Covers the
 * usage-limit classifier, the cooldown math (hint vs floor vs default vs ceiling), self-clearing on
 * elapse, and the dispatcher honouring `paused()` (spawns nothing, then resumes once the cap clears).
 */

import { expect, test } from "bun:test";
import { isUsageLimit, RateLimitGate } from "../src/rate-limit.ts";
import { Dispatcher, type DispatchDeps } from "../src/dispatch.ts";
import type { IssueRef } from "../src/types.ts";

test("isUsageLimit matches rate-limit / usage-cap wording, not transient errors", () => {
	expect(isUsageLimit("429 Too Many Requests")).toBe(true);
	expect(isUsageLimit("You have hit your weekly limit")).toBe(true);
	expect(isUsageLimit("rate limit exceeded, resets at 5pm")).toBe(true);
	expect(isUsageLimit("usage limit reached")).toBe(true);
	// Non-usage-limit transients must NOT pause dispatch.
	expect(isUsageLimit("socket hang up")).toBe(false);
	expect(isUsageLimit("overloaded_error")).toBe(false);
	expect(isUsageLimit(undefined)).toBe(false);
	expect(isUsageLimit(12345)).toBe(false);
});

test("note pauses for the retry hint, clamped to the floor and ceiling", () => {
	let now = 1_000_000;
	const gate = new RateLimitGate(() => now);
	expect(gate.paused()).toBe(false);

	// A generous hint within bounds is honoured verbatim.
	expect(gate.note("rate limit", 10 * 60_000)).toBe(true);
	expect(gate.until).toBe(now + 10 * 60_000);
	expect(gate.paused()).toBe(true);

	// Self-clears once the window elapses.
	now += 10 * 60_000;
	expect(gate.paused()).toBe(false);

	// A tiny hint is floored (don't re-spawn straight back into the cap).
	now += 1;
	gate.note("429", 1_000);
	expect(gate.until).toBe(now + 60_000);

	// A bogus huge hint is capped at the 6h ceiling.
	now += 60_000;
	gate.note("usage limit", 999 * 60 * 60_000);
	expect(gate.until).toBe(now + 6 * 60 * 60_000);
});

test("note ignores non-usage-limit retries (transient overload doesn't pause)", () => {
	const gate = new RateLimitGate(() => 0);
	expect(gate.note("socket hang up", 8_000)).toBe(false);
	expect(gate.paused()).toBe(false);
	expect(gate.until).toBe(0);
});

test("note extends an active cooldown, never shortens it", () => {
	let now = 0;
	const gate = new RateLimitGate(() => now);
	gate.note("rate limit", 10 * 60_000); // until = 600000
	now = 1_000;
	gate.note("429", 1_000); // floor 60s → until 61000, shorter than 600000
	expect(gate.until).toBe(10 * 60_000); // unchanged — longest window wins
});

test("dispatcher: spawns nothing while paused, resumes once the cap clears", async () => {
	let paused = true;
	const spawned: string[] = [];
	const logs: string[] = [];
	const deps: DispatchDeps = {
		repos: () => ["/r"],
		listIssues: async (): Promise<IssueRef[]> => [{ id: "A", name: "issue A" }],
		spawn: async (_repo, iss) => {
			spawned.push(iss.id);
		},
		claimed: () => new Set(),
		activeCount: () => 0,
		log: (m) => logs.push(m),
		maxActive: 10,
		paused: () => paused,
	};
	const d = new Dispatcher(deps);

	expect(await d.tick()).toBe(0); // rate-limited → no spawn
	expect(spawned).toEqual([]);
	expect(logs.some((m) => m.includes("paused"))).toBe(true);

	expect(await d.tick()).toBe(0); // still paused → no duplicate "paused" log
	expect(logs.filter((m) => m.includes("paused")).length).toBe(1);

	paused = false;
	expect(await d.tick()).toBe(1); // cap cleared → dispatch resumes
	expect(spawned).toEqual(["A"]);
	expect(logs.some((m) => m.includes("resumed"))).toBe(true);
});
