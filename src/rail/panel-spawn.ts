/**
 * Bounded, hermetic, process-group-aware CLI spawn for the gauntlet panel (T5 gauntlet round 1,
 * glance#333 — clusters B and C). Deliberately bypasses `src/omp-call.ts`'s `ompOneShot`/`decideTyped`
 * (the shared one-shot helper every OTHER judge/planner call site uses): those only ever kill the
 * DIRECT child on timeout and inherit the daemon's own `cwd`, which is exactly wrong for a panel
 * reviewer — see the findings below. Widening `ompOneShot` itself would touch every other call site's
 * blast radius for a fix that only the panel needs.
 *
 * B2 (HIGH, both lineages): `AbortSignal.timeout` (what `ompOneShot` uses) kills the DIRECT CLI process
 * but not its process TREE — codex reproduced a grandchild surviving under PPID 1, keeping a stdout
 * pipe read pending forever. Fix: every reviewer/recheck CLI here is spawned `detached: true` (POSIX
 * `setsid()` — the child becomes its own session AND process-group leader), so a timeout kills the
 * WHOLE GROUP via `process.kill(-pid, signal)`, SIGTERM first with a short grace period then SIGKILL,
 * and the caller stops awaiting the stdout pipe at the deadline (a leaked grandchild's still-open pipe
 * can no longer wedge the function past its own bound).
 *
 * B4 (HIGH): panel concurrency was globally unbounded — `panelMax()` bounds ONE panel invocation, not
 * the daemon process, so N concurrent lands each spawn their own panel. `withGlobalPanelSlot` is a
 * process-wide semaphore every spawn here acquires before running and releases once the process is
 * CONFIRMED dead (not merely "the function returned") — bounding real concurrent OS processes, not
 * just in-flight promises.
 *
 * C3 (HIGH, both lineages): a reviewer subprocess spawned with no explicit `cwd` inherits the DAEMON's
 * launch directory — for an agentic CLI (codex/grok/omp can all read files, not just the argv they were
 * given) that IS the managed repo, so AGENTS.md / plan docs / commit messages / `.git` history leak the
 * builder's own framing even though argv+diff are clean, defeating blind review entirely. Fix: every
 * spawn here runs with `cwd` pointed at a FRESH, EMPTY scratch directory containing no repo, no
 * history, nothing to discover. Honesty, not a blanket claim: grok's `--sandbox read-only` is Landlock-
 * enforced at the kernel level (per this project's own model policy notes) — combined with an empty
 * cwd it is genuinely hermetic. codex's `-s read-only` sandbox plus an empty cwd is also expected to be
 * hermetic (no repo present to read), but is a CLI-level sandbox, not a kernel one. `omp` has no
 * sandbox flag at all in this codebase — the empty cwd is a real, meaningful mitigation (it can no
 * longer casually `ls .` into a real repo), but a sufficiently agentic run COULD still probe an
 * absolute path if it somehow guessed one; `omp` is therefore the LEAST hermetic of the three and is
 * documented as such rather than claimed fully blind.
 */

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

/** A fresh, empty scratch directory with no repo, no history, nothing an agentic reviewer could
 *  discover by exploring its own `cwd` — the caller MUST remove it when the run (or panel) is done. */
export async function hermeticCwd(): Promise<string> {
	try {
		const proc = Bun.spawn(["mktemp", "-d"], { stdout: "pipe", stderr: "ignore" });
		const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		const dir = out.trim();
		if (code === 0 && dir) return dir;
	} catch {
		/* fall through to the manual fallback below */
	}
	// mktemp is POSIX-universal in this codebase's target environments, but degrade gracefully rather
	// than ever fail a panel over a missing coreutil.
	const dir = `${process.env.TMPDIR ?? "/tmp"}/glance-panel-hermetic-${crypto.randomUUID()}`;
	await Bun.write(`${dir}/.keep`, "");
	return dir;
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
async function killProcessGroup(pid: number, exited: Promise<number>): Promise<void> {
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		return; // already gone (ESRCH) — nothing left to escalate against
	}
	const GRACE_MS = 2_000;
	const stillAlive = await Promise.race([exited.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), GRACE_MS))]);
	if (!stillAlive) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		/* already gone between the grace check and here — fine */
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
			void killProcessGroup(proc.pid, exited)
				.catch(() => {})
				.finally(release);
			return { out: "", code: 1, timedOut: true };
		}
		release();
		return { ...result, timedOut: false };
	} catch {
		void killProcessGroup(proc.pid, exited)
			.catch(() => {})
			.finally(release);
		return { out: "", code: 1, timedOut: false };
	} finally {
		if (timer) clearTimeout(timer);
	}
}
