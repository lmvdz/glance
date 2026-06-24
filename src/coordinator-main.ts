/**
 * CLI entrypoint for the federation coordinator.
 *
 *   bun src/coordinator-main.ts [port]
 *   OMP_SQUAD_COORDINATOR_PORT=7900 bun src/coordinator-main.ts
 *
 * Security: binds 127.0.0.1 by default. Exposing the relay beyond loopback
 * (OMP_SQUAD_COORDINATOR_HOST=0.0.0.0) without a pre-shared token would let any
 * reachable peer snoop and spoof presence/lease frames, so a non-loopback bind
 * REQUIRES OMP_SQUAD_COORDINATOR_TOKEN (override with OMP_SQUAD_INSECURE=1 when
 * the tailnet ACLs are the only gate you want).
 *
 * Bun.serve keeps the process alive on its own — no keep-alive timer needed.
 */

import { runCoordinator } from "./coordinator.ts";

/** Loopback-only bind? (mirrors isLoopbackHost in index.ts; inlined to avoid pulling in the CLI module graph) */
function isLoopbackHost(host: string): boolean {
	return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

if (import.meta.main) {
	const fromArg = parseInt(process.argv[2] ?? "", 10);
	const fromEnv = parseInt(process.env.OMP_SQUAD_COORDINATOR_PORT ?? "", 10);
	const port = Number.isNaN(fromArg) ? (Number.isNaN(fromEnv) ? 7900 : fromEnv) : fromArg;
	const hostname = process.env.OMP_SQUAD_COORDINATOR_HOST || "127.0.0.1";
	const token = process.env.OMP_SQUAD_COORDINATOR_TOKEN || undefined;

	if (!isLoopbackHost(hostname) && token === undefined && process.env.OMP_SQUAD_INSECURE !== "1") {
		process.stderr.write(
			`refusing to bind ${hostname} with no coordinator token.\n` +
				`Any peer that can reach the relay would snoop and spoof presence/lease frames.\n` +
				`Either:\n` +
				`  (a) set OMP_SQUAD_COORDINATOR_TOKEN=<shared secret> (clients set the same);\n` +
				`  (b) keep the default loopback bind and front it with \`tailscale serve\`;\n` +
				`  (c) set OMP_SQUAD_INSECURE=1 to rely on tailnet ACLs alone, deliberately.\n`,
		);
		process.exit(1);
	}

	const handle = runCoordinator({ port, hostname, token });
	console.log(
		`omp-squad coordinator listening on ${handle.url}${token === undefined ? " (no auth)" : " (token-gated)"}`,
	);
}
