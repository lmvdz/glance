/**
 * research-sirvir/03 (dead-wire fix) — regression guard for the interactive `POST /api/spawn` route.
 *
 * Every existing smart-spawn test (tests/smart-spawn.test.ts) drives `assemblePlan`/`planSpawn`
 * directly and would keep passing even if `server.ts`'s route never wired a scoreboard in at all —
 * that's exactly the dead-wire bug this concern fixes (server.ts called `planSpawn` with no
 * `outcomes`/`scoreboard`, so `shiftedModel`'s `if (!scoreboard) return {}` guard always fired on the
 * live path, silently, regardless of `OMP_SQUAD_MODEL_OUTCOMES`). This test drives the REAL HTTP
 * route on a REAL `SquadServer`/`SquadManager` pair with a seeded, non-empty, family-keyed ledger —
 * it fails if the wire is ever cut again, which no assemblePlan-only test can catch.
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, test } from "bun:test";
import type { AgentDriver } from "../src/agent-driver.ts";
import type { Scoreboard } from "../src/attribution-scoreboard.ts";
import { FileStore } from "../src/dal/store.ts";
import { recordModelOutcome } from "../src/model-outcomes.ts";
import { SPAWN_SCOREBOARD_TTL_MS, SquadManager } from "../src/squad-manager.ts";
import { SquadServer } from "../src/server.ts";
import type { PersistedAgent, RpcSessionState } from "../src/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0"; // hermetic: no ambient Plane auto-dispatch racing the roster

/** Never spawns a real `omp` child for the agent's own work — `manager.create()` still runs its full
 *  worktree/admission path (so the response really exercises `create()`, not a stub), but the "agent
 *  turn" itself resolves instantly, exactly like `branch-spawn-reconciliation.test.ts`'s FakeDriver. */
class FakeDriver extends EventEmitter implements AgentDriver {
	readonly isReady = true;
	readonly isAlive = true;
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async prompt(): Promise<void> {
		queueMicrotask(() => this.emit("event", { type: "agent_end" }));
	}
	async abort(): Promise<unknown> {
		return undefined;
	}
	async getState(): Promise<RpcSessionState> {
		return { todoPhases: [], isStreaming: false } as RpcSessionState;
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

/** `SquadManager.makeDriver` is TS-`private` only (compile-time) — overriding it from a test is the
 *  established escape hatch (see `branch-spawn-reconciliation.test.ts`) to keep `create()` from
 *  spawning a real harness process. */
interface DriverFactoryHost {
	makeDriver: (p: PersistedAgent, cold?: boolean) => AgentDriver;
}

const tmps: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
const originalPath = process.env.PATH;
const originalCwd = process.cwd();

afterEach(async () => {
	process.env.PATH = originalPath;
	process.chdir(originalCwd);
	delete process.env.OMP_SQUAD_MODEL_OUTCOMES;
	delete process.env.OMP_SQUAD_REPO_ROOTS;
	delete process.env.OMP_SQUAD_RESOURCE_GATE;
	for (const c of cleanups.splice(0)) await c();
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function makeRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "spawn-route-repo-"));
	tmps.push(repo);
	const git = async (args: string[]) => {
		const p = Bun.spawn(["git", ...args], { cwd: repo, stdout: "ignore", stderr: "ignore" });
		await p.exited;
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

/** A `$PATH` directory with `git` symlinked (worktree ops still need it) but deliberately NO `omp` —
 *  so `smart-spawn.ts`'s `infer()` falls back to heuristics INSTANTLY (`Bun.which` returns null, no
 *  subprocess spawned at all, no 20s timeout, no live model call) instead of shelling out to a real
 *  `omp` CLI from this test. Same trick as `tests/gh.test.ts`'s `pathWithGitButNoGh`. */
async function pathWithGitButNoOmp(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "spawn-route-bin-"));
	tmps.push(dir);
	const which = Bun.spawn(["which", "git"], { stdout: "pipe" });
	const realGit = (await new Response(which.stdout).text()).trim();
	await which.exited;
	await fs.symlink(realGit, path.join(dir, "git"));
	return dir;
}

/** Seed a non-empty, family-keyed `(model, tier)` ledger clearing `MIN_SAMPLES` on both sides, with a
 *  wide edge (opus 0.875 vs the omitted-model incumbent's 0.125 — a `0.75` gap, far past `MIN_EDGE`
 *  0.15) at the "mid" tier. `infer()`'s fallback path always returns `raw === undefined` when no live
 *  `omp` is on PATH, so `assemblePlan` sees `thinking === undefined` ⇒ `tierOf(undefined) === "mid"`. */
function seedLedger(stateDir: string): void {
	for (let i = 0; i < 7; i++) recordModelOutcome(stateDir, "opus", "mid", true);
	recordModelOutcome(stateDir, "opus", "mid", false);
	recordModelOutcome(stateDir, undefined, "mid", true); // undefined ⇒ folds to DEFAULT_MODEL_FAMILY ("sonnet")
	for (let i = 0; i < 7; i++) recordModelOutcome(stateDir, undefined, "mid", false);
}

async function startFixture(): Promise<{ url: string; stateDir: string }> {
	delete process.env.OMP_SQUAD_RESOURCE_GATE; // hermetic: admission must not depend on ambient host pressure
	const repo = await makeRepo();
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "spawn-route-state-"));
	tmps.push(stateDir);
	seedLedger(stateDir);

	const manager = new SquadManager({ stateDir, store: new FileStore(stateDir) });
	(manager as unknown as DriverFactoryHost).makeDriver = () => new FakeDriver();
	await manager.start();

	const server = new SquadServer(manager, { port: 0 }); // no token: file-mode/unit-test loopback ⇒ every request is admin
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await manager.stop();
	});

	process.env.OMP_SQUAD_REPO_ROOTS = ""; // deterministic candidate set: just `cwd` (no ~/sui, ~/src, ~/code scan)
	process.env.PATH = await pathWithGitButNoOmp();
	process.chdir(repo); // discoverRepos(process.cwd(), …) must resolve to THIS fixture repo, never the real project tree

	return { url, stateDir };
}

test("POST /api/spawn wires the outcome-driven shift through the REAL server route (flag on)", async () => {
	const { url } = await startFixture();
	process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";

	const res = await fetch(`${url}/api/spawn`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ prompt: "fix the thing" }),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as { agent: unknown; plan: { model?: string; reason?: string } };
	// The heart of the regression: if server.ts ever drops the scoreboard wire again, this reads back
	// `undefined`/`plan.reason` with no "model shifted" text — exactly the dead-wire bug's symptom.
	expect(body.plan.model).toBe("opus");
	expect(body.plan.reason).toContain("model shifted to opus");
	expect(body.plan.reason).toContain("mid");
	expect(body.agent).toBeTruthy();
});

test("POST /api/spawn: same seeded ledger, flag OFF ⇒ no shift (control — proves the assertion above is real)", async () => {
	const { url } = await startFixture();
	// OMP_SQUAD_MODEL_OUTCOMES deliberately left unset.

	const res = await fetch(`${url}/api/spawn`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ prompt: "fix the thing" }),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as { plan: { model?: string; reason?: string } };
	expect(body.plan.model).toBeUndefined();
});

// ── spawnScoreboard TTL + single-flight cache (PR #114 cross-lineage review) ────────────────────
// `readAllReceipts` is an O(lifetime-receipts) walk+parse; with OMP_SQUAD_MODEL_OUTCOMES=1 every
// POST /api/spawn hits `spawnScoreboard()`. These prove one scan is SHARED, not raced or repeated.
// Sharing is asserted via board OBJECT IDENTITY — `buildScoreboard` mints a fresh object per build,
// so `a === b` holds iff exactly one build produced both results (a stronger, less mockable claim
// than a call-count spy) — paired with a data-staleness probe (an outcome recorded mid-TTL must NOT
// appear, which is only possible if the ledger genuinely wasn't re-read).

/** TS-`private` cache slots, reached the same way the suite already reaches `makeDriver`. */
interface ScoreboardCacheHost {
	scoreboardCache?: { at: number; board: Scoreboard };
}

async function scoreboardManager(): Promise<{ mgr: SquadManager; stateDir: string }> {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "spawn-sb-state-"));
	tmps.push(stateDir);
	seedLedger(stateDir);
	const mgr = new SquadManager({ stateDir, store: new FileStore(stateDir) }); // no start(): spawnScoreboard needs only stateDir
	cleanups.push(() => mgr.stop());
	return { mgr, stateDir };
}

const opusMid = (b: Scoreboard) => b.models.find((m) => m.model === "opus")?.byTier.find((t) => t.tier === "mid");

test("spawnScoreboard: two calls within the TTL share ONE build — the second is a cache hit that never re-reads the ledger", async () => {
	const { mgr, stateDir } = await scoreboardManager();
	const first = await mgr.spawnScoreboard();
	expect(opusMid(first)?.landed).toBe(7);

	// Mutate the ledger AFTER the first build. A cache hit cannot see this; a re-scan would.
	recordModelOutcome(stateDir, "opus", "mid", true);

	const second = await mgr.spawnScoreboard();
	expect(second).toBe(first); // identity ⇒ the very same built board, no second readAllReceipts walk
	expect(opusMid(second)?.landed).toBe(7); // staleness probe: the mid-TTL land is (correctly) not visible yet
});

test(`spawnScoreboard: after TTL (${SPAWN_SCOREBOARD_TTL_MS}ms) expiry the board is rebuilt and picks up new outcomes`, async () => {
	const { mgr, stateDir } = await scoreboardManager();
	const first = await mgr.spawnScoreboard();
	recordModelOutcome(stateDir, "opus", "mid", true);

	// Age the cache entry past the TTL instead of sleeping 60s — same private-slot escape hatch as makeDriver.
	const host = mgr as unknown as ScoreboardCacheHost;
	expect(host.scoreboardCache).toBeDefined();
	host.scoreboardCache!.at = Date.now() - SPAWN_SCOREBOARD_TTL_MS - 1;

	const rebuilt = await mgr.spawnScoreboard();
	expect(rebuilt).not.toBe(first); // a genuinely fresh build…
	expect(opusMid(rebuilt)?.landed).toBe(8); // …that re-read the ledger and sees the new land

	// And the rebuilt board re-primes the cache: an immediate third call is a hit again.
	expect(await mgr.spawnScoreboard()).toBe(rebuilt);
});

test("spawnScoreboard: N concurrent cold calls single-flight into ONE scan (no thundering herd of receipt walks)", async () => {
	const { mgr } = await scoreboardManager();
	// Fire all requests before awaiting any — the exact concurrent-interactive-spawns shape.
	const boards = await Promise.all([mgr.spawnScoreboard(), mgr.spawnScoreboard(), mgr.spawnScoreboard(), mgr.spawnScoreboard(), mgr.spawnScoreboard()]);
	for (const b of boards.slice(1)) expect(b).toBe(boards[0]); // one build object shared by every caller ⇒ one scan
	expect(opusMid(boards[0])?.landed).toBe(7);
});
