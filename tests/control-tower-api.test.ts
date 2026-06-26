import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer } from "../src/server.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

async function server(): Promise<string> {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "ct-api-state-"));
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	const srv = new SquadServer(mgr, { port: 0 });
	const url = srv.start();
	cleanups.push(async () => {
		srv.stop();
		await mgr.stop();
		await fs.rm(stateDir, { recursive: true, force: true });
	});
	return url;
}

test("control tower read APIs return honest empty data", async () => {
	const url = await server();
	const profiles = await fetch(`${url}/api/profiles`).then((r) => r.json());
	expect(profiles.profiles[0]).toMatchObject({ id: "default", runtime: "omp-operator" });

	const heat = await fetch(`${url}/api/heat?days=3`).then((r) => r.json());
	expect(heat.source).toBe("receipts.filesTouched");
	expect(heat.days).toHaveLength(3);
	expect(heat.tree).toEqual([]);

	const usage = await fetch(`${url}/api/usage`).then((r) => r.json());
	expect(usage.runs).toEqual([]);
	expect(usage.toolCalls).toBe(0);

	const action = await fetch(`${url}/api/action-items`).then((r) => r.json());
	expect(action.items).toEqual([]);

	const governance = await fetch(`${url}/api/governance`).then((r) => r.json());
	expect(governance.authMode).toBe("file");
	expect(governance.audit.available).toBe(true);
});
