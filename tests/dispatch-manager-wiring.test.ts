/**
 * Degradation ladder (concern 06, plans/research-sirvir/06-degradation-ladder.md) — PR #105 built and
 * unit-tested the full per-provider partitioning capability by DIRECT `Dispatcher` construction
 * (tests/rate-limit.test.ts), but deliberately left `squad-manager.ts` unwired: `providerFor` and
 * `secondLaneAvailable` were never supplied to the real `Dispatcher`, so the live daemon still ran the
 * legacy global-freeze path. This file extends that same Dispatcher-construction test pattern one level
 * up — through the REAL `SquadManager`'s own wiring (its actual `this.dispatcher`, its actual
 * `this.rateLimit`, and the actual `dispatchProviderFor`/`hasSecondVerifiedProviderLane` closures it
 * supplies) — against a stub Plane server (root-factory.test.ts's hermetic pattern), proving:
 *
 *   (a) TODAY (no verified second provider lane): the manager's real Dispatcher still runs the
 *       byte-for-byte legacy global freeze — a cap noted for ANY provider string, matching or not,
 *       freezes the whole tick (no regression from the pre-ladder behavior).
 *   (b) Once a second harness is actually verified (a live smoke, simulated via registry override): a
 *       cap for a provider OTHER than the one a real spawn would resolve to no longer blocks dispatch.
 *   (c) ...while a cap for the ACTUAL resolved provider still pauses dispatch — the differentiation is
 *       real, not a fail-open no-op.
 */

import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { getHarness, registerHarness } from "../src/harness-registry.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { PersistedAgent, RpcSessionState } from "../src/types.ts";

const ENV = ["OMP_SQUAD_AUTODISPATCH", "OMP_SQUAD_OBSERVE", "OMP_SQUAD_SCOUT", "OMP_SQUAD_OPPORTUNITY", "OMP_SQUAD_PLANSYNC", "OMP_SQUAD_AUTODRIVE", "OMP_SQUAD_PLANE_CACHE_MS", "PLANE_API_KEY", "PLANE_WORKSPACE", "PLANE_BASE_URL", "PLANE_PROJECT_MAP"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV) saved[k] = process.env[k];

const tmps: string[] = [];
afterEach(async () => {
	for (const k of ENV) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

/** Temporarily override one registry entry and ALWAYS restore the original (module-global registry —
 *  mirrors harness-registry.test.ts's own `withHarnessOverride`, async-aware for this file's setup). */
async function withHarnessOverride<T>(name: string, over: Partial<Parameters<typeof registerHarness>[0]>, fn: () => Promise<T>): Promise<T> {
	const original = getHarness(name);
	if (!original) throw new Error(`no registered harness "${name}" to override`);
	registerHarness({ ...original, ...over, name });
	try {
		return await fn();
	} finally {
		registerHarness(original);
	}
}

class FakeDriver extends EventEmitter implements AgentDriver {
	readonly isReady = true;
	readonly isAlive = true;
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async prompt(): Promise<void> {}
	async abort(): Promise<unknown> {
		return undefined;
	}
	async getState(): Promise<RpcSessionState> {
		return { todoPhases: [], isStreaming: false } as RpcSessionState;
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

interface DriverFactoryHost {
	makeDriver: (p: PersistedAgent, cold?: boolean) => AgentDriver;
}
interface RateLimitLike {
	note: (msg: unknown, delayMs: unknown, provider?: string) => boolean;
}
interface ManagerInternals {
	dispatcher?: { tick: () => Promise<number>; running: boolean };
	rateLimit: RateLimitLike;
}

/** The dispatcher's boot tick (fired fire-and-forget by `Dispatcher.start()` inside `mgr.start()`) races
 *  a test's own controlled `tick()` call — wait for it to fully settle (its `listIssues` round-trip
 *  included) before driving anything deterministic, bounded so a real hang still fails loudly. */
async function waitForIdle(dispatcher: { running: boolean }, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (dispatcher.running) {
		if (Date.now() - start > timeoutMs) throw new Error("dispatcher never went idle");
		await new Promise((r) => setTimeout(r, 5));
	}
}

async function makeRepo(prefix: string): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(repo);
	const git = async (args: string[]) => {
		await Bun.spawn(["git", ...args], { cwd: repo, stdout: "ignore", stderr: "ignore" }).exited;
	};
	await git(["init", "-q"]);
	await git(["config", "user.email", "t@t"]);
	await git(["config", "user.name", "t"]);
	await git(["config", "commit.gpgsign", "false"]);
	await fs.writeFile(path.join(repo, "README.md"), "x\n");
	await git(["add", "."]);
	await git(["commit", "-qm", "init"]);
	return repo;
}

/** A minimal Plane stub whose `/issues/` list is driven by a mutable ref, so the boot tick (fired
 *  synchronously inside `mgr.start()`, before the test can install `makeDriver`) sees an EMPTY backlog
 *  and spawns nothing, while a later, explicitly-awaited `dispatcher.tick()` sees the real issues. */
function planeStub(issuesRef: { current: unknown[] }) {
	return Bun.serve({
		port: 0,
		fetch: (req) => {
			const p = new URL(req.url).pathname;
			if (p.endsWith("/relations/")) return Response.json({ blocked_by: [], blocking: [], relates_to: [] });
			if (p.endsWith("/states/")) return Response.json({ results: [] });
			if (/\/projects\/[^/]+\/$/.test(p)) return Response.json({ identifier: "TST" });
			if (p.endsWith("/issues/")) return Response.json({ results: issuesRef.current });
			return new Response("no", { status: 404 });
		},
	});
}

async function makeWiredManager(): Promise<{ mgr: SquadManager; issuesRef: { current: unknown[] }; stop: () => Promise<void> }> {
	const repo = await makeRepo("dispatch-wiring-repo-");
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-wiring-state-"));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-wiring-wt-"));
	tmps.push(stateDir, worktreeBase);
	const issuesRef = { current: [] as unknown[] };
	const plane = planeStub(issuesRef);
	process.env.PLANE_API_KEY = "secret";
	process.env.PLANE_WORKSPACE = "acme";
	process.env.PLANE_BASE_URL = `http://127.0.0.1:${plane.port}`;
	process.env.PLANE_PROJECT_MAP = JSON.stringify({ [repo]: "proj-1" });
	process.env.OMP_SQUAD_OBSERVE = "0";
	process.env.OMP_SQUAD_SCOUT = "0";
	process.env.OMP_SQUAD_OPPORTUNITY = "0";
	process.env.OMP_SQUAD_PLANSYNC = "0";
	process.env.OMP_SQUAD_AUTODRIVE = "0";
	// listPlaneIssues caches successful reads for OMP_SQUAD_PLANE_CACHE_MS (default 15s) — the boot tick's
	// fetch, which sees an EMPTY backlog, would otherwise poison that cache and starve the test's own
	// controlled tick() of the issues populated below.
	process.env.OMP_SQUAD_PLANE_CACHE_MS = "0";
	delete process.env.OMP_SQUAD_AUTODISPATCH; // default ON — arms the real Dispatcher

	const mgr = new SquadManager({ stateDir, worktreeBase });
	await mgr.start(); // boot tick sees issuesRef.current === [] — nothing spawns
	await waitForIdle((mgr as unknown as ManagerInternals).dispatcher!); // let the boot tick fully settle before driving our own
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new FakeDriver();

	issuesRef.current = [
		{ id: "iss-a", sequence_id: 1, name: "issue a", state_detail: { group: "unstarted" }, description_stripped: "spec a" },
		{ id: "iss-b", sequence_id: 2, name: "issue b", state_detail: { group: "unstarted" }, description_stripped: "spec b" },
	];
	return {
		mgr,
		issuesRef,
		stop: async () => {
			await mgr.stop();
			plane.stop(true);
		},
	};
}

test("today (no verified second provider lane): a cap on ANY provider still freezes the whole real-manager tick", async () => {
	const { mgr, stop } = await makeWiredManager();
	const internals = mgr as unknown as ManagerInternals;
	expect(internals.dispatcher).toBeDefined(); // the ladder deps are wired, but inert without a second lane

	// A provider that would NEVER match this fleet's resolved (default-harness, no-model) provider —
	// under the legacy no-arg top-of-tick check this still freezes everything, exactly as before the ladder.
	internals.rateLimit.note("429 usage limit", 10 * 60_000, "openai");
	const spawned = await internals.dispatcher!.tick();
	expect(spawned).toBe(0);
	await stop();
}, 20_000);

test("a real second verified provider lane: a MISMATCHED cap no longer blocks the real-manager tick", async () => {
	await withHarnessOverride("codex", { verified: true }, async () => {
		const { mgr, stop } = await makeWiredManager();
		const internals = mgr as unknown as ManagerInternals;

		// codex (openai) is now a genuinely verified, differently-provider'd lane vs the default "omp"
		// harness (unknown lineage) — hasSecondVerifiedProviderLane() flips true through the REAL wired
		// closure. Capping "openai" must NOT touch the default-harness units' bucket.
		internals.rateLimit.note("429 usage limit", 10 * 60_000, "openai");
		const spawned = await internals.dispatcher!.tick();
		expect(spawned).toBe(2); // both units dispatch — the cap landed on a bucket neither of them resolves to
		await stop();
	});
}, 20_000);

test("a real second verified provider lane: a cap on the ACTUAL resolved provider still pauses the real-manager tick", async () => {
	await withHarnessOverride("codex", { verified: true }, async () => {
		const { mgr, stop } = await makeWiredManager();
		const internals = mgr as unknown as ManagerInternals;

		// The default "omp" harness with no explicit model resolves to "unknown", which RateLimitGate
		// folds into DEFAULT_PROVIDER ("anthropic") — noting a cap with no provider (or "unknown") lands
		// in exactly that bucket, so it MUST still pause every default-harness unit.
		internals.rateLimit.note("429 usage limit", 10 * 60_000, "unknown");
		const spawned = await internals.dispatcher!.tick();
		expect(spawned).toBe(0);
		await stop();
	});
}, 20_000);
