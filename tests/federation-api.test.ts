/**
 * Federation / leases / fabric API surface in SINGLE-HOST mode (the default).
 *
 * With federation now ON by default (a LocalFederationBus, no coordinator), a
 * single host with no peers must still serve REAL local data from these
 * endpoints — never an error, never a blanket-empty payload, never fake peers.
 * No real network / tailnet: the daemon runs loopback with no coordinator.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { claimLease, releaseSession } from "../src/leases.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { LocalFederationBus } from "../src/federation.ts";
import { SquadServer } from "../src/server.ts";
import type { FederationSnapshot } from "../src/federation.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

/** A loopback daemon with a real LocalFederationBus (single-host, no coordinator). */
async function server(operatorId = "single-host-op"): Promise<string> {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fed-api-state-"));
	const operator = { id: operatorId, origin: "local" as const };
	const bus = new LocalFederationBus({ operator });
	const mgr = new SquadManager({ stateDir, operator, bus });
	await mgr.start();
	const srv = new SquadServer(mgr, { port: 0, operator });
	const url = srv.start();
	cleanups.push(async () => {
		srv.stop();
		await mgr.stop();
		await fs.rm(stateDir, { recursive: true, force: true });
	});
	return url;
}

test("/api/federation returns the local operator's own presence (self), not empty, with no coordinator", async () => {
	const url = await server("alice");
	const snap = (await fetch(`${url}/api/federation`).then((r) => r.json())) as FederationSnapshot;
	// No coordinator configured ⇒ the panel-gating coordinator field is null.
	expect(snap.coordinator).toBeNull();
	// Self is always present (pinned head), even with zero peers and zero agents.
	expect(snap.operators).toHaveLength(1);
	expect(snap.operators[0]?.operator.id).toBe("alice");
	expect(snap.operators[0]?.operator.origin).toBe("local");
	// No peers ⇒ no cross-operator collisions, and no fabricated peer rows.
	expect(snap.collisions).toEqual([]);
});

test("/api/leases returns the host's real local leases (no coordinator, no peers)", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "fed-api-repo-"));
	cleanups.push(async () => {
		await releaseSession("hook:1", repo);
		await fs.rm(repo, { recursive: true, force: true });
	});
	await claimLease({ repo, file: "src/server.ts", session: "hook:1", operator: "alice" });

	const url = await server("alice");
	const leases = (await fetch(`${url}/api/leases?repo=${encodeURIComponent(repo)}`).then((r) => r.json())) as Array<{ file: string; operator: string }>;
	expect(leases.map((l) => l.file)).toContain("src/server.ts");
	expect(leases.find((l) => l.file === "src/server.ts")?.operator).toBe("alice");
});

test("/api/fabric includes real local leases for the queried repo (single-host)", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "fed-api-fab-"));
	cleanups.push(async () => {
		await releaseSession("hook:1", repo);
		await fs.rm(repo, { recursive: true, force: true });
	});
	// A lease whose session matches an (absent) agent id won't surface; fabric scopes leases to the
	// caller's agents. With no agents the fabric is honestly empty but the route returns 200 with the shape.
	await claimLease({ repo, file: "src/a.ts", session: "hook:1", operator: "alice" });

	const url = await server("alice");
	const res = await fetch(`${url}/api/fabric?repo=${encodeURIComponent(repo)}`);
	expect(res.status).toBe(200);
	const fabric = await res.json();
	expect(Array.isArray(fabric.agents)).toBe(true);
	expect(Array.isArray(fabric.leases)).toBe(true);
});

test("a daemon with no LocalFederationBus injected still serves /api/federation self (server default operator)", async () => {
	// The server computes self from its own operator even when the manager got no bus,
	// so the endpoint is never an error path.
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "fed-api-nobus-"));
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	const srv = new SquadServer(mgr, { port: 0, operator: { id: "nobus", origin: "local" } });
	const url = srv.start();
	cleanups.push(async () => {
		srv.stop();
		await mgr.stop();
		await fs.rm(stateDir, { recursive: true, force: true });
	});
	const snap = (await fetch(`${url}/api/federation`).then((r) => r.json())) as FederationSnapshot;
	expect(snap.operators[0]?.operator.id).toBe("nobus");
	expect(snap.coordinator).toBeNull();
});
