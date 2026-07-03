/**
 * Gate execution plan — WHERE a verify/proof/regression gate runs.
 *
 * gateEnv (gate-env.ts) already keeps daemon secrets out of gate children, but the
 * process still shares the daemon's filesystem and network: agent-authored test code
 * can read ~/.omp, other checkouts, or call out. `OMP_SQUAD_GATE_SANDBOX=<image>`
 * closes that: the gate command runs in a throwaway container with ONLY the worktree
 * (and its parent repo — a git worktree's `.git` file points into the main repo's
 * gitdir) bind-mounted at their host paths, the scrubbed env passed explicitly, and
 * no network by default (`OMP_SQUAD_GATE_SANDBOX_NETWORK` overrides, e.g. `bridge`).
 *
 * Pure planner: returns argv + env; the three gate spawn sites execute it. Host mode
 * (unset) is byte-identical to the pre-sandbox behavior. The image must provide
 * `bash` and the repo's toolchain (e.g. an `oven/bun` derivative for bun repos).
 */

import { gateEnv } from "./gate-env.ts";

export interface GateExec {
	argv: string[];
	env: Record<string, string>;
}

/** Host-owned vars that must NOT leak into a container (they'd shadow the image's own). */
const HOST_ONLY = new Set(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]);

/**
 * Plan a gate run of `command` in `cwd`. `mounts` are extra dirs the command needs
 * (pass the main repo for a worktree cwd — its `.git` gitdir pointer lives there).
 */
export function gateExec(command: string, cwd: string, opts: { mounts?: string[]; source?: NodeJS.ProcessEnv } = {}): GateExec {
	const source = opts.source ?? process.env;
	const env = gateEnv(source);
	const image = source.OMP_SQUAD_GATE_SANDBOX?.trim();
	if (!image) return { argv: ["bash", "-lc", command], env };

	const network = source.OMP_SQUAD_GATE_SANDBOX_NETWORK?.trim() || "none";
	const dirs = [...new Set([cwd, ...(opts.mounts ?? [])])].filter(Boolean);
	const containerEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (!HOST_ONLY.has(key)) containerEnv[key] = value;
	}
	const argv = [
		"docker",
		"run",
		"--rm",
		"--init", // reap the bash -lc child tree so a killed gate doesn't leave zombies
		"--network",
		network,
		...dirs.flatMap((dir) => ["-v", `${dir}:${dir}`]),
		"-w",
		cwd,
		...Object.entries(containerEnv).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
		image,
		"bash",
		"-lc",
		command,
	];
	// The docker CLIENT still needs the host PATH/HOME to run at all.
	return { argv, env: { ...env } };
}
