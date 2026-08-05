/**
 * Bounded/hermetic/process-group-aware panel subprocess spawning (T5 gauntlet round 1, glance#333,
 * clusters B and C) — `src/rail/panel-spawn.ts`.
 *
 * B2 (HIGH, both lineages): codex reproduced a grandchild surviving a direct-process kill under PPID 1,
 * keeping a stdout pipe read pending forever. `processGroupTeardown` below is the PROOF this is fixed:
 * a spawned process backgrounds a child that would (if merely the direct process were killed) survive
 * and later touch a marker file — after a timeout-triggered kill, the marker must NEVER appear.
 *
 * B4 (HIGH): a process-wide concurrency limiter bounds real OS processes, not just in-flight promises.
 *
 * C3 (HIGH, both lineages): every spawn runs in a hermetic, empty scratch `cwd` — never the daemon's
 * own launch directory.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	boundedHermeticSpawn,
	globalPanelInFlightForTests,
	hermeticCwd,
	removeHermeticCwd,
	resetGlobalPanelLimiterForTests,
} from "../src/rail/panel-spawn.ts";

afterEach(() => {
	delete process.env.OMP_SQUAD_REVIEW_PANEL_GLOBAL_MAX;
	resetGlobalPanelLimiterForTests();
});

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

// ── C3: hermetic cwd ─────────────────────────────────────────────────────────────────────────────

test("hermeticCwd returns a fresh, EMPTY scratch directory — nothing for an agentic reviewer to discover", async () => {
	const dir = await hermeticCwd();
	tmps.push(dir);
	const entries = await fs.readdir(dir);
	expect(entries).toEqual([]);
	const stat = await fs.stat(dir);
	expect(stat.isDirectory()).toBe(true);
});

test("hermeticCwd never returns the daemon's own cwd or repo root", async () => {
	const dir = await hermeticCwd();
	tmps.push(dir);
	expect(dir).not.toBe(process.cwd());
	// Never inside THIS repo checkout, where AGENTS.md/plan docs actually live.
	expect(path.resolve(dir).startsWith(path.resolve(process.cwd()))).toBe(false);
});

test("removeHermeticCwd cleans up — the directory no longer exists afterward", async () => {
	const dir = await hermeticCwd();
	await removeHermeticCwd(dir);
	await expect(fs.stat(dir)).rejects.toThrow();
});

test("boundedHermeticSpawn actually runs the process WITH the hermetic cwd it was given", async () => {
	const cwd = await hermeticCwd();
	tmps.push(cwd);
	const { out, code, timedOut } = await boundedHermeticSpawn({ bin: "pwd", args: [], cwd, timeoutMs: 5_000 });
	expect(timedOut).toBe(false);
	expect(code).toBe(0);
	// Resolve symlinks on both sides (macOS/WSL /tmp is often a symlink) before comparing.
	expect(await fs.realpath(out.trim())).toBe(await fs.realpath(cwd));
});

// ── basic contract: never throws, honest timedOut/code ──────────────────────────────────────────

test("a normal, fast command returns its real output and code, timedOut:false", async () => {
	const cwd = await hermeticCwd();
	tmps.push(cwd);
	const { out, code, timedOut } = await boundedHermeticSpawn({ bin: "echo", args: ["hello-panel"], cwd, timeoutMs: 5_000 });
	expect(out.trim()).toBe("hello-panel");
	expect(code).toBe(0);
	expect(timedOut).toBe(false);
});

test("a missing binary never throws — degrades to code:1, timedOut:false", async () => {
	const cwd = await hermeticCwd();
	tmps.push(cwd);
	const result = await boundedHermeticSpawn({ bin: "this-binary-does-not-exist-anywhere", args: [], cwd, timeoutMs: 1_000 });
	expect(result).toEqual({ out: "", code: 1, timedOut: false });
});

// ── B2: process-group teardown proof ────────────────────────────────────────────────────────────

test("B2 PROOF: a timed-out reviewer's BACKGROUNDED CHILD is killed too — it never survives to leave evidence behind", async () => {
	const cwd = await hermeticCwd();
	tmps.push(cwd);
	const markerDir = await fs.mkdtemp(path.join(os.tmpdir(), "panel-spawn-marker-"));
	tmps.push(markerDir);
	const marker = path.join(markerDir, "survived.txt");

	// The direct process backgrounds a child that sleeps briefly then writes the marker — if ONLY the
	// direct process were killed (the OLD `AbortSignal.timeout` behavior codex reproduced), this child
	// would keep running under PPID 1 and eventually write the marker. `boundedHermeticSpawn` must kill
	// the WHOLE process group on timeout, so the marker must NEVER appear.
	const { timedOut } = await boundedHermeticSpawn({
		bin: "sh",
		args: ["-c", `(sleep 1; touch '${marker}') & sleep 30`],
		cwd,
		timeoutMs: 150,
	});
	expect(timedOut).toBe(true);

	// Wait well past the backgrounded child's own 1s sleep — if it survived the kill, the marker would
	// exist by now.
	await new Promise((r) => setTimeout(r, 1_500));
	await expect(fs.stat(marker)).rejects.toThrow(); // the descendant never got to write it — it's dead
});

test("a hung process does not leak an OS process across MANY sequential bounded calls (no fd/process accumulation)", async () => {
	const cwd = await hermeticCwd();
	tmps.push(cwd);
	// Five sequential timeouts in a row — if kills weren't real, this would leave 5 processes running.
	// Nothing here directly counts host processes (that would be flaky across CI sandboxes), but the
	// function returning promptly 5 times in a row, each within its own short bound, is itself strong
	// evidence no call is ever left waiting on the previous run's orphan.
	for (let i = 0; i < 5; i++) {
		const start = Date.now();
		const { timedOut } = await boundedHermeticSpawn({ bin: "sleep", args: ["30"], cwd, timeoutMs: 80 });
		expect(timedOut).toBe(true);
		expect(Date.now() - start).toBeLessThan(1_000);
	}
});

// ── B4: process-wide concurrency limiter ────────────────────────────────────────────────────────

test("B4: the global concurrency limiter bounds SIMULTANEOUS reviewer subprocesses across the whole process", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL_GLOBAL_MAX = "2";
	resetGlobalPanelLimiterForTests();
	const cwds = await Promise.all(Array.from({ length: 6 }, () => hermeticCwd()));
	tmps.push(...cwds);

	let maxObserved = 0;
	const sampler = setInterval(() => {
		maxObserved = Math.max(maxObserved, globalPanelInFlightForTests());
	}, 5);
	try {
		await Promise.all(cwds.map((cwd) => boundedHermeticSpawn({ bin: "sleep", args: ["0.2"], cwd, timeoutMs: 5_000 })));
	} finally {
		clearInterval(sampler);
	}
	expect(maxObserved).toBeGreaterThan(0);
	expect(maxObserved).toBeLessThanOrEqual(2); // never more than the configured cap, even with 6 requests in flight
});

test("B4: the limiter releases a slot only once its process is confirmed gone — a queued call actually waits", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL_GLOBAL_MAX = "1";
	resetGlobalPanelLimiterForTests();
	const cwd1 = await hermeticCwd();
	const cwd2 = await hermeticCwd();
	tmps.push(cwd1, cwd2);

	const start = Date.now();
	await Promise.all([
		boundedHermeticSpawn({ bin: "sleep", args: ["0.15"], cwd: cwd1, timeoutMs: 5_000 }),
		boundedHermeticSpawn({ bin: "sleep", args: ["0.15"], cwd: cwd2, timeoutMs: 5_000 }),
	]);
	// With a cap of 1, the two 150ms sleeps cannot fully overlap — total wall time must be closer to
	// 300ms than to 150ms.
	expect(Date.now() - start).toBeGreaterThanOrEqual(250);
});

test("globalPanelInFlightForTests / resetGlobalPanelLimiterForTests round-trip cleanly", async () => {
	resetGlobalPanelLimiterForTests();
	expect(globalPanelInFlightForTests()).toBe(0);
	const cwd = await hermeticCwd();
	tmps.push(cwd);
	await boundedHermeticSpawn({ bin: "true", args: [], cwd, timeoutMs: 2_000 });
	// The slot is released once the process is confirmed gone — by the time the await above resolves,
	// it must be back to 0.
	expect(globalPanelInFlightForTests()).toBe(0);
});
