/**
 * Post-ship harness-dropdown fix: the webapp's create-agent surface showed NO harnesses and NO
 * models (2026-07-28 production regression). Root cause was NOT the daemon's spawn PATH (the live
 * daemon's own PATH was full) — it was structural: `GET /api/harnesses` was wired ONLY inside
 * `noFleet()` (server.ts), the branch for an actor with no active org/manager. In FILE mode (this
 * daemon's only shipped mode today), `fleetForOrg` ALWAYS resolves `this.singleManager` regardless of
 * org, so `!manager` is never true and `noFleet` is unreachable dead code — every file-mode daemon
 * 404'd on this route. Separately, `GET /api/models` (`manager.modelOptions()`) can only ask a
 * harness that already has a LIVE agent connected, so a fresh room with zero live agents answered
 * with nothing beyond the bare placeholder — visually indistinguishable from "no harnesses, no
 * models" in the webapp's harness-grouped model picker.
 *
 * This proves both fixes through the REAL HTTP route, with a REAL manager present (the exact
 * condition that 404'd before), mirroring fog-route.test.ts's discipline of testing the wiring, not
 * reimplementing the units it composes (those live in harness-registry.test.ts / model-options*.test.ts).
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileStore } from "../src/dal/store.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer } from "../src/server.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function authed(init: RequestInit = {}): RequestInit {
	return { ...init, headers: { "content-type": "application/json", authorization: "Bearer admin-token-xxxxxxxx", ...init.headers } };
}

async function fixture() {
	const state = await fs.mkdtemp(path.join(os.tmpdir(), "harnesses-route-"));
	const manager = new SquadManager({ stateDir: state, store: new FileStore(state), skipGlobalJanitors: true });
	const server = new SquadServer(manager, { port: 0, token: "admin-token-xxxxxxxx" });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await manager.stop();
		await fs.rm(state, { recursive: true, force: true });
	});
	return { manager, server, url };
}

test("GET /api/harnesses is reachable with a manager present (file mode) — NOT the noFleet-only 404 that shipped to production", async () => {
	const { url } = await fixture();
	const res = await fetch(`${url}/api/harnesses`, authed());
	expect(res.status).toBe(200);
	const body = (await res.json()) as { default: string; harnesses: Array<{ name: string }> };
	expect(body.default).toBe("omp");
	// omp ships as this repo's own devDependency, so it is always listed here — the concrete assertion
	// that this is real registry data, not an empty stub.
	expect(body.harnesses.some((h) => h.name === "omp")).toBe(true);
});

test("GET /api/harnesses?all=1 also works with a manager present, matching the pre-existing noFleet contract", async () => {
	const { url } = await fixture();
	const res = await fetch(`${url}/api/harnesses?all=1`, authed());
	expect(res.status).toBe(200);
	const body = (await res.json()) as { harnesses: Array<{ name: string; verified: boolean }> };
	// ?all=1 includes unverified/undetected harnesses too (e.g. gemini, unless a `gemini` binary happens
	// to be installed on this box) — the flag actually widened the roster, proving it reached the handler.
	expect(body.harnesses.length).toBeGreaterThan(0);
});

test("GET /api/harnesses is unauthenticated-denied like every other route (auth still gates it — this fix doesn't accidentally make it public)", async () => {
	const { url } = await fixture();
	const res = await fetch(`${url}/api/harnesses`);
	expect(res.status).toBe(401);
});

test("GET /api/models includes a harness-tagged default entry (e.g. omp) even with ZERO live agents — the exact production symptom (webapp picker showed nothing but the bare placeholder)", async () => {
	const { url } = await fixture();
	const res = await fetch(`${url}/api/models`, authed());
	expect(res.status).toBe(200);
	const body = (await res.json()) as { models: Array<{ label: string; value: string; harness?: string }> };
	const ompDefault = body.models.find((m) => m.harness === "omp");
	expect(ompDefault).toEqual({ label: "omp default", value: "", harness: "omp" });
});
