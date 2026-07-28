/**
 * Well-known absolute install locations for coding-agent CLIs (omp, pi, claude, codex, grok, …) — a
 * PATH-augmentation fallback for a thin daemon PATH.
 *
 * The failure mode this exists for: the daemon is started (or respawned) via `nohup omp-squad up &`
 * from a non-interactive shell — a cron job, a bare `bash -c "..." &`, a supervisor respawn script —
 * that never sourced the user's shell profile. `process.env.PATH` then carries only whatever bare
 * default the parent process happened to have, missing every user-local install directory an
 * interactive terminal would have picked up (`~/.bun/bin`, `~/.local/bin`, …). A harness binary that
 * is very much installed, and resolves fine from a terminal, then reads as "not found" — both for
 * actually spawning it and for reporting whether it CAN be spawned.
 *
 * This is a fallback, never a substitution: the real PATH, however wide or narrow, is always kept —
 * these directories are only APPENDED, and only the ones not already present. A correctly-configured
 * wide PATH is completely unaffected; a custom install location outside this list still needs a real
 * PATH entry (this cannot and does not try to enumerate every possible install location).
 *
 * WHERE this is applied, and deliberately NOT applied: `applyWellKnownDirsToProcessPath` (below) is
 * called exactly ONCE, at the real daemon's actual boot (`index.ts`'s `cmdUp`, before anything spawns)
 * — widening `process.env.PATH` in place so every later spawn (`spawn-env.ts`'s `scrubbedSpawnEnv`,
 * `harness-registry.ts`'s `binResolvable`) inherits the widened value for free, with zero code changes
 * at those call sites. It is deliberately NOT wired into `scrubbedSpawnEnv` itself: that function is
 * shared by every unit test that constructs a `SquadManager`/`SquadServer` directly (bypassing `cmdUp`
 * entirely) and DELIBERATELY narrows `process.env.PATH` to simulate "this harness binary is absent"
 * for hermetic, fast fallback-path testing (e.g. `tests/spawn-route.test.ts`'s `pathWithGitButNoOmp`).
 * Augmenting inside `scrubbedSpawnEnv` itself would silently defeat every such test on any machine
 * that happens to have `omp` installed under one of these well-known dirs — which is every dev
 * machine, including this one — turning a deliberate, test-scoped absence back into a false presence.
 * `binResolvable`'s OWN direct fallback use is safe by contrast: it only affects a READ-ONLY honesty
 * label (`/api/harnesses`'s `binDetected`/tier), never which binary a spawn actually launches.
 */

import * as os from "node:os";
import * as path from "node:path";

/** Directories a coding-agent CLI (or the package manager that installed it) commonly puts its
 *  binaries in. Order doesn't affect detection (existence is boolean) — listed roughly by how often
 *  these tools land here in practice.
 *  `home` defaults to `process.env.HOME` (checked first — this is what a real spawned child's own
 *  HOME will be, and what a test can override deterministically) then `os.homedir()` (Bun's own
 *  implementation reads the OS user database rather than a live `process.env.HOME` mutation, so it
 *  is only the fallback, never the primary source). */
export function wellKnownBinDirs(home: string = process.env.HOME || os.homedir()): string[] {
	return [
		path.join(home, ".bun", "bin"),
		path.join(home, ".local", "bin"),
		path.join(home, ".claude", "local"),
		path.join(home, ".volta", "bin"),
		path.join(home, ".grok", "bin"),
		path.join(home, ".cargo", "bin"),
		path.join(home, ".npm-global", "bin"),
		"/usr/local/bin",
		"/opt/homebrew/bin",
	];
}

/**
 * `rawPath` (typically `process.env.PATH`) with every well-known bin dir appended that isn't already
 * present — a thin PATH gets padded out; a wide one comes back with only the directories it was
 * actually missing added on the end, so the relative order of everything already there is undisturbed
 * (and anything the real PATH already resolves keeps winning, since it's still searched first).
 */
export function augmentPathWithWellKnownDirs(rawPath: string | undefined, home: string = process.env.HOME || os.homedir()): string {
	const existing = (rawPath ?? "").split(path.delimiter).filter(Boolean);
	const have = new Set(existing);
	const additions = wellKnownBinDirs(home).filter((d) => !have.has(d));
	return [...existing, ...additions].join(path.delimiter);
}

/**
 * Widens `env.PATH` in place, once — the real daemon boot call (`index.ts`'s `cmdUp`, first line,
 * before anything spawns). Defaults to mutating the live `process.env` so the daemon's own PATH is
 * fixed for the rest of its life; takes an explicit `env` only so this is unit-testable without
 * touching the real process environment.
 */
export function applyWellKnownDirsToProcessPath(env: NodeJS.ProcessEnv = process.env): void {
	env.PATH = augmentPathWithWellKnownDirs(env.PATH, env.HOME);
}
