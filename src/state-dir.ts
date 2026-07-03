/**
 * Canonical state-dir resolution — THE single answer to "where does glance persist state?"
 * Every consumer (daemon state.json, access-token, daemon.lock, presence/leases registries,
 * proof store, agent sockets, managed worktrees) derives from this so cross-process
 * coordination always lands in ONE directory.
 *
 * Resolution order:
 *   1. `$GLANCE_STATE_DIR` / `$OMP_SQUAD_STATE_DIR` — env-compat mirrors the two prefixes,
 *      but BOTH are read here directly so hooks loaded into a raw omp session (which never
 *      import env-compat) honor either name too.
 *   2. `~/.glance` — if it exists (the new default, adopted once present).
 *   3. `~/.omp/squad` — if it exists (legacy installs keep their state; never orphaned).
 *   4. `~/.glance` — neither exists: fresh installs get the new path.
 *
 * The filesystem probe (2–4) is memoized per process so a mid-run `mkdir ~/.glance` cannot
 * flip the answer between two reads — presence, leases, proof, and sockets are cross-process
 * registries, and a mid-run flip would split them. The env branch is deliberately NOT
 * memoized: it is deterministic, and tests/embedders vary `OMP_SQUAD_STATE_DIR` per call.
 *
 * Mixed-version coexistence is safe by construction: an old globally-installed daemon and
 * its hooks keep writing `~/.omp/squad`; as long as that dir exists and `~/.glance` does
 * not, this resolver also answers `~/.omp/squad`. State only moves on a fresh install or an
 * explicit env override — there is intentionally NO automatic migration/copy of state files.
 */

import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let cachedDefault: string | undefined;

/** The two on-disk default candidates for a home dir (new first, legacy second). */
export function stateDirCandidates(home: string = os.homedir()): { glance: string; legacy: string } {
	return { glance: path.join(home, ".glance"), legacy: path.join(home, ".omp", "squad") };
}

/**
 * Pure resolution core — explicit env + home, no process globals, no memoization.
 * `resolveStateDir()` delegates here; tests drive it with temp homes.
 */
export function resolveStateDirFrom(env: { GLANCE_STATE_DIR?: string; OMP_SQUAD_STATE_DIR?: string }, home: string): string {
	const fromEnv = env.GLANCE_STATE_DIR || env.OMP_SQUAD_STATE_DIR;
	if (fromEnv) return fromEnv;
	const { glance, legacy } = stateDirCandidates(home);
	if (existsSync(glance)) return glance;
	if (existsSync(legacy)) return legacy;
	return glance;
}

/** The process-wide state dir (see module doc for the resolution order). */
export function resolveStateDir(): string {
	const fromEnv = process.env.GLANCE_STATE_DIR || process.env.OMP_SQUAD_STATE_DIR;
	if (fromEnv) return fromEnv;
	cachedDefault ??= resolveStateDirFrom({}, os.homedir());
	return cachedDefault;
}

/**
 * Every state root the agent guard must fence off: the resolved dir PLUS both default
 * locations — during a mixed-version window another daemon/hook may still be writing the
 * other one, and neither is ever legitimate agent territory. Deduped, resolution order kept.
 */
export function protectedStateRoots(home: string = os.homedir()): string[] {
	const { glance, legacy } = stateDirCandidates(home);
	return [...new Set([resolveStateDir(), glance, legacy])];
}
