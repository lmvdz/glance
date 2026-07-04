/**
 * Federation sync entry point.
 *
 *   OMP_SQUAD_COORDINATOR=ws://coordinator-host:7900 \
 *   OMP_SQUAD_OPERATOR=alice \
 *   bun src/federation-sync-main.ts
 *
 * Runs the cross-host lease sync (see federation-sync.ts) as its own process,
 * decoupled from the squad daemon. Watches the current repo plus any paths in
 * OMP_SQUAD_FED_REPOS (comma-separated) in addition to repos auto-discovered
 * from the local presence registry.
 */

import "./env-compat.ts"; // GLANCE_* ↔ OMP_SQUAD_* aliasing — must run before any env read
import * as os from "node:os";
import { startFederationSync } from "./federation-sync.ts";
import type { Actor } from "./types.ts";

if (import.meta.main) {
	const coordinatorUrl = process.env.OMP_SQUAD_COORDINATOR;
	if (coordinatorUrl === undefined || coordinatorUrl.length === 0) {
		process.stderr.write("federation-sync: set OMP_SQUAD_COORDINATOR=ws://<coordinator-host>:<port> first\n");
		process.exit(1);
	}
	const operator: Actor = { id: process.env.OMP_SQUAD_OPERATOR || os.userInfo().username || "local", origin: "local" };
	const extra = (process.env.OMP_SQUAD_FED_REPOS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	const repos = [process.cwd(), ...extra];

	const token = process.env.OMP_SQUAD_COORDINATOR_TOKEN || undefined;
	const handle = await startFederationSync({
		coordinatorUrl,
		operator,
		token,
		repos,
		onMirror: (frame) => process.stderr.write(`federation-sync: mirrored ${frame.leases.length} lease(s) for ${frame.repoId} from ${frame.operator.id}\n`),
	});
	process.stderr.write(`federation-sync: joined ${coordinatorUrl} as ${operator.id}; watching ${repos.length} repo(s)\n`);

	const shutdown = async (): Promise<void> => {
		await handle.stop();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
	await new Promise<never>(() => {});
}
