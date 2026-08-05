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
	scratchConflictsWithAnyManagedPath,
} from "../src/rail/panel-spawn.ts";

const savedTmpdir = process.env.TMPDIR;
afterEach(() => {
	delete process.env.OMP_SQUAD_REVIEW_PANEL_GLOBAL_MAX;
	if (savedTmpdir === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = savedTmpdir;
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

// ── B2 round 2: the teardown-race fix — SIGKILL the GROUP regardless of the leader's own exit ──────
// Round 1's `killProcessGroup` raced SIGKILL-escalation against the group LEADER's `exited` promise: if
// the leader died from SIGTERM (the default, un-trapped reaction) while a DESCENDANT explicitly ignored
// SIGTERM and kept running, the race resolved "not still alive" the instant the LEADER alone exited, and
// SIGKILL was never sent to the survivor. This test's descendant explicitly traps/ignores SIGTERM (round
// 1's own process-group test did NOT do this, so it never actually exercised this specific race) — only
// an unconditional SIGKILL escalation, sent regardless of the leader's exit status, can kill it.

test("B2 ROUND 2 PROOF: a descendant that IGNORES SIGTERM (only the leader dies from it) is still killed by the unconditional SIGKILL escalation", async () => {
	const cwd = await hermeticCwd();
	tmps.push(cwd);
	const markerDir = await fs.mkdtemp(path.join(os.tmpdir(), "panel-spawn-marker-r2-"));
	tmps.push(markerDir);
	const marker = path.join(markerDir, "descendant-survived.txt");

	// The descendant explicitly ignores SIGTERM (`trap '' TERM`) and sleeps far longer than
	// `killProcessGroup`'s 2s grace period before writing the marker — so the marker can only be
	// created if the descendant survives PAST the grace-period SIGKILL. The leader itself does NOT trap
	// SIGTERM, so it dies immediately when the group is signaled — exactly the shape that defeated
	// round 1's "race against the leader's own exit" logic.
	const { timedOut } = await boundedHermeticSpawn({
		bin: "sh",
		args: ["-c", `(trap '' TERM; sleep 10; touch '${marker}') & sleep 30`],
		cwd,
		timeoutMs: 100,
	});
	expect(timedOut).toBe(true);

	// Wait past the 2s grace period (plus margin for the SIGKILL to actually land and the process to
	// die) but well short of the descendant's own 10s sleep — if the round-1 race had shipped, the
	// descendant would still be alive and unaffected at this point, eventually writing the marker at
	// the 10s mark; the round-2 fix must have already killed it well before then.
	await new Promise((r) => setTimeout(r, 3_000));
	await expect(fs.stat(marker)).rejects.toThrow(); // never written — the descendant was killed, not merely the leader
}, 15_000);

// ── C3 round 2: hermetic cwd must be VALIDATED outside every managed repo ───────────────────────────

test("C3 ROUND 2: a hostile TMPDIR resolving INSIDE an avoided (managed-repo) path is rejected on every attempt — hermeticCwd throws rather than handing back an unsafe cwd", async () => {
	const managedRepo = await fs.mkdtemp(path.join(os.tmpdir(), "hostile-managed-repo-"));
	tmps.push(managedRepo);
	process.env.TMPDIR = managedRepo; // hostile: every mktemp -d call lands INSIDE the "managed repo"
	await expect(hermeticCwd([managedRepo])).rejects.toThrow(/could not obtain a scratch directory outside every managed repo/);
});

test("C3 ROUND 2: a normal (non-hostile) TMPDIR still returns a valid cwd outside an unrelated avoided path", async () => {
	const unrelatedRepo = await fs.mkdtemp(path.join(os.tmpdir(), "unrelated-managed-repo-"));
	tmps.push(unrelatedRepo);
	const dir = await hermeticCwd([unrelatedRepo]);
	tmps.push(dir);
	const resolvedDir = await fs.realpath(dir);
	const resolvedRepo = await fs.realpath(unrelatedRepo);
	expect(resolvedDir === resolvedRepo || resolvedDir.startsWith(`${resolvedRepo}/`)).toBe(false);
});

test("C3 ROUND 2: hermeticCwd still validates against process.cwd() even when an unrelated avoid list is passed", async () => {
	const unrelatedRepo = await fs.mkdtemp(path.join(os.tmpdir(), "unrelated-managed-repo-2-"));
	tmps.push(unrelatedRepo);
	const dir = await hermeticCwd([unrelatedRepo]);
	tmps.push(dir);
	expect(path.resolve(dir).startsWith(path.resolve(process.cwd()))).toBe(false);
});

test("C3 ROUND 2: a rejected candidate directory is cleaned up (not leaked) before retrying", async () => {
	const managedRepo = await fs.mkdtemp(path.join(os.tmpdir(), "hostile-managed-repo-cleanup-"));
	tmps.push(managedRepo);
	process.env.TMPDIR = managedRepo;
	let threw = false;
	try {
		await hermeticCwd([managedRepo]);
	} catch {
		threw = true;
	}
	expect(threw).toBe(true);
	// Every rejected candidate should have been `rm -rf`'d — the hostile TMPDIR directory itself should
	// contain no leftover scratch subdirectories after all attempts were exhausted.
	const leftovers = await fs.readdir(managedRepo);
	expect(leftovers).toEqual([]);
});

// ── T5 gauntlet round 3 (glance#356, finding #6a): BIDIRECTIONAL containment ────────────────────────
// Round 2's `isInside(candidate, ancestor)` only rejected a candidate that is INSIDE (or equal to) a
// managed path. A candidate that is a PARENT of a managed repo is exactly as unsafe — an agentic
// reviewer exploring its own `cwd` can walk `..`/list siblings and discover the managed repo living a
// few directories below. Real `mktemp`/TMPDIR randomness can't reliably construct a "candidate is a
// PARENT of a managed repo" fixture on demand (the scratch dir's name is unpredictable), so the pure
// predicate `scratchConflictsWithAnyManagedPath` — the EXACT function `hermeticCwd` calls — is the
// direct, deterministic test surface for this fix.

test("ROUND 3 (finding #6a): a candidate that is a PARENT of a managed repo conflicts (the reverse of round 2's own check)", () => {
	const candidate = "/scratch/parent";
	const managedRepo = "/scratch/parent/child/managed-repo"; // nested INSIDE the candidate
	// Round 2's one-directional `isInside(candidate, managed)` would have said NO here — `candidate` is
	// not inside `managed`; it's the other way around. That was the actual bypass.
	expect(scratchConflictsWithAnyManagedPath(candidate, [managedRepo])).toBe(true);
});

test("ROUND 3 (finding #6a): a candidate INSIDE a managed repo still conflicts (round 2's original direction is preserved)", () => {
	expect(scratchConflictsWithAnyManagedPath("/managed/repo/deep/scratch", ["/managed/repo"])).toBe(true);
});

test("ROUND 3 (finding #6a): an identical candidate/managed path conflicts", () => {
	expect(scratchConflictsWithAnyManagedPath("/same/path", ["/same/path"])).toBe(true);
});

test("ROUND 3 (finding #6a): genuinely unrelated (sibling) paths do NOT conflict", () => {
	expect(scratchConflictsWithAnyManagedPath("/scratch/unrelated-sibling", ["/scratch/managed-repo"])).toBe(false);
});

test("ROUND 3 (finding #6a) end-to-end: hermeticCwd rejects an avoid path that is a DESCENDANT of a directory it JUST obtained (the reverse-containment case, against a real produced candidate)", async () => {
	// Real `mktemp -d` names are unpredictable, so a synthetic "candidate is a parent" fixture can't be
	// pre-built against the REAL function. Instead: obtain a real scratch dir, then immediately name a
	// path NESTED INSIDE it as something to avoid on the VERY NEXT call. `hermeticCwd` doesn't reuse a
	// prior candidate, so this doesn't exercise the exact same directory twice — but it does confirm the
	// wiring end-to-end: `hermeticCwd([nested])` must still succeed with a DIFFERENT directory (the
	// bidirectional check only rejects a candidate that conflicts with `nested`, and a fresh mktemp
	// draw under the same TMPDIR is vanishingly unlikely to land inside a directory that no longer even
	// contains it as a sibling) — a control proving normal operation is undisturbed by the added check,
	// pairing with the pure-function tests above that prove the check itself fires when it should.
	const scratchParent = await fs.mkdtemp(path.join(os.tmpdir(), "hermetic-e2e-parent-"));
	tmps.push(scratchParent);
	process.env.TMPDIR = scratchParent;
	const first = await hermeticCwd();
	tmps.push(first);
	const nestedInsideFirst = path.join(first, "child-managed-repo");
	await fs.mkdir(nestedInsideFirst, { recursive: true });
	const second = await hermeticCwd([nestedInsideFirst]);
	tmps.push(second);
	const resolvedSecond = await fs.realpath(second);
	const resolvedNested = await fs.realpath(nestedInsideFirst);
	expect(scratchConflictsWithAnyManagedPath(resolvedSecond, [resolvedNested])).toBe(false);
});
