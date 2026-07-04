/**
 * Gate execution plan — WHERE a verify/proof/regression gate runs.
 *
 * gateEnv (gate-env.ts) already keeps daemon secrets out of gate children, but the
 * process still shares the daemon's filesystem and network: agent-authored test code
 * can read ~/.omp, other checkouts, or call out. A hermetic docker sandbox closes that:
 * the gate command runs in a throwaway container with ONLY the worktree (and its parent
 * repo — a git worktree's `.git` file points into the main repo's gitdir) bind-mounted at
 * their host paths, the scrubbed env passed explicitly, and no network by default
 * (`OMP_SQUAD_GATE_SANDBOX_NETWORK` overrides, e.g. `bridge`).
 *
 * The sandbox is now the DEFAULT whenever docker is usable (probe cached per-process):
 *   - unset             → auto: sandbox with the default image if docker is present, else
 *                         a LEGIBLE host fallback (one-time warning + `sandboxed:false` on
 *                         the proof record); STRICT makes that fallback fail closed instead.
 *   - <image>           → always sandbox with that explicit image (honored as before).
 *   - `host`/`off`/`0`  → explicit opt-out: host exec, byte-identical to pre-sandbox behavior.
 *
 * Env knobs:
 *   - OMP_SQUAD_GATE_SANDBOX          image | `host`/`off`/`0`/`disable` (opt-out) | unset (auto)
 *   - OMP_SQUAD_GATE_SANDBOX_IMAGE    default image used in auto mode (falls back to DEFAULT_SANDBOX_IMAGE)
 *   - OMP_SQUAD_GATE_SANDBOX_DISABLE  truthy ⇒ force host exec (same as `=host`)
 *   - OMP_SQUAD_GATE_SANDBOX_STRICT   `1` ⇒ fail closed: refuse to run on the host if docker is absent
 *   - OMP_SQUAD_GATE_SANDBOX_NETWORK  container network (default `none`)
 *   - OMP_SQUAD_GATE_SANDBOX_USER     `--user` for the container (default: the daemon's uid:gid;
 *                                     set `root` to restore the old root-in-container behavior)
 *
 * Async planner: returns argv + env + whether it is sandboxed; the three gate spawn sites
 * await it and execute. Host mode is byte-identical to the pre-sandbox behavior. The image
 * must provide `bash` and the repo's toolchain (e.g. an `oven/bun` derivative for bun repos).
 */

import { gateEnv } from "./gate-env.ts";

export interface GateExec {
	argv: string[];
	env: Record<string, string>;
	/**
	 * True iff the command runs inside a hermetic docker container. A host-executed gate
	 * (`false`) is a WEAKER proof — it saw the daemon's real filesystem and network — and the
	 * proof record is stamped with this so an unsandboxed proof is never invisible trust.
	 */
	sandboxed: boolean;
	/** The image used when `sandboxed`; undefined for host exec. */
	image?: string;
}

/** Sane default sandbox image for a bun repo when docker is present and no image was named. */
export const DEFAULT_SANDBOX_IMAGE = "oven/bun:1";

/** Host-owned vars that must NOT leak into a container (they'd shadow the image's own). */
const HOST_ONLY = new Set(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]);

/** Values of OMP_SQUAD_GATE_SANDBOX that mean "explicitly run on the host" (opt-out). */
const HOST_SENTINELS = new Set(["host", "off", "0", "no", "false", "disable", "disabled", "none-host"]);

/** Thrown when STRICT is set but docker is unavailable — the gate must refuse, not silently host-run. */
export class GateSandboxUnavailableError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "GateSandboxUnavailableError";
	}
}

function isTruthy(v: string | undefined): boolean {
	const s = v?.trim().toLowerCase();
	return s === "1" || s === "true" || s === "yes" || s === "on";
}

/** Per-process cache of the docker-availability probe (a subprocess spawn is not free per-gate). */
let dockerProbeCache: Promise<boolean> | undefined;
let warnedHostFallback = false;

async function probeDockerReal(): Promise<boolean> {
	try {
		// `docker version` exits 0 only when the CLI can reach a running daemon (it queries the
		// SERVER version) — so exit-0 means containers can actually run, not just that a client exists.
		const proc = Bun.spawn(["docker", "version"], { stdout: "ignore", stderr: "ignore" });
		return (await proc.exited) === 0;
	} catch {
		return false; // docker binary absent ⇒ ENOENT ⇒ unavailable
	}
}

/** Docker usable on this host? Cached per-process; the first caller pays the probe cost. */
export function dockerAvailable(): Promise<boolean> {
	if (!dockerProbeCache) dockerProbeCache = probeDockerReal();
	return dockerProbeCache;
}

/** Reset the cached docker probe + one-time warning (tests only). */
export function resetGateSandboxState(): void {
	dockerProbeCache = undefined;
	warnedHostFallback = false;
}

function warnHostFallbackOnce(reason: string): void {
	if (warnedHostFallback) return;
	warnedHostFallback = true;
	// eslint-disable-next-line no-console
	console.warn(
		`[gate] ${reason} — running acceptance/verify/regression gates UNSANDBOXED on the daemon host: ` +
			`agent-authored test code sees the real filesystem and network, so proofs are WEAKER (records are ` +
			`stamped sandboxed:false). Install/start docker for a hermetic sandbox, set OMP_SQUAD_GATE_SANDBOX=<image> ` +
			`to force one, or OMP_SQUAD_GATE_SANDBOX_STRICT=1 to fail closed instead of falling back to the host.`,
	);
}

function hostPlan(command: string, env: Record<string, string>): GateExec {
	return { argv: ["bash", "-lc", command], env, sandboxed: false };
}

/**
 * The `--user` for the gate container. Containers default to root, and with the repo
 * bind-mounted that means every file the gate writes (build output, caches, lockfiles)
 * lands root-owned on the host — later host-side builds then die on EACCES trying to
 * clean them. Run as the daemon's own uid:gid so container writes are indistinguishable
 * from host writes. OMP_SQUAD_GATE_SANDBOX_USER overrides (any docker --user syntax;
 * `root` restores the old behavior).
 */
function sandboxUser(source: NodeJS.ProcessEnv): string | undefined {
	const override = source.OMP_SQUAD_GATE_SANDBOX_USER?.trim();
	if (override) return override;
	if (typeof process.getuid !== "function" || typeof process.getgid !== "function") return undefined;
	return `${process.getuid()}:${process.getgid()}`;
}

function sandboxPlan(command: string, cwd: string, image: string, source: NodeJS.ProcessEnv, env: Record<string, string>, mounts?: string[]): GateExec {
	const network = source.OMP_SQUAD_GATE_SANDBOX_NETWORK?.trim() || "none";
	const dirs = [...new Set([cwd, ...(mounts ?? [])])].filter(Boolean);
	const containerEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (!HOST_ONLY.has(key)) containerEnv[key] = value;
	}
	const user = sandboxUser(source);
	const argv = [
		"docker",
		"run",
		"--rm",
		"--init", // reap the bash -lc child tree so a killed gate doesn't leave zombies
		"--network",
		network,
		// The mapped uid has no passwd entry in most images, which resolves HOME to `/`
		// (unwritable as non-root); pin it to the container's always-writable /tmp.
		...(user ? ["--user", user, "-e", "HOME=/tmp"] : []),
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
	return { argv, env: { ...env }, sandboxed: true, image };
}

/**
 * Plan a gate run of `command` in `cwd`. `mounts` are extra dirs the command needs
 * (pass the main repo for a worktree cwd — its `.git` gitdir pointer lives there).
 *
 * Async because the auto (default) path probes docker availability once per process.
 * Throws GateSandboxUnavailableError only in STRICT mode when docker is unavailable.
 */
export async function gateExec(
	command: string,
	cwd: string,
	opts: { mounts?: string[]; source?: NodeJS.ProcessEnv; dockerProbe?: () => boolean | Promise<boolean> } = {},
): Promise<GateExec> {
	const source = opts.source ?? process.env;
	const env = gateEnv(source);
	const strict = isTruthy(source.OMP_SQUAD_GATE_SANDBOX_STRICT);
	const raw = source.OMP_SQUAD_GATE_SANDBOX?.trim();
	const disabled = isTruthy(source.OMP_SQUAD_GATE_SANDBOX_DISABLE) || (raw !== undefined && HOST_SENTINELS.has(raw.toLowerCase()));

	// Explicit opt-out. STRICT overrides it: its whole point is to never silently run on the host.
	if (disabled) {
		if (strict) throw new GateSandboxUnavailableError("OMP_SQUAD_GATE_SANDBOX_STRICT=1 conflicts with the host opt-out — refusing to run the gate unsandboxed (fail-closed)");
		return hostPlan(command, env);
	}

	// Explicit image ⇒ always sandbox with it, as before (no probe — the operator asked for it).
	if (raw) return sandboxPlan(command, cwd, raw, source, env, opts.mounts);

	// Auto (default): sandbox if docker is usable, else a legible host fallback (or fail closed under STRICT).
	const available = await (opts.dockerProbe ? opts.dockerProbe() : dockerAvailable());
	if (available) {
		const image = source.OMP_SQUAD_GATE_SANDBOX_IMAGE?.trim() || DEFAULT_SANDBOX_IMAGE;
		return sandboxPlan(command, cwd, image, source, env, opts.mounts);
	}
	if (strict) throw new GateSandboxUnavailableError("OMP_SQUAD_GATE_SANDBOX_STRICT=1 but docker is unavailable — refusing to run the gate on the host (fail-closed)");
	warnHostFallbackOnce("docker is unavailable");
	return hostPlan(command, env);
}
