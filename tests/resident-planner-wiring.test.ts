/**
 * SquadManager wiring for the resident planner (Epic 1, leaf 04) — OMP_SQUAD_RESIDENT_PLANNER is
 * opt-IN (default OFF, the inverse of every other loop's default-on "!== 0" gate): a bare
 * start() must construct zero ResidentPlanners, and setting the flag to "1" with a configured
 * Plane repo must construct exactly one per repo. Mirrors root-factory.test.ts's hermetic
 * Plane-stub pattern (no real network, no real omp).
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SquadManager } from "../src/squad-manager.ts";

const ENV = [
	"OMP_SQUAD_RESIDENT_PLANNER",
	"OMP_SQUAD_AUTODISPATCH",
	"OMP_SQUAD_OBSERVE",
	"OMP_SQUAD_SCOUT",
	"OMP_SQUAD_OPPORTUNITY",
	"OMP_SQUAD_PLANSYNC",
	"OMP_SQUAD_AUTODRIVE",
	"PLANE_API_KEY",
	"PLANE_WORKSPACE",
	"PLANE_BASE_URL",
	"PLANE_PROJECT_MAP",
] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV) saved[k] = process.env[k];

const tmps: string[] = [];
afterEach(async () => {
	for (const k of ENV) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

function planeStub() {
	return Bun.serve({ port: 0, fetch: () => Response.json({ results: [] }) });
}

function configurePlane(port: number): void {
	process.env.PLANE_API_KEY = "secret";
	process.env.PLANE_WORKSPACE = "acme";
	process.env.PLANE_BASE_URL = `http://127.0.0.1:${port}`;
	process.env.PLANE_PROJECT_MAP = JSON.stringify({ "/tmp/resident-planner-wiring-repo": "proj-1" });
	process.env.OMP_SQUAD_AUTODISPATCH = "0";
	process.env.OMP_SQUAD_OBSERVE = "0";
	process.env.OMP_SQUAD_SCOUT = "0";
	process.env.OMP_SQUAD_OPPORTUNITY = "0";
	process.env.OMP_SQUAD_PLANSYNC = "0";
	process.env.OMP_SQUAD_AUTODRIVE = "0";
}

async function freshStateDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "resident-planner-wiring-"));
	tmps.push(dir);
	return dir;
}

test("OMP_SQUAD_RESIDENT_PLANNER unset: start() constructs no ResidentPlanner (byte-for-byte unchanged default)", async () => {
	const plane = planeStub();
	configurePlane(plane.port);
	delete process.env.OMP_SQUAD_RESIDENT_PLANNER;
	try {
		const mgr = new SquadManager({ stateDir: await freshStateDir() });
		await mgr.start();
		expect((mgr as unknown as { residentPlanners: unknown[] }).residentPlanners).toHaveLength(0);
		expect(mgr.factoryStatus().generatedAt).toBeGreaterThan(0); // status call itself doesn't throw
		await mgr.stop();
	} finally {
		plane.stop(true);
	}
});

test("OMP_SQUAD_RESIDENT_PLANNER=1 with a configured Plane repo: start() constructs and starts one ResidentPlanner per repo", async () => {
	const plane = planeStub();
	configurePlane(plane.port);
	process.env.OMP_SQUAD_RESIDENT_PLANNER = "1";
	try {
		const mgr = new SquadManager({ stateDir: await freshStateDir() });
		await mgr.start();
		const planners = (mgr as unknown as { residentPlanners: unknown[] }).residentPlanners;
		expect(planners).toHaveLength(1);
		await mgr.stop();
	} finally {
		plane.stop(true);
	}
});
