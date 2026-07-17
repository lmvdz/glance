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
 *   - OMP_SQUAD_GATE_SANDBOX_IMAGE    default image used in auto mode (unset ⇒ DERIVED_SANDBOX_IMAGE,
 *                                     the git-enabled local build of DEFAULT_SANDBOX_IMAGE)
 *   - OMP_SQUAD_GATE_SANDBOX_DISABLE  truthy ⇒ force host exec (same as `=host`)
 *   - OMP_SQUAD_GATE_SANDBOX_STRICT   `1` ⇒ fail closed: refuse to run on the host if docker is absent
 *   - OMP_SQUAD_GATE_SANDBOX_NETWORK  container network (default `none`)
 *   - OMP_SQUAD_GATE_SANDBOX_USER     `--user` for the container (default: the daemon's uid:gid;
 *                                     set `root` to restore the old root-in-container behavior)
 *
 * Per-call overrides: `gateExec`/`execGatedCommand` also accept an `opts.network` and `opts.env`
 * for the ONE call, layered on top of everything above — `opts.network` beats
 * `OMP_SQUAD_GATE_SANDBOX_NETWORK` for that call only (used by validate.ts's acceptance worker,
 * whose `flue run` needs real network), and `opts.env` replaces the computed `gateEnv(source)`
 * for callers that enforce their own narrower scrub. Precedence note for operators: a per-call
 * `network` override wins even over an explicit gate-wide `OMP_SQUAD_GATE_SANDBOX_NETWORK=none` —
 * it is a scoped, documented widening for that one caller, never a change to the shared default.
 *
 * Async planner: returns argv + env + whether it is sandboxed; the three gate spawn sites
 * await it and execute. Host mode is byte-identical to the pre-sandbox behavior.
 *
 * IMAGE CONTRACT (empirical): the image must be able to run the repo's own verify command end to
 * end — concretely, every binary in {@link SUITE_BINARIES}. Git is not optional (the gate cwd is a
 * git WORKTREE — the main repo is bind-mounted precisely so `.git` gitdir resolution works inside
 * the container — and this repo has ~85 `Bun.spawn(["git", ...])` test sites); jq drives the
 * repo's own hook scripts; npm is what detectPackageManager hands the regression gate for non-bun
 * lockfile shapes. Two incidents proved the failure mode: ompsq-432 (`oven/bun:1` has no git —
 * every gated verify died with `Executable not found in $PATH: "git"` while passing on the host,
 * burning the unit's whole codefix→fixup→escalate cascade) and ompsq-434 (no jq — the
 * continue-loop hook's stdout parsed as EOF-empty). Auto mode therefore derives
 * {@link DERIVED_SANDBOX_IMAGE} (base + suite deps) locally at first use; an operator-named image
 * (`OMP_SQUAD_GATE_SANDBOX=<image>` / `OMP_SQUAD_GATE_SANDBOX_IMAGE`) is honored verbatim and
 * must satisfy the contract itself.
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
	/**
	 * True when auto mode WANTED the suite-deps derived image but its build failed and the plan
	 * fell back to the bare base image (missing git/jq/npm). A failed gate in a degraded sandbox
	 * is presumptively an ENVIRONMENT failure, not a code failure — {@link gateRunUnrunnable}
	 * consumes this so land paths refuse (retryable) instead of misreading it as a red baseline.
	 */
	degraded?: boolean;
}

/** Base sandbox image for a bun repo when docker is present and no image was named. */
export const DEFAULT_SANDBOX_IMAGE = "oven/bun:1";

/**
 * The image auto mode actually runs: {@link DEFAULT_SANDBOX_IMAGE} + the suite's real runtime
 * binaries, built locally at first use.
 *
 * EMPIRICAL RULE (how this list is maintained): the derived image must be able to run THIS repo's
 * own gate (`bun run check && bun run test`) end to end — that in-image green run is the
 * acceptance test, encoded as a live contract test in tests/gate-image.test.ts. Any NEW suite
 * dependency must be added to {@link SUITE_BINARIES} + the Dockerfile layer in
 * `buildDerivedImageReal` AND this tag bumped (the local build is cache-keyed by tag via
 * `docker image inspect`, so an un-bumped tag means already-provisioned hosts silently keep the
 * old image without the new binary). The failure mode when a binary is missing is worse than a
 * red loop: the gate dies IDENTICALLY on both the merged and base runs (exit 127), which the
 * regression gate used to read as "same pre-existing red baseline" and FAIL OPEN — merging
 * unverified code (see land.ts's unrunnable-gate guard, added alongside this).
 *
 * Discovered set, each with the incident/test that proved it:
 *   - git  ompsq-432: tests/harness-scorecard.test.ts:132 Bun.spawn(["git", ...]) — ~85 sites
 *   - jq   ompsq-434: scripts/continue-loop.sh (driven by tests/continue-loop-hook.test.ts)
 *   - npm  tests/land-pr.test.ts NEW_RED fixture: detectPackageManager legitimately resolves npm,
 *          and the regression gate then runs `npm run …` inside the sandbox
 */
export const DERIVED_SANDBOX_IMAGE = "glance-gate:bun1-v2";

/** Binaries this repo's suite empirically requires inside the gate image (see the rule above). */
export const SUITE_BINARIES = ["bash", "bun", "git", "jq", "npm"] as const;

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

/** Reset the cached docker probe + derived-image build + one-time warnings (tests only). */
export function resetGateSandboxState(): void {
	dockerProbeCache = undefined;
	warnedHostFallback = false;
	derivedImageCache = undefined;
	warnedGitlessFallback = false;
}

/** Per-process memo of the derived-image build (docker's own image store is the cross-process cache). */
let derivedImageCache: Promise<string> | undefined;
let warnedGitlessFallback = false;

function warnGitlessFallbackOnce(detail: string): void {
	if (warnedGitlessFallback) return;
	warnedGitlessFallback = true;
	// eslint-disable-next-line no-console
	console.warn(
		`[gate] failed to build the suite-deps sandbox image ${DERIVED_SANDBOX_IMAGE} (from ${DEFAULT_SANDBOX_IMAGE}) — ` +
			`falling back to the bare base image, which lacks ${SUITE_BINARIES.filter((b) => b !== "bash" && b !== "bun").join("/")}: gates that spawn them fail ` +
			`deterministically ('Executable not found in $PATH'), and a gate command dying identically on merged+base ` +
			`can slip past the regression comparison. Fix the build (network/registry) or set ` +
			`OMP_SQUAD_GATE_SANDBOX_IMAGE to an image that satisfies the contract. Build error: ${detail.slice(0, 400)}`,
	);
}

/**
 * Build (once) and return the git-enabled default gate image. Fast path: the image already exists
 * in the local docker store from a previous daemon run — `docker image inspect` is cheap and
 * offline. Slow path: one `docker build` from an inline Dockerfile (base + git via apt, layer
 * cache makes reruns free). On ANY build failure this degrades to the bare base image with a
 * one-time legible warning naming the exact consequence — never a hard error, so an offline host
 * keeps the pre-derivation behavior instead of losing its sandbox entirely.
 */
export function defaultGateImage(): Promise<string> {
	if (!derivedImageCache) derivedImageCache = buildDerivedImageReal();
	return derivedImageCache;
}

async function buildDerivedImageReal(): Promise<string> {
	try {
		const inspect = Bun.spawn(["docker", "image", "inspect", DERIVED_SANDBOX_IMAGE], { stdout: "ignore", stderr: "ignore" });
		if ((await inspect.exited) === 0) return DERIVED_SANDBOX_IMAGE;
		// git+jq are tiny; npm (pulled with node) is the price of detectPackageManager legitimately
		// resolving npm-driven gates (see the SUITE_BINARIES doc). Bump DERIVED_SANDBOX_IMAGE when
		// this layer changes, or provisioned hosts keep serving the old image forever.
		const dockerfile = `FROM ${DEFAULT_SANDBOX_IMAGE}\nRUN apt-get update && apt-get install -y --no-install-recommends git jq npm && rm -rf /var/lib/apt/lists/*\n`;
		const build = Bun.spawn(["docker", "build", "-t", DERIVED_SANDBOX_IMAGE, "-"], {
			stdin: new TextEncoder().encode(dockerfile),
			stdout: "ignore",
			stderr: "pipe",
		});
		const stderr = await new Response(build.stderr).text();
		if ((await build.exited) === 0) return DERIVED_SANDBOX_IMAGE;
		warnGitlessFallbackOnce(stderr.trim() || "docker build exited non-zero");
	} catch (err) {
		warnGitlessFallbackOnce(String(err)); // String(Error) keeps "Error: <message>" — fine for a warning detail
	}
	return DEFAULT_SANDBOX_IMAGE;
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

function hostPlan(command: string, env: Record<string, string>, hostArgv?: string[]): GateExec {
	// `bash -lc` is a LOGIN shell: with HOME in env it sources /etc/profile + ~/.bash_profile, so
	// profile-exported secrets re-enter a caller's deny-by-default env scrub exactly in the
	// unsandboxed case it matters most. Callers that hold a real argv (validate.ts's commissioning
	// gate) pass `hostArgv` to spawn direct, no shell — the container path is unaffected (its env is
	// scrubbed and no operator profile exists in the image).
	return { argv: hostArgv ?? ["bash", "-lc", command], env, sandboxed: false };
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

function sandboxPlan(
	command: string,
	cwd: string,
	image: string,
	source: NodeJS.ProcessEnv,
	env: Record<string, string>,
	mounts?: string[],
	networkOverride?: string,
): GateExec {
	// A per-call override (validate.ts's acceptance worker) beats the gate-wide env var; lint/typecheck
	// callers never pass one, so they still get the gate-wide OMP_SQUAD_GATE_SANDBOX_NETWORK default.
	const network = networkOverride?.trim() || source.OMP_SQUAD_GATE_SANDBOX_NETWORK?.trim() || "none";
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
	opts: {
		mounts?: string[];
		source?: NodeJS.ProcessEnv;
		dockerProbe?: () => boolean | Promise<boolean>;
		imageBuilder?: () => Promise<string>;
		/**
		 * Override the child env instead of computing it from `gateEnv(source)`. Callers that already
		 * enforce a NARROWER (deny-by-default) env of their own — validate.ts's commissioning gate,
		 * whose `acceptanceEnv`/`baselineEnv` scrub is stricter than gate-env's pass-through-minus-secrets
		 * — pass their own env here so the sandbox/host plan never widens back out to gateEnv's set.
		 */
		env?: Record<string, string>;
		/**
		 * Per-call container network, beating `OMP_SQUAD_GATE_SANDBOX_NETWORK` for THIS call only.
		 * Used by validate.ts's acceptance worker (its `flue run` makes real model/network calls);
		 * every other caller omits this and gets the gate-wide setting (default `none`).
		 */
		network?: string;
		/**
		 * Argv-direct host fallback: when the plan degrades to the HOST (docker unavailable or
		 * explicitly disabled), spawn THIS argv instead of `bash -lc <command>` — a login shell
		 * re-imports profile-exported secrets past a caller's own env scrub. Ignored on the
		 * container path.
		 */
		hostArgv?: string[];
	} = {},
): Promise<GateExec> {
	const source = opts.source ?? process.env;
	const env = opts.env ?? gateEnv(source);
	const strict = isTruthy(source.OMP_SQUAD_GATE_SANDBOX_STRICT);
	const raw = source.OMP_SQUAD_GATE_SANDBOX?.trim();
	const disabled = isTruthy(source.OMP_SQUAD_GATE_SANDBOX_DISABLE) || (raw !== undefined && HOST_SENTINELS.has(raw.toLowerCase()));

	// Explicit opt-out. STRICT overrides it: its whole point is to never silently run on the host.
	if (disabled) {
		if (strict) throw new GateSandboxUnavailableError("OMP_SQUAD_GATE_SANDBOX_STRICT=1 conflicts with the host opt-out — refusing to run the gate unsandboxed (fail-closed)");
		return hostPlan(command, env, opts.hostArgv);
	}

	// Explicit image ⇒ always sandbox with it, as before (no probe — the operator asked for it).
	if (raw) return sandboxPlan(command, cwd, raw, source, env, opts.mounts, opts.network);

	// Auto (default): sandbox if docker is usable, else a legible host fallback (or fail closed under STRICT).
	const available = await (opts.dockerProbe ? opts.dockerProbe() : dockerAvailable());
	if (available) {
		// Operator-named default image: honored verbatim (it must satisfy the IMAGE CONTRACT itself).
		// Built-in default: the git-enabled derivative, built locally at first use — the bare base
		// image has no git, which is fatal to any real gate (see the header + ompsq-432).
		const named = source.OMP_SQUAD_GATE_SANDBOX_IMAGE?.trim();
		const image = named || (await (opts.imageBuilder ? opts.imageBuilder() : defaultGateImage()));
		const plan = sandboxPlan(command, cwd, image, source, env, opts.mounts, opts.network);
		// The builder resolves the bare base image ONLY on build failure — mark the plan degraded so
		// callers (gateRunUnrunnable) can refuse to trust a failed run in it instead of misreading a
		// missing-binary death as a code failure.
		if (!named && image === DEFAULT_SANDBOX_IMAGE) plan.degraded = true;
		return plan;
	}
	if (strict) throw new GateSandboxUnavailableError("OMP_SQUAD_GATE_SANDBOX_STRICT=1 but docker is unavailable — refusing to run the gate on the host (fail-closed)");
	warnHostFallbackOnce("docker is unavailable");
	return hostPlan(command, env, opts.hostArgv);
}

/**
 * Plan (via {@link gateExec}) AND run `command` in `cwd`, returning its captured result — the single
 * path every gate that executes agent-authored scripts should use, so the scrubbed env + sandbox are
 * never accidentally skipped. `mounts` forwards extra dirs the command needs (pass the main repo for a
 * worktree cwd). Used by the main regression gate and the workflow `verify` command node.
 */
export async function execGatedCommand(
	command: string,
	cwd: string,
	opts: { mounts?: string[]; env?: Record<string, string>; network?: string; hostArgv?: string[] } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	const plan = await gateExec(command, cwd, { mounts: opts.mounts, env: opts.env, network: opts.network, hostArgv: opts.hostArgv });
	const proc = Bun.spawn(plan.argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: plan.env });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { code: await proc.exited, stdout, stderr };
}

// ── Unrunnable-gate classifier ─────────────────────────────────────────────────────────────────

/** The slice of a gate run the classifier consumes (matches land.ts's runGate shape + `degraded`). */
export interface GateRunLike {
	code: number;
	output: string;
	/** From the plan (GateExec.degraded): the sandbox fell back to the bare base image. */
	degraded?: boolean;
}

/** Executable-resolution failure shapes across the shells/runtimes gates run under (bash, sh, Bun). */
const NOT_FOUND_RE = /Executable not found in \$PATH|command not found|not found in \$PATH|is not recognized as an internal or external command/i;
/** bun test's explicit nothing-ran markers. Deliberately narrow — only confidently parseable shapes. */
export const ZERO_TESTS_RE = /\bRan 0 tests\b|did not match any test files/i;
/** bun test's summary marker that at least one test demonstrably executed ("N pass", N ≥ 1). */
export const TESTS_RAN_RE = /\b[1-9]\d* pass\b/;

/**
 * Did this FAILED gate run demonstrably NOT exercise the code under test? Returns a human-readable
 * reason when the failure is an ENVIRONMENT failure (the command never really ran), undefined when
 * the run should be judged on its failures like any red suite.
 *
 * THE DESIGN PRINCIPLE (cross-review of the gate-image incident): a gate must fail CLOSED whenever
 * it demonstrably did not exercise the code. Exit 127 is one signal, not the definition — the same
 * missing-binary death can surface as a non-127 exit with an executable-not-found message (Bun
 * throws before the shell propagates 127), or as a red run inside a DEGRADED bare-base sandbox.
 * Both land paths that compare merged-vs-base failure sets (applyRegressionGate, verifyMerged's
 * red-baseline allowance) previously treated "identical failures on both sides" as a pre-existing
 * red baseline — but two identical ENVIRONMENT failures prove nothing about the code, and the land
 * silently proceeded unverified.
 *
 * Conservative by construction: if the output carries bun test's "N pass" (N ≥ 1) summary marker,
 * the suite demonstrably executed and this NEVER classifies the run as unrunnable — a real red
 * suite whose captured failure text happens to contain "command not found" (fixtures testing
 * missing-binary handling) is still judged on its failures, not misread as an env failure.
 */
export function gateRunUnrunnable(run: GateRunLike, command?: string): string | undefined {
	if (run.code === 0) return undefined; // green is green
	if (run.code === 127) return "exit 127 — the gate command itself could not execute (command not found)";
	if (TESTS_RAN_RE.test(run.output)) return undefined; // tests demonstrably ran — a real red, judge it on failures
	if (NOT_FOUND_RE.test(run.output)) return "gate output shows an executable-resolution failure and no test ever ran — the environment lacks a binary the gate needs";
	if (run.degraded) return `gate ran inside the DEGRADED bare sandbox image (${DEFAULT_SANDBOX_IMAGE} — the ${DERIVED_SANDBOX_IMAGE} build failed) and no test ever ran`;
	if (command && /\btest\b/.test(command) && ZERO_TESTS_RE.test(run.output)) return "test gate executed zero tests — the suite never ran";
	return undefined;
}

/**
 * Did this GREEN (exit 0) gate run demonstrably NOT exercise the code under test? The counterpart of
 * {@link gateRunUnrunnable} for the pass side: `gateRunUnrunnable` only classifies FAILED runs by
 * design ("code === 0 ⇒ green is green" is deliberately never second-guessed there). But a green
 * run can be just as unproven as a red one — a degraded bare-sandbox fallback or a test glob that
 * matched zero files both exit 0 while proving nothing.
 *
 * Finding #3 (code-review fixlist): the degraded check MUST run before the tests-ran short-circuit.
 * A degraded bare-image run where only a handful of the real suite resolves (missing deps, a
 * container that can't see most of the repo) can still print "N pass" for the tests that did
 * resolve and exit 0 — checking TESTS_RAN_RE first would trust that as a real pass. Degraded means
 * "this environment cannot be trusted," full stop, regardless of what its truncated output claims.
 *
 * Was previously private to land-pr.ts (PR-mode only) — moved here and exported so the LOCAL land
 * path (land.ts) can apply the same classifier instead of trusting any bare exit 0.
 */
export function greenGateUnproven(run: GateRunLike, command: string): string | undefined {
	if (run.degraded) return "gate ran inside the DEGRADED bare sandbox image and reported success — cannot trust an unverified environment as a pass";
	if (TESTS_RAN_RE.test(run.output)) return undefined; // tests demonstrably ran — trust the pass
	if (/\btest\b/.test(command) && ZERO_TESTS_RE.test(run.output)) return "test gate exited 0 but executed zero tests — the suite never ran";
	return undefined;
}
