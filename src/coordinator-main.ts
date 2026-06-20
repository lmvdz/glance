/**
 * CLI entrypoint for the federation coordinator.
 *
 *   bun src/coordinator-main.ts [port]
 *   OMP_SQUAD_COORDINATOR_PORT=7900 bun src/coordinator-main.ts
 *
 * Bun.serve keeps the process alive on its own — no keep-alive timer needed.
 */

import { runCoordinator } from "./coordinator.ts";

if (import.meta.main) {
	const fromArg = parseInt(process.argv[2] ?? "", 10);
	const fromEnv = parseInt(process.env.OMP_SQUAD_COORDINATOR_PORT ?? "", 10);
	const port = Number.isNaN(fromArg) ? (Number.isNaN(fromEnv) ? 7900 : fromEnv) : fromArg;
	const handle = runCoordinator({ port });
	console.log(`omp-squad coordinator listening on ${handle.url}`);
}
