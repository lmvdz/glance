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
import { dockerAvailable } from "./gate-runner.ts";
import type { GateRefusal, TenantComposeService } from "./tenant-gates.ts";

/** A spawn result reduced to what this module judges on. Injected in tests. */
export interface ServiceSpawnResult {
	code: number;
	output: string;
}
export type ServiceSpawn = (argv: string[], cwd: string) => Promise<ServiceSpawnResult>;

export interface ServiceHandle {
	/** The compose project name — also the container name prefix, for an operator hunting strays. */
	project: string;
	/** Env the gate command receives so it can reach the services (published host ports). */
	env: Record<string, string>;
	/** Idempotent. Always called, including on the refusal paths. */
	stop(): Promise<void>;
}

export type ServiceStart = { ok: true; handle: ServiceHandle } | { ok: false; refusal: GateRefusal; stop: () => Promise<void> };

async function realSpawn(argv: string[], cwd: string): Promise<ServiceSpawnResult> {
	const proc = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, output: `${out}${err}`.trim() };
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
}): Promise<ServiceStart> {
	const spawn = opts.spawn ?? realSpawn;
	const noop = async (): Promise<void> => {};
	if (!opts.services.length) return { ok: true, handle: { project: "", env: {}, stop: noop } };

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

	const project = `glance-gate-${path.basename(opts.cwd).replace(/[^a-z0-9]+/gi, "").toLowerCase().slice(0, 20) || "t"}-${Math.random().toString(36).slice(2, 8)}`;
	const dir = opts.tmpDir ?? (await fsp.mkdtemp(path.join(os.tmpdir(), "glance-compose-")));
	const file = path.join(dir, "compose.yaml");
	await fsp.writeFile(file, composeFileFor(opts.services), "utf8");

	const down = async (): Promise<void> => {
		await spawn(["docker", "compose", "-p", project, "-f", file, "down", "-v", "--remove-orphans"], opts.cwd).catch(() => undefined);
		if (!opts.tmpDir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
	};

	const waitSeconds = Math.max(5, Math.round(opts.timeoutMs / 1000));
	const up = await spawn(["docker", "compose", "-p", project, "-f", file, "up", "-d", "--wait", "--wait-timeout", String(waitSeconds)], opts.cwd);
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

	const env: Record<string, string> = { GLANCE_GATE_COMPOSE_PROJECT: project };
	for (const s of opts.services) {
		const key = envKey(s.name);
		env[`GLANCE_SERVICE_${key}_HOST`] = "127.0.0.1";
		const published = s.ports?.[0]?.split(":")[0];
		if (published) env[`GLANCE_SERVICE_${key}_PORT`] = published;
	}
	return { ok: true, handle: { project, env, stop: down } };
}
