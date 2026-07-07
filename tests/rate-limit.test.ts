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

// ── Degradation ladder (concern 06): per-provider partitioning ──────────────────────────

test("note/paused partition by provider: a cap on A leaves B unpaused", () => {
	let now = 0;
	const gate = new RateLimitGate(() => now);
	expect(gate.note("429 too many requests", 10 * 60_000, "openai")).toBe(true);
	expect(gate.paused("openai")).toBe(true);
	expect(gate.paused("google")).toBe(false);
	expect(gate.paused("anthropic")).toBe(false);
});

test("paused() with no argument ORs across every tracked provider (legacy global check)", () => {
	let now = 0;
	const gate = new RateLimitGate(() => now);
	expect(gate.paused()).toBe(false);
	gate.note("rate limit", 5 * 60_000, "openai");
	expect(gate.paused()).toBe(true); // ANY provider capped ⇒ legacy no-arg reader still sees "paused"
	expect(gate.paused("google")).toBe(false); // but a specific, live provider is unaffected
	now += 5 * 60_000;
	expect(gate.paused()).toBe(false); // self-clears once every bucket's window elapses
});

test("an unclassifiable (unknown) provider folds into the dominant provider bucket, not a separate one", () => {
	let now = 0;
	const gate = new RateLimitGate(() => now);
	// A claude-code cap (resolves to "anthropic") ...
	gate.note("usage limit reached", 10 * 60_000, "anthropic");
	// ... must ALSO pause a default omp unit whose provider couldn't be classified ("unknown"/absent) —
	// closing the concern's documented under-pause bug (same real subscription, different labels).
	expect(gate.paused("unknown")).toBe(true);
	expect(gate.paused(undefined)).toBe(true);
	// Symmetric: an unclassifiable cap pauses the dominant (anthropic) provider too.
	const gate2 = new RateLimitGate(() => now);
	gate2.note("weekly limit hit", 10 * 60_000, undefined);
	expect(gate2.paused("anthropic")).toBe(true);
	// A genuinely different, live provider is NOT folded in.
	expect(gate.paused("openai")).toBe(false);
	expect(gate2.paused("openai")).toBe(false);
});

test("note without a provider (back-compat 2-arg call) keeps working byte-for-byte", () => {
	let now = 1000;
	const gate = new RateLimitGate(() => now);
	expect(gate.note("429", 10 * 60_000)).toBe(true); // old 2-arg call site (squad-manager.ts)
	expect(gate.paused()).toBe(true);
	expect(gate.until).toBe(now + 10 * 60_000);
	expect(gate.reason).toBe("429");
});

test("untilFor/reasonFor read a specific provider's bucket independently", () => {
	let now = 0;
	const gate = new RateLimitGate(() => now);
	gate.note("rate limit A", 3 * 60_000, "openai");
	now = 1;
	gate.note("rate limit B", 20 * 60_000, "google");
	expect(gate.untilFor("openai")).toBe(3 * 60_000);
	expect(gate.untilFor("google")).toBe(1 + 20 * 60_000);
	expect(gate.reasonFor("openai")).toBe("rate limit A");
	expect(gate.reasonFor("google")).toBe("rate limit B");
	// No-arg readers report the LATEST (most urgent/current) bucket — google's, here.
	expect(gate.until).toBe(1 + 20 * 60_000);
	expect(gate.reason).toBe("rate limit B");
});

test("pausedProviders lists only currently-capped buckets, self-clearing as windows elapse", () => {
	let now = 0;
	const gate = new RateLimitGate(() => now);
	gate.note("429", 60_000, "openai");
	gate.note("429", 5 * 60_000, "google");
	expect(gate.pausedProviders().sort()).toEqual(["google", "openai"]);
	now = 60_000;
	expect(gate.pausedProviders()).toEqual(["google"]); // openai's window elapsed
});

test("dispatcher: a paused provider A doesn't gate a provider-B dispatch (per-unit gating)", async () => {
	let now = 0;
	const gate = new RateLimitGate(() => now);
	gate.note("429 rate limit", 10 * 60_000, "openai"); // codex/openai capped
	const spawned: string[] = [];
	const logs: string[] = [];
	const issueA: IssueRef = { id: "A", name: "codex issue" }; // provider: openai
	const issueB: IssueRef = { id: "B", name: "omp issue" }; // provider: anthropic
	const deps: DispatchDeps = {
		repos: () => ["/r"],
		listIssues: async () => [issueA, issueB],
		spawn: async (_repo, iss) => {
			spawned.push(iss.id);
		},
		claimed: () => new Set(),
		activeCount: () => 0,
		log: (m) => logs.push(m),
		maxActive: 10,
		paused: (provider) => gate.paused(provider),
		providerFor: (_repo, iss) => (iss.id === "A" ? "openai" : "anthropic"),
		secondLaneAvailable: () => true,
	};
	const d = new Dispatcher(deps);
	expect(await d.tick()).toBe(1); // only B (anthropic) spawns; A (openai) is capped
	expect(spawned).toEqual(["B"]);
	expect(logs.some((m) => m.includes("paused") && m.includes("openai"))).toBe(true);

	// The previous GLOBAL-pause behavior is provably gone: a capped provider no longer freezes the
	// whole tick — a second tick with A's cap still active keeps B available (already dispatched here,
	// so add a fresh B-provider issue to prove ongoing differentiation).
	const issueC: IssueRef = { id: "C", name: "another omp issue" };
	deps.listIssues = async () => [issueA, issueC];
	expect(await d.tick()).toBe(1); // C (anthropic) spawns even though A (openai) is still capped
	expect(spawned.sort()).toEqual(["B", "C"]);
});

test("dispatcher: with only the default provider present, the global freeze still holds (no regression)", async () => {
	let now = 0;
	const gate = new RateLimitGate(() => now);
	gate.note("429 rate limit", 10 * 60_000, "anthropic");
	const spawned: string[] = [];
	const deps: DispatchDeps = {
		repos: () => ["/r"],
		listIssues: async () => [{ id: "A", name: "a" }, { id: "B", name: "b" }],
		spawn: async (_repo, iss) => {
			spawned.push(iss.id);
		},
		claimed: () => new Set(),
		activeCount: () => 0,
		log: () => {},
		maxActive: 10,
		paused: (provider) => gate.paused(provider),
		providerFor: () => "anthropic", // both units resolve to the one, capped provider
		secondLaneAvailable: () => true,
	};
	expect(await new Dispatcher(deps).tick()).toBe(0); // still fully frozen — no live provider to differentiate onto
	expect(spawned).toEqual([]);
});

test("dispatcher: providerFor absent ⇒ old top-of-tick global paused() behavior, byte-for-byte", async () => {
	// No providerFor supplied at all (the pre-ladder shape): even though `paused` now accepts an
	// optional provider argument, the dispatcher must fall back to the legacy no-arg top-of-tick check.
	let paused = true;
	const spawned: string[] = [];
	const logs: string[] = [];
	const deps: DispatchDeps = {
		repos: () => ["/r"],
		listIssues: async () => [{ id: "A", name: "a" }],
		spawn: async (_repo, iss) => {
			spawned.push(iss.id);
		},
		claimed: () => new Set(),
		activeCount: () => 0,
		log: (m) => logs.push(m),
		maxActive: 10,
		paused: (provider) => (provider === undefined ? paused : false),
	};
	const d = new Dispatcher(deps);
	expect(await d.tick()).toBe(0);
	expect(spawned).toEqual([]);
	expect(logs.some((m) => m.includes("paused"))).toBe(true);
	paused = false;
	expect(await d.tick()).toBe(1);
	expect(spawned).toEqual(["A"]);
});

test("dispatcher: providerFor present but no second verified lane ⇒ inert fallback logs once, global freeze holds", async () => {
	const spawned: string[] = [];
	const logs: string[] = [];
	const deps: DispatchDeps = {
		repos: () => ["/r"],
		listIssues: async () => [{ id: "A", name: "a" }, { id: "B", name: "b" }],
		spawn: async (_repo, iss) => {
			spawned.push(iss.id);
		},
		claimed: () => new Set(),
		activeCount: () => 0,
		log: (m) => logs.push(m),
		maxActive: 10,
		paused: () => true, // global cooldown active
		providerFor: () => "anthropic",
		secondLaneAvailable: () => false, // no second verified provider lane configured
	};
	const d = new Dispatcher(deps);
	expect(await d.tick()).toBe(0);
	expect(spawned).toEqual([]);
	expect(logs.some((m) => m.includes("inert"))).toBe(true);
	expect(logs.filter((m) => m.includes("inert")).length).toBe(1); // logged once, not every tick
	await d.tick();
	expect(logs.filter((m) => m.includes("inert")).length).toBe(1); // still once
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
