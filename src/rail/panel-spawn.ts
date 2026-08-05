/**
 * Bounded, hermetic, process-group-aware CLI spawn for the gauntlet panel (T5 gauntlet round 1,
 * glance#333 — clusters B and C). Deliberately bypasses `src/omp-call.ts`'s `ompOneShot`/`decideTyped`
 * (the shared one-shot helper every OTHER judge/planner call site uses): those only ever kill the
 * DIRECT child on timeout and inherit the daemon's own `cwd`, which is exactly wrong for a panel
 * reviewer — see the findings below. Widening `ompOneShot` itself would touch every other call site's
 * blast radius for a fix that only the panel needs.
 *
 * B2 (HIGH, both lineages, round 1 fix INCOMPLETE — closed properly in round 2): `AbortSignal.timeout`
 * (what `ompOneShot` uses) kills the DIRECT CLI process but not its process TREE — codex reproduced a
 * grandchild surviving under PPID 1, keeping a stdout pipe read pending forever. Round 1 spawned every
 * reviewer/verification CLI `detached: true` (its own process group) and killed the group on timeout —
 * but RACED the SIGKILL escalation against the group LEADER's own `exited` promise, so if the leader
 * died from SIGTERM while a DESCENDANT ignored SIGTERM and kept the group alive, the race resolved
 * "not still alive" (the LEADER was gone) and SIGKILL was never sent to the survivor. Round 2 fix:
 * `killProcessGroup` now waits out the FULL grace period unconditionally and ALWAYS sends SIGKILL to
 * the whole group afterward, regardless of whether the leader itself already exited — a SIGKILL to an
 * already-fully-gone group is harmless (ESRCH, caught). Applies to BOTH the reviewer call and the
 * claim-verification call, since both share this one spawn primitive.
 *
 * B4 (HIGH): panel concurrency was globally unbounded — `panelMax()` bounds ONE panel invocation, not
 * the daemon process, so N concurrent lands each spawn their own panel. `withGlobalPanelSlot` is a
 * process-wide semaphore every spawn here acquires before running and releases once the process is
 * CONFIRMED dead (not merely "the function returned") — bounding real concurrent OS processes, not
 * just in-flight promises.
 *
 * C3 (HIGH, both lineages, round 1 fix INCOMPLETE — hardened in round 2): a reviewer subprocess spawned
 * with no explicit `cwd` inherits the DAEMON's launch directory — for an agentic CLI (codex/grok/omp can
 * all read files, not just the argv they were given) that IS the managed repo, so AGENTS.md/plan docs/
 * commit messages/`.git` history leak the builder's own framing even though argv+diff are clean,
 * defeating blind review entirely. Round 1's `hermeticCwd()` trusted `mktemp`/`TMPDIR` blindly and its
 * fallback path left a non-empty `.keep` file behind. Round 2: the resolved directory is REALPATH'd and
 * validated to be outside `process.cwd()` AND every path the caller names as a managed repo/worktree
 * (`avoid`) before it is ever handed to a reviewer — a hostile/misconfigured `TMPDIR`, or a PATH-shadowed
 * `mktemp` binary, that would place the "scratch" cwd INSIDE a managed repo is rejected and retried
 * (bounded attempts), and if no valid candidate can be obtained at all, `hermeticCwd` THROWS rather than
 * silently handing a reviewer an unsafe cwd — fail closed, never fail open on the one property blind
 * review depends on. The fallback path no longer touches the directory's contents at all (no `.keep`),
 * so it stays genuinely empty. Honesty, not a blanket claim, is unchanged from round 1: grok's
 * `--sandbox read-only` is Landlock-enforced at the kernel level — combined with a validated empty cwd
 * it is genuinely hermetic. codex's `-s read-only` sandbox plus the validated empty cwd is CLI-level.
 * `omp` has no sandbox flag at all in this codebase — the validated empty cwd is a real, meaningful
 * mitigation, but `omp` remains the LEAST hermetic of the three and is documented as such.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { GIT_HARDEN_ENV } from "../git-harden.ts";
import { harnessAuthEnv, scrubbedSpawnEnv } from "../spawn-env.ts";

// ── process-wide concurrency limiter (B4) ───────────────────────────────────────────────────────────

/** Cap on SIMULTANEOUS reviewer/recheck subprocesses across the WHOLE daemon process — distinct from
 *  `panelMax()` (`panel.ts`), which only bounds ONE panel's own reviewer count. Off-topic env prefix
 *  reused deliberately (`OMP_SQUAD_REVIEW_PANEL_*`) so it reads as one flag family. */
function globalPanelConcurrencyMax(): number {
	const raw = Number(process.env.OMP_SQUAD_REVIEW_PANEL_GLOBAL_MAX);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 6;
}

let globalInFlight = 0;
const globalQueue: (() => void)[] = [];

function drainGlobalQueue(): void {
	if (globalInFlight >= globalPanelConcurrencyMax()) return;
	const next = globalQueue.shift();
	if (next) next();
}

/** Acquire one of the process-wide reviewer-subprocess slots; resolves once a slot is free (FIFO).
 *  Returns a release function — MUST be called exactly once, and only once the underlying OS process
 *  is actually gone (never merely "the caller stopped waiting on it"), or the limiter undercounts real
 *  resource pressure. */
function acquireGlobalPanelSlot(): Promise<() => void> {
	return new Promise((resolve) => {
		const grant = (): void => {
			globalInFlight++;
			let released = false;
			resolve(() => {
				if (released) return; // idempotent — a double-release must never double-free a slot
				released = true;
				globalInFlight--;
				drainGlobalQueue();
			});
		};
		if (globalInFlight < globalPanelConcurrencyMax()) grant();
		else globalQueue.push(grant);
	});
}

/** @substrate exported for tests only — asserts the limiter actually bounds concurrency without racing
 *  real subprocesses. */
export function globalPanelInFlightForTests(): number {
	return globalInFlight;
}
/** @substrate exported for tests only. */
export function resetGlobalPanelLimiterForTests(): void {
	globalInFlight = 0;
	globalQueue.length = 0;
}

// ── hermetic cwd (C3) ────────────────────────────────────────────────────────────────────────────────

const HERMETIC_CWD_ATTEMPTS = 3;

/** One candidate scratch directory, via `mktemp -d` (preferred — atomic, race-free creation) or a
 *  manual fallback (a random-named directory under `TMPDIR`/`/tmp`) if `mktemp` is missing. The
 *  fallback creates ONLY the directory itself — no placeholder file — so it stays genuinely empty
 *  (round 1 left a `.keep` file behind here, a real if minor honesty gap in the "empty" claim). */
async function rawScratchDir(): Promise<string> {
	try {
		// `env` must be passed EXPLICITLY: `Bun.spawn`'s default env is a snapshot taken at Bun's own
		// process startup, not a live reference to `process.env` — a runtime mutation (a test setting
		// `TMPDIR`, or a genuinely hostile deployment environment) would otherwise silently NOT be seen
		// by `mktemp`, defeating the very validation this module exists to perform.
		const proc = Bun.spawn(["mktemp", "-d"], { stdout: "pipe", stderr: "ignore", env: process.env });
		const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		const dir = out.trim();
		if (code === 0 && dir) return dir;
	} catch {
		/* fall through to the manual fallback below */
	}
	// mktemp is POSIX-universal in this codebase's target environments, but degrade gracefully rather
	// than ever fail a panel over a missing coreutil.
	const dir = path.join(process.env.TMPDIR ?? "/tmp", `glance-panel-hermetic-${crypto.randomUUID()}`);
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

/** Resolve `p` to its real, symlink-free absolute path — falling back to a plain `path.resolve` if the
 *  path doesn't exist yet or can't be stat'd (never throws), so a validation comparison always has
 *  SOMETHING concrete to compare against rather than aborting. */
async function realOrResolved(p: string): Promise<string> {
	try {
		return await fs.realpath(p);
	} catch {
		return path.resolve(p);
	}
}

function isInside(candidate: string, ancestor: string): boolean {
	return candidate === ancestor || candidate.startsWith(ancestor.endsWith(path.sep) ? ancestor : `${ancestor}${path.sep}`);
}

/**
 * T5 gauntlet round 3 (glance#356, finding #6): `isInside` alone only rejects a candidate that is
 * INSIDE (or equal to) a managed path — it said nothing about the opposite containment. A candidate
 * that is a PARENT of a managed repo is exactly as unsafe: an agentic reviewer exploring its own `cwd`
 * can walk `..`/list siblings and discover the managed repo living a few directories below, even though
 * the candidate itself started out empty. Both directions must be rejected — `isInside(candidate,
 * managed)` (candidate is inside/is the managed path) OR `isInside(managed, candidate)` (the managed
 * path is inside/is the candidate — candidate is an ancestor of it).
 */
function conflictsWithManaged(candidate: string, managed: string): boolean {
	return isInside(candidate, managed) || isInside(managed, candidate);
}

/** @substrate exported for a direct, deterministic unit test of the bidirectional containment rule —
 *  real mktemp/TMPDIR randomness can't reliably construct a "candidate is a PARENT of a managed repo"
 *  fixture on demand, so the pure predicate itself is the testable surface. */
export function scratchConflictsWithAnyManagedPath(candidate: string, avoid: string[]): boolean {
	return avoid.some((a) => conflictsWithManaged(candidate, a));
}

/**
 * A fresh, empty scratch directory with no repo, no history, nothing an agentic reviewer could
 * discover by exploring its own `cwd` — VALIDATED (gauntlet round 2, finding C3) to resolve outside
 * `process.cwd()` (the daemon's own launch directory — the original C3 threat model) AND every path in
 * `avoid` (the specific repo/worktree a caller is reviewing, when known — round 3, finding #6: callers
 * now pass the COMPLETE registered-repo set, not just the one land in progress). A hostile/misconfigured
 * `TMPDIR`, or a PATH-shadowed `mktemp` binary, that would otherwise place the "scratch" cwd INSIDE a
 * managed repo — OR make the scratch cwd a PARENT of one (round 3, finding #6: the reverse containment
 * is equally unsafe, see `conflictsWithManaged` above) — is rejected (the rejected candidate is cleaned
 * up) and retried up to `HERMETIC_CWD_ATTEMPTS` times; if no valid candidate can be obtained at all, this
 * THROWS rather than ever handing a reviewer a cwd that might leak the tree it's supposed to be blind to
 * (fail closed — every caller in this file already treats a thrown/rejected review as an honest "error"
 * verdict, never a fabricated one). The caller MUST remove the returned directory (`removeHermeticCwd`)
 * when done.
 */
export async function hermeticCwd(avoid: string[] = []): Promise<string> {
	const avoidResolved = await Promise.all([process.cwd(), ...avoid].map(realOrResolved));
	let lastRejected: string | undefined;
	for (let attempt = 0; attempt < HERMETIC_CWD_ATTEMPTS; attempt++) {
		const dir = await rawScratchDir();
		const resolved = await realOrResolved(dir);
		if (!scratchConflictsWithAnyManagedPath(resolved, avoidResolved)) return dir;
		lastRejected = resolved;
		await removeHermeticCwd(dir);
	}
	throw new Error(`hermeticCwd: could not obtain a scratch directory outside every managed repo after ${HERMETIC_CWD_ATTEMPTS} attempts (last rejected candidate resolved inside/around a managed path: ${lastRejected}) — refusing to hand a reviewer a cwd that might leak the tree`);
}

export async function removeHermeticCwd(dir: string): Promise<void> {
	try {
		await Bun.spawn(["rm", "-rf", "--", dir]).exited;
	} catch {
		/* best-effort cleanup — a leaked scratch dir is not a correctness issue */
	}
}

// ── process-group-bounded spawn (B2) ────────────────────────────────────────────────────────────────

export interface BoundedSpawnOpts {
	bin: string;
	args: string[];
	cwd: string;
	/** Harness name for auth-var scoping (`harnessAuthEnv`) — mirrors `ompOneShot`'s own env scrub. */
	harness?: string;
	timeoutMs: number;
}

export interface BoundedSpawnResult {
	out: string;
	code: number;
	/** `true` when the bound was hit — `out`/`code` are then whatever was captured before the kill
	 *  decision (usually empty/irrelevant); the caller must treat this as "no answer", never scrape
	 *  a partial parse out of it. */
	timedOut: boolean;
}

/** SIGTERM the whole process group, give it a short grace period to exit cleanly, then SIGKILL the
 *  group if it's still alive. Fire-and-forget from the caller's perspective — the caller has ALREADY
 *  returned its timeout result by the time this settles; this only exists to release the concurrency
 *  slot and reap the OS process, never to feed the caller anything further. `pid` is the group leader's
 *  pid (the direct child's own pid, since it was spawned `detached: true`), so `-pid` addresses the
 *  whole group on POSIX. */
async function killProcessGroup(pid: number): Promise<void> {
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		return; // already gone (ESRCH) — nothing left to escalate against
	}
	// Round 2 fix (B2, both lineages): give the group a grace period, but NEVER decide whether to
	// escalate by racing the LEADER's own `exited` promise — the leader dying from SIGTERM does not
	// mean the whole process GROUP is gone (a descendant that ignores SIGTERM can survive after the
	// leader exits, and round 1's race resolved "not still alive" the instant the leader alone died,
	// so SIGKILL never reached that survivor). Wait out the FULL grace period unconditionally, then
	// ALWAYS send SIGKILL to the group — harmless (ESRCH, caught) if everything already exited on its
	// own during the grace window.
	await new Promise((r) => setTimeout(r, 2_000));
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		/* the whole group is already gone — fine, this was a mopping-up kill, not a required one */
	}
}

/**
 * Spawn `bin args` in a hermetic cwd, detached (its own process group), bounded by `timeoutMs`. Never
 * throws: a spawn fault (missing binary, permission error) resolves `{out:"", code:1, timedOut:false}`,
 * matching `ompOneShot`'s own never-throws contract. On timeout, the WHOLE process group is killed
 * (SIGTERM→SIGKILL escalation, `killProcessGroup` above) and this function returns immediately WITHOUT
 * awaiting the stdout pipe — a surviving grandchild holding that pipe open can therefore never wedge
 * the caller past `timeoutMs` (B2's explicit fix: "stop awaiting pipes at the deadline"). The kill/reap
 * continues in the background; the concurrency slot is released only once the process is confirmed
 * gone (or the grace period elapses), never merely when this promise resolves.
 */
/** Narrowly typed so `proc.stdout` is a concrete `ReadableStream` (a bare `Bun.spawn` call assigned to
 *  a pre-declared `ReturnType<typeof Bun.spawn>` picks the overload's widened `stdout` type, which
 *  `new Response(...)` can't accept) — the options object here pins every stdio field to a literal, so
 *  TS resolves the SPECIFIC overload instead of the generic fallback. */
function spawnPanelProcess(bin: string, args: string[], cwd: string, harness: string) {
	return Bun.spawn([bin, ...args], {
		cwd,
		detached: true,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
		env: scrubbedSpawnEnv(process.env, { ...GIT_HARDEN_ENV, ...harnessAuthEnv(process.env, harness) }),
	});
}

export async function boundedHermeticSpawn(opts: BoundedSpawnOpts): Promise<BoundedSpawnResult> {
	if (!Bun.which(opts.bin)) return { out: "", code: 1, timedOut: false };
	const release = await acquireGlobalPanelSlot();
	let proc: ReturnType<typeof spawnPanelProcess>;
	try {
		proc = spawnPanelProcess(opts.bin, opts.args, opts.cwd, opts.harness ?? opts.bin);
	} catch {
		release();
		return { out: "", code: 1, timedOut: false };
	}
	const exited = proc.exited;
	const outputPromise = Promise.all([new Response(proc.stdout).text(), exited]).then(([out, code]) => ({ out, code }));
	const TIMED_OUT = Symbol("bounded-spawn-timeout");
	let timer: ReturnType<typeof setTimeout> | undefined;
	const bound = new Promise<typeof TIMED_OUT>((resolve) => {
		timer = setTimeout(() => resolve(TIMED_OUT), opts.timeoutMs);
	});
	try {
		const result = await Promise.race([outputPromise, bound]);
		if (result === TIMED_OUT) {
			// Do NOT await the pipe/exit here — that is precisely the wedge B2 closes. Kill + release
			// continue in the background; this function returns now.
			void killProcessGroup(proc.pid)
				.catch(() => {})
				.finally(release);
			return { out: "", code: 1, timedOut: true };
		}
		release();
		return { ...result, timedOut: false };
	} catch {
		void killProcessGroup(proc.pid)
			.catch(() => {})
			.finally(release);
		return { out: "", code: 1, timedOut: false };
	} finally {
		if (timer) clearTimeout(timer);
	}
}
