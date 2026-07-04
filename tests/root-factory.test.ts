/**
 * DB-mode root/operator factory (opt-in) — the trust gap where enabling multi-tenancy silently turned
 * the operator's autonomous factory off. Three guarantees are pinned here:
 *
 *   (a) GATING + ARMING: with OMP_SQUAD_ROOT_FACTORY=1 AND a Plane repo configured, `rootFactoryEnabled()`
 *       is true and a real SquadManager.start() ARMS its Dispatcher (the factory's dispatch loop).
 *   (b) FLAG OFF: without the flag (or without a Plane repo), `rootFactoryEnabled()` is false — DB mode
 *       builds NO root factory, exactly today's behavior.
 *   (c) TENANT ISOLATION + SURFACING: the server routes the operator's own org (OMP_SQUAD_ROOT_ORG) and the
 *       on-box loopback admin (ROOT_FACTORY_ORG sentinel) to the root factory, while every tenant org still
 *       reaches its OWN per-org registry manager — the root factory never leaks into a tenant view.
 *
 * Hermetic: the Dispatcher-arming case points Plane at a local stub (its first tick lists issues and finds
 * none); the routing cases use fake managers/registry and touch only the pure routing decision. No model
 * tokens, no real omp, no real Plane.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { rootFactoryEnabled } from "../src/index.ts";
import { ROOT_FACTORY_ORG, SquadServer } from "../src/server.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { ManagerRegistry } from "../src/manager-registry.ts";

const ENV = [
	"OMP_SQUAD_ROOT_FACTORY",
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

// ── (a)/(b) gating: the exact opt-in trigger ─────────────────────────────────

test("rootFactoryEnabled: ON only when OMP_SQUAD_ROOT_FACTORY=1 AND a Plane repo is configured", () => {
	process.env.OMP_SQUAD_ROOT_FACTORY = "1";
	expect(rootFactoryEnabled(1)).toBe(true); // flag on + one repo
	expect(rootFactoryEnabled(0)).toBe(false); // flag on but no repos ⇒ not started
	delete process.env.OMP_SQUAD_ROOT_FACTORY;
	expect(rootFactoryEnabled(1)).toBe(false); // default OFF even with repos (today's behavior)
	process.env.OMP_SQUAD_ROOT_FACTORY = "0";
	expect(rootFactoryEnabled(3)).toBe(false); // explicit off
});

// ── (a) arming: a started manager with Plane repos wires its Dispatcher ───────

/** Minimal Plane stub: every GET returns an empty result set, so the dispatcher's immediate first tick
 *  finds no issues and spawns nothing. */
function planeStub() {
	return Bun.serve({ port: 0, fetch: () => Response.json({ results: [] }) });
}

/** Configure Plane so planeRepos() is non-empty, and silence every sibling loop so only the dispatcher
 *  arms — the hermetic "root factory has a backlog to poll" setup. */
function configurePlane(port: number): void {
	process.env.PLANE_API_KEY = "secret";
	process.env.PLANE_WORKSPACE = "acme";
	process.env.PLANE_BASE_URL = `http://127.0.0.1:${port}`;
	process.env.PLANE_PROJECT_MAP = JSON.stringify({ "/tmp/root-factory-repo": "proj-1" });
	process.env.OMP_SQUAD_OBSERVE = "0";
	process.env.OMP_SQUAD_SCOUT = "0";
	process.env.OMP_SQUAD_OPPORTUNITY = "0";
	process.env.OMP_SQUAD_PLANSYNC = "0";
	process.env.OMP_SQUAD_AUTODRIVE = "0";
}

async function freshStateDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "root-factory-"));
	tmps.push(dir);
	return dir;
}

test("a root manager with a Plane repo configured ARMS its Dispatcher on start()", async () => {
	const plane = planeStub();
	configurePlane(plane.port);
	delete process.env.OMP_SQUAD_AUTODISPATCH; // default ON — this is the factory's dispatch loop
	try {
		const mgr = new SquadManager({ stateDir: await freshStateDir() });
		await mgr.start();
		// The dispatcher is the factory's Plane→worktree loop; armed ⇒ the operator's backlog actually gets polled.
		expect((mgr as unknown as { dispatcher?: unknown }).dispatcher).toBeDefined();
		await mgr.stop();
	} finally {
		plane.stop(true);
	}
});

test("OMP_SQUAD_AUTODISPATCH=0 leaves the Dispatcher unarmed even with a Plane repo", async () => {
	const plane = planeStub();
	configurePlane(plane.port);
	process.env.OMP_SQUAD_AUTODISPATCH = "0";
	try {
		const mgr = new SquadManager({ stateDir: await freshStateDir() });
		await mgr.start();
		expect((mgr as unknown as { dispatcher?: unknown }).dispatcher).toBeUndefined();
		await mgr.stop();
	} finally {
		plane.stop(true);
	}
});

// ── (c) surfacing + tenant isolation: the server's routing decision ──────────

/** A fake fleet — routing returns object references, so the identity is all that matters. */
function fakeManager(tag: string): SquadManager {
	return { __tag: tag } as unknown as SquadManager;
}

/** A fake registry that hands back a stable per-org fake manager (so isolation is checkable by identity). */
function fakeRegistry(): { registry: ManagerRegistry; getCalls: string[] } {
	const perOrg = new Map<string, SquadManager>();
	const getCalls: string[] = [];
	const registry = {
		get: async (orgId: string) => {
			getCalls.push(orgId);
			if (!perOrg.has(orgId)) perOrg.set(orgId, fakeManager(`tenant:${orgId}`));
			return perOrg.get(orgId)!;
		},
		start: () => {},
		onEvent: () => {},
	} as unknown as ManagerRegistry;
	return { registry, getCalls };
}

/** Private routing seam — the single decision under test. */
interface Routing {
	fleetForOrg(orgId: string | undefined): Promise<SquadManager | undefined>;
	isRootOrg(orgId: string | undefined): boolean;
}

test("root factory ON: operator org + loopback admin reach the factory; tenants reach their own manager", async () => {
	const root = fakeManager("root");
	const { registry, getCalls } = fakeRegistry();
	const srv = new SquadServer(root, { registry, rootOrgId: "org-operator" });
	const r = srv as unknown as Routing;

	// Surfacing: the operator's own org (OMP_SQUAD_ROOT_ORG) and the on-box loopback admin see the factory.
	expect(await r.fleetForOrg("org-operator")).toBe(root);
	expect(await r.fleetForOrg(ROOT_FACTORY_ORG)).toBe(root);
	expect(r.isRootOrg("org-operator")).toBe(true);
	expect(r.isRootOrg(ROOT_FACTORY_ORG)).toBe(true);

	// Isolation: a tenant org reaches ITS own per-org manager (via the registry), never the root factory.
	const tenant = await r.fleetForOrg("tenant-1");
	expect(tenant).not.toBe(root);
	expect((tenant as unknown as { __tag: string }).__tag).toBe("tenant:tenant-1");
	expect(getCalls).toContain("tenant-1"); // routed through the registry, not the root manager
	expect(r.isRootOrg("tenant-1")).toBe(false);

	// An org-less non-admin caller gets no fleet (empty reads / 403 mutations upstream).
	expect(await r.fleetForOrg(undefined)).toBeUndefined();
});

test("root factory OFF: no root manager ⇒ every org (incl. the sentinel) routes to the tenant registry", async () => {
	const { registry } = fakeRegistry();
	// No root manager passed — this is DB mode with the flag off (today's behavior).
	const srv = new SquadServer(undefined, { registry, rootOrgId: "org-operator" });
	const r = srv as unknown as Routing;

	// With no factory, nothing is a "root org" — even the configured OMP_SQUAD_ROOT_ORG falls through to
	// its own tenant manager, so no factory is ever conjured and tenant isolation is untouched.
	expect(r.isRootOrg("org-operator")).toBe(false);
	expect(r.isRootOrg(ROOT_FACTORY_ORG)).toBe(false);
	const opFleet = await r.fleetForOrg("org-operator");
	expect((opFleet as unknown as { __tag: string }).__tag).toBe("tenant:org-operator");
	expect(await r.fleetForOrg(undefined)).toBeUndefined();
});

// ── the deferred payoff: /api/factory/status reports the ROOT factory's loops for the operator ──

test("the operator's fleet for /api/factory/status is the ROOT factory, reporting its live loops (not a tenant's)", async () => {
	// A REAL root manager with a backlog → its dispatch loop arms; factoryStatus() (PR #21) reads that live field.
	const plane = planeStub();
	configurePlane(plane.port);
	delete process.env.OMP_SQUAD_AUTODISPATCH;
	try {
		const root = new SquadManager({ stateDir: await freshStateDir() });
		await root.start();
		const { registry } = fakeRegistry();
		const srv = new SquadServer(root, { registry, rootOrgId: "org-operator" });
		const r = srv as unknown as Routing;

		// The endpoint resolves the caller's fleet, then serves manager.factoryStatus(). For the operator
		// (root org / loopback admin) that fleet is the root factory — so the status strip reports ITS loops.
		const operatorFleet = await r.fleetForOrg("org-operator");
		expect(operatorFleet).toBe(root);
		const status = operatorFleet!.factoryStatus();
		const dispatch = status.loops.find((l) => l.loop === "dispatch")!;
		expect(dispatch.armed).toBe(true); // the root factory's dispatch loop is live, and visible to the operator

		// Isolation: a tenant org's factory-status resolves to ITS own (idle) manager, never the root factory.
		const tenantFleet = await r.fleetForOrg("tenant-1");
		expect(tenantFleet).not.toBe(root);

		await root.stop();
	} finally {
		plane.stop(true);
	}
});
