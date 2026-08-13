/**
 * `requires.services` — the compose lifecycle for a gate that cannot run without a real service.
 *
 * R2 #384 sized this L and said why: the gate sandbox is `docker run --network none` with no compose
 * lifecycle, no healthcheck wait, and no teardown, so a tenant whose integration suite needs a
 * Postgres has exactly two options today, and both are wrong — skip the gate, or run it unsandboxed
 * against whatever database the daemon host happens to have.
 *
 * MINIMAL-HONEST is the brief, so this is deliberately the smallest thing that is not a lie:
 *   - one `docker compose up -d --wait` per gate, from a generated project file;
 *   - the wait is COMPOSE'S OWN healthcheck wait (`--wait` blocks until every service with a
 *     healthcheck reports healthy and fails non-zero on timeout) — not a sleep, not a port poll;
 *   - published ports are surfaced to the gate as `GLANCE_SERVICE_<NAME>_PORT` env, so the tenant's
 *     own scripts compose their DSN from values the rail can prove it published;
 *   - teardown runs `down -v --remove-orphans` on EVERY exit path, including refusal;
 *   - absence of docker, a failed `up`, or a service that never goes healthy are all a REFUSAL —
 *     never a fallback, never a skip.
 *
 * DECLARED-REFUSED (G2 #386's omission list, restated here so it is visible at the implementation):
 * Playwright runner provisioning is NOT implemented. A gate declaring `requires.runnerImage` on a
 * host that cannot provide it refuses with `runner-unavailable`; browsers are never fetched at gate
 * time. That is the honest state, and it fails closed.
 *
 * The spawner is injected so every fail-closed row is unit-testable without docker. Production
 * passes nothing and gets `Bun.spawn`.
 */

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { errText } from "./err-text.ts";
import { tenantGateEnv } from "./gate-env.ts";
import { dockerAvailable, runBounded } from "./gate-runner.ts";
import type { GateRefusal, TenantComposeService } from "./tenant-gates.ts";

/** A spawn result reduced to what this module judges on. Injected in tests. `timeoutMs` bounds the
 *  call (H-5): `up --wait` governs only Compose's own health-wait, so `down` and any real spawn need
 *  their own ceiling or a hung docker leaves the land wedged. */
export interface ServiceSpawnResult {
	code: number;
	output: string;
}
export type ServiceSpawn = (argv: string[], cwd: string, opts?: { timeoutMs?: number; env?: Record<string, string> }) => Promise<ServiceSpawnResult>;

/** Outcome of tearing a service project down. H-5: a failed `down` must BLOCK a green receipt — a
 *  gate that "passed" while its Postgres is still running has contaminated the host, so the caller
 *  turns `ok:false` here into a `service-unavailable` refusal rather than swallowing it. */
export interface ServiceStopResult {
	ok: boolean;
	detail?: string;
}

export interface ServiceHandle {
	/** The compose project name — also the container name prefix, for an operator hunting strays. */
	project: string;
	/** The compose network the gate container must JOIN to reach the services (round 3 High): with
	 *  `--network none` a gate can't reach 127.0.0.1:published-port, so the gate runs ON this network
	 *  and reaches each service by its service-name at its container-port. Empty ⇒ no services. */
	network: string;
	/** Env the gate command receives so it can reach the services — service-name host + container port,
	 *  resolvable on {@link network}. */
	env: Record<string, string>;
	/** Idempotent. Always called, including on the refusal paths. `ok:false` ⇒ containers may be
	 *  alive and the caller must not write a green receipt. */
	stop(): Promise<ServiceStopResult>;
}

export type ServiceStart = { ok: true; handle: ServiceHandle } | { ok: false; refusal: GateRefusal; stop: () => Promise<ServiceStopResult> };

/** Default teardown/health ceiling when a gate does not name a tighter one. */
const DEFAULT_SERVICE_TIMEOUT_MS = 120_000;

/**
 * Spawn `argv`, bounded by `timeoutMs` via {@link runBounded} (round 3 High): a single SIGTERM then
 * an unbounded await is not a bound (a child ignoring SIGTERM, or a docker grandchild holding the
 * stdio pipes open, hangs forever), so runBounded kills the process group, escalates to SIGKILL, and
 * resolves on a hard deadline independent of stream closure.
 */
async function realSpawn(argv: string[], cwd: string, opts?: { timeoutMs?: number; env?: Record<string, string> }): Promise<ServiceSpawnResult> {
	// C-2 (round 4): `docker compose` used to inherit the daemon's FULL process.env, so a tenant's
	// service definition could interpolate `${DATABASE_URL}` etc. into a container. When `env` is
	// provided (the compose lifecycle) it REPLACES the inherited env with the scrubbed allowlist, so
	// there is no secret left for compose to interpolate. Absent ⇒ inherit (legacy non-compose callers).
	const proc = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", ...(opts?.env ? { env: opts.env } : {}) });
	return runBounded(proc, opts?.timeoutMs, argv.join(" "));
}

/** `serviceName` → an env-var-safe suffix (`test-db` → `TEST_DB`). */
function envKey(name: string): string {
	return name.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
}

/**
 * Generate the compose file for a gate's declared services. Hand-written YAML rather than a
 * dependency: the shape is four keys deep and a YAML library for it would be more surface than
 * substance. Values are JSON-quoted, which is valid YAML for scalars and neutralises the
 * newline/colon injection a raw interpolation would allow from a manifest field.
 *
 * @substrate exported for direct test, not for another module: `startGateServices` (same file) is the
 * only production caller, but the generated YAML is the thing that decides whether a gate waits for a
 * REAL healthcheck or for nothing, and asserting that through a docker round-trip would make the
 * assertion a machine-availability test instead of a correctness one.
 */
export function composeFileFor(services: readonly TenantComposeService[]): string {
	const lines: string[] = ["services:"];
	for (const s of services) {
		lines.push(`  ${JSON.stringify(s.name)}:`);
		lines.push(`    image: ${JSON.stringify(s.image)}`);
		if (s.env && Object.keys(s.env).length) {
			lines.push("    environment:");
			for (const [k, v] of Object.entries(s.env)) lines.push(`      ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
		}
		if (s.ports?.length) {
			lines.push("    ports:");
			for (const p of s.ports) lines.push(`      - ${JSON.stringify(p)}`);
		}
		lines.push("    healthcheck:");
		lines.push(`      test: [${JSON.stringify("CMD-SHELL")}, ${JSON.stringify(s.healthcheckCommand)}]`);
		lines.push(`      interval: ${Math.max(1, Math.round((s.healthcheckIntervalMs ?? 2000) / 1000))}s`);
		lines.push(`      retries: ${s.healthcheckRetries ?? 30}`);
		// start_period keeps a slow-booting image (postgres initdb) from burning its retries on the
		// startup it is entitled to; the retries then govern genuine unhealthiness.
		lines.push("      start_period: 5s");
	}
	return `${lines.join("\n")}\n`;
}

/**
 * Bring `services` up and wait for health. Every failure path returns a REFUSAL plus a `stop` the
 * caller must still run — a failed `up` can leave half the project running, and a gate that refuses
 * while leaking containers is a worse citizen than one that never started.
 */
export async function startGateServices(opts: {
	services: readonly TenantComposeService[];
	gateName: string;
	/** Where the compose project runs from (the gate's cwd). */
	cwd: string;
	timeoutMs: number;
	spawn?: ServiceSpawn;
	dockerProbe?: () => boolean | Promise<boolean>;
	/** Directory for the generated compose file; defaults to a fresh temp dir. */
	tmpDir?: string;
	/** The tenant's `policy.env` allowlist — the only daemon-env names allowed to reach the compose
	 *  lifecycle (for legitimate interpolation), on top of PATH, HOME, and the DOCKER_/COMPOSE_ vars. */
	policyEnv?: readonly string[];
}): Promise<ServiceStart> {
	const spawn = opts.spawn ?? realSpawn;
	const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_SERVICE_TIMEOUT_MS;
	const noop = async (): Promise<ServiceStopResult> => ({ ok: true });
	if (!opts.services.length) return { ok: true, handle: { project: "", network: "", env: {}, stop: noop } };

	// C-2 (round 4): the SCRUBBED environment the `docker compose` lifecycle runs under. A positive
	// allowlist — PATH/HOME/… + DOCKER_*/COMPOSE_* (the CLI's own connectivity vars, never secrets) +
	// the tenant's declared `policy.env` — so a service definition that tries to interpolate
	// `${DATABASE_URL}` finds NOTHING to interpolate. The L-1 reject floor inside `tenantGateEnv` blocks
	// a secret-shaped name even if it rode in via DOCKER_*/policy.env.
	const composeEnv = tenantGateEnv(process.env, { allow: opts.policyEnv, allowPrefix: ["DOCKER_", "COMPOSE_"] });

	const available = await (opts.dockerProbe ? opts.dockerProbe() : dockerAvailable());
	if (!available) {
		return {
			ok: false,
			stop: noop,
			refusal: {
				code: "service-unavailable",
				reason:
					`gate "${opts.gateName}" requires ${opts.services.length} composed service(s) (${opts.services.map((s) => s.name).join(", ")}) and docker is unavailable — ` +
					`REFUSING to land. This is not a host-fallback case: running the gate on the daemon host would point the tenant's integration suite at the host's own database. Start docker and re-run.`,
			},
		};
	}

	// C-4 (gauntlet round 1): temp-dir creation and compose-file writing sit on the local-land path
	// AFTER main has merged. An EROFS/disk-full throw here used to propagate out of `runManifestGates`
	// (whose catch did not cover setup) and leave main changed on a *thrown* land. Caught HERE as a
	// structured refusal so the runner is genuinely total; the land seam additionally restores head0.
	const project = `glance-gate-${path.basename(opts.cwd).replace(/[^a-z0-9]+/gi, "").toLowerCase().slice(0, 20) || "t"}-${Math.random().toString(36).slice(2, 8)}`;
	let dir: string;
	let file: string;
	try {
		dir = opts.tmpDir ?? (await fsp.mkdtemp(path.join(os.tmpdir(), "glance-compose-")));
		file = path.join(dir, "compose.yaml");
		await fsp.writeFile(file, composeFileFor(opts.services), "utf8");
	} catch (e) {
		return {
			ok: false,
			stop: noop,
			refusal: {
				code: "service-unavailable",
				reason: `gate "${opts.gateName}" could not stage its compose project (${errText(e)}) — the daemon host cannot write the service definition; REFUSING to land rather than run the gate without its services.`,
			},
		};
	}

	const down = async (): Promise<ServiceStopResult> => {
		let result: ServiceStopResult;
		try {
			const r = await spawn(["docker", "compose", "-p", project, "-f", file, "down", "-v", "--remove-orphans"], opts.cwd, { timeoutMs, env: composeEnv });
			// A non-zero `down` (or a killed-on-timeout one) means containers/volumes for `project` may
			// still be alive — surfaced, never swallowed, so the caller blocks the green receipt (H-5).
			result = r.code === 0 ? { ok: true } : { ok: false, detail: `compose down for project ${project} exited ${r.code}: ${r.output.slice(0, 300)}` };
		} catch (e) {
			result = { ok: false, detail: `compose down for project ${project} threw: ${errText(e)}` };
		}
		if (!opts.tmpDir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
		return result;
	};

	const waitSeconds = Math.max(5, Math.round(timeoutMs / 1000));
	const up = await spawn(["docker", "compose", "-p", project, "-f", file, "up", "-d", "--wait", "--wait-timeout", String(waitSeconds)], opts.cwd, { timeoutMs: timeoutMs + 5_000, env: composeEnv });
	if (up.code !== 0) {
		return {
			ok: false,
			stop: down,
			refusal: {
				code: "service-unavailable",
				reason: `gate "${opts.gateName}" could not bring up its required service(s) (${opts.services.map((s) => s.name).join(", ")}) — compose exited ${up.code} waiting for healthchecks: ${up.output.slice(0, 400)}`,
			},
		};
	}

	// Round 3 High (grok's round-1 reachability caveat, promoted): the gate runs sandboxed under
	// `--network none` by default, from which 127.0.0.1:published-port is UNREACHABLE — the published
	// port lives on the daemon host, not inside the gate container. So the gate JOINS this compose
	// project's default network and reaches each service by its SERVICE NAME at its CONTAINER port.
	// (compose names the default network `<project>_default`.)
	const network = `${project}_default`;
	const env: Record<string, string> = { GLANCE_GATE_COMPOSE_PROJECT: project };
	for (const s of opts.services) {
		const key = envKey(s.name);
		// Reachable on the joined network: the service's own name, at the CONTAINER port (the right
		// half of a `host:container` mapping), NOT the published host port.
		env[`GLANCE_SERVICE_${key}_HOST`] = s.name;
		const mapped = s.ports?.[0];
		const containerPort = mapped ? (mapped.includes(":") ? mapped.split(":")[1] : mapped) : undefined;
		if (containerPort) env[`GLANCE_SERVICE_${key}_PORT`] = containerPort;
	}
	return { ok: true, handle: { project, network, env, stop: down } };
}
