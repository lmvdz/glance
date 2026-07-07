/**
 * Bootstrap-admin (on-box loopback bearer token) break-glass observability — the graph/usage/heat/
 * activity/action-items/governance/health route family used to resolve their manager the same way
 * every other route did (session-derived orgId), but only GET /api/agents had the aggregate-across-
 * live-managers special case (`registry.liveAgents()`). Every other observability route fell through
 * to `managerFor` with an unresolved orgId — DB-registry mode WITHOUT a root factory (no
 * `OMP_SQUAD_ROOT_FACTORY`, i.e. `this.singleManager` undefined) never resolves a bootstrap-admin
 * orgId at all — and hit `noFleet`'s bare `[]` fallback: wrong shape, and empty even though live org
 * managers exist. This is the exact live-repro shape a sibling unit found: on such a daemon,
 * `curl -H "Authorization: Bearer $TOKEN" .../api/graph/attribution` returns `[]` while
 * `/api/agents` returns the roster.
 *
 * server.ts's `observabilityManagers` + `handleObservability` fix this by resolving these GET routes
 * against the SAME union `registry.liveManagers()` (+ the optional root factory) that GET /api/agents
 * already used, instead of the single per-request `manager`. These tests pin it with REAL per-org
 * SquadManagers (no fakes) over a real ManagerRegistry, so `.allReceipts()` / `.list()` /
 * `.sampleHealth()` / `.complianceFindings()` are all exercised for real — and prove tenant isolation
 * is untouched (an org session's view is still exactly its own manager, never the other org's).
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendReceipt } from "../src/receipts.ts";
import { FileStore } from "../src/dal/store.ts";
import { ManagerRegistry } from "../src/manager-registry.ts";
import { SquadServer, type AuthInstance } from "../src/server.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { Actor, RunReceipt } from "../src/types.ts";

const operator: Actor = { id: "test-op", origin: "local" };

const cleanups: Array<() => Promise<void> | void> = [];
const prevGlanceStateDir = process.env.GLANCE_STATE_DIR;
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	if (prevGlanceStateDir === undefined) delete process.env.GLANCE_STATE_DIR;
	else process.env.GLANCE_STATE_DIR = prevGlanceStateDir;
});

type SessionKey = "orgA" | "orgB";

/** Same session-cookie stub shape as tests/routing.test.ts, scoped to two orgs. */
function authStub(): AuthInstance {
	return {
		handler: async () => new Response("not found", { status: 404 }),
		api: {
			getSession: async ({ headers }) => {
				const cookie = headers.get("cookie") ?? "";
				const match = /(?:^|;\s*)session=(orgA|orgB)(?:;|$)/.exec(cookie);
				const key = match?.[1] as SessionKey | undefined;
				if (!key) return null;
				return {
					user: { id: `user-${key}`, name: `User ${key}`, email: `${key}@example.test` },
					session: { activeOrganizationId: key },
				};
			},
			getActiveMemberRole: async () => ({ role: "member" }),
		},
	};
}

function receipt(orgId: string, costUsd: number, repo = `/repo/${orgId}`): RunReceipt {
	const now = Date.now();
	return {
		agentId: `agent-${orgId}`,
		name: `agent-${orgId}`,
		repo,
		runId: `run-${orgId}`,
		startedAt: now - 1000,
		endedAt: now,
		status: "stopped",
		toolCalls: 3,
		toolTally: { edit: 3 },
		filesTouched: [`src/${orgId}.ts`],
		costUsd,
		harness: "omp",
	};
}

/** DB-registry mode, root factory OFF (no `manager` passed to SquadServer) — the exact shape the
 *  live daemon runs in when OMP_SQUAD_ROOT_FACTORY is unset (today's default): the bootstrap-admin
 *  bearer token has no singleManager to fall back to, only the live per-org registry managers. */
async function startedServer(token: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "obs-bootstrap-"));
	const registry = new ManagerRegistry({ root, store: (orgId) => new FileStore(path.join(root, "orgs", orgId)), operator });
	// Pre-warm both org managers via the real lazy-create path (mirrors each org's webapp session
	// having visited at least once) so the registry actually has live managers to aggregate.
	await registry.get("orgA");
	await registry.get("orgB");
	await appendReceipt(path.join(root, "orgs", "orgA"), receipt("orgA", 1.5));
	await appendReceipt(path.join(root, "orgs", "orgB"), receipt("orgB", 2.5));
	// The graph/attribution/scoreboard family reads resolveStateDir() (the process-wide root), not any
	// per-org manager's stateDir — an existing, unchanged design (a "graph" is physical-repo git state,
	// not per-tenant data). Point it at this test's own root so a seeded receipt there is exactly what
	// those routes see, isolated from the shared suite-wide state dir other test files write into.
	process.env.GLANCE_STATE_DIR = root;
	// resolveGraphRepo() with no `?repo=` defaults to the daemon's own cwd (the webapp never sends one) —
	// match that so the default-path attribution/scoreboard request actually sees this receipt.
	await appendReceipt(root, receipt("global", 9, process.cwd()));
	const server = new SquadServer(undefined, { port: 0, auth: authStub(), registry, token });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await registry.stopAll();
		await fs.rm(root, { recursive: true, force: true });
	});
	return url;
}

const bearer = (token: string): HeadersInit => ({ authorization: `Bearer ${token}` });
const cookie = (key: SessionKey): HeadersInit => ({ cookie: `session=${key}` });

test("bootstrap-admin bearer token: graph/observability routes reach the aggregate live-manager fleet, not noFleet's bare []", async () => {
	const token = "bootstrap-admin-token-graph-obs";
	const url = await startedServer(token);

	// (a) The literal reported repro: /api/graph/attribution used to be `[]`; now it's a real
	// AttributionDoc reflecting the seeded global receipt, and status is 200 (repo allowlist passes
	// because `manager` in resolveGraphRepo is no longer required to be a single non-undefined value).
	const attribution = await fetch(`${url}/api/graph/attribution`, { headers: bearer(token) });
	expect(attribution.status).toBe(200);
	const attributionBody = (await attribution.json()) as Record<string, unknown>;
	expect(Array.isArray(attributionBody)).toBe(false); // was the noFleet `[]` sentinel before the fix
	expect(typeof attributionBody.totalCost).toBe("number");
	expect(attributionBody.totalCost as number).toBeGreaterThanOrEqual(9);

	const scoreboard = await fetch(`${url}/api/graph/scoreboard`, { headers: bearer(token) });
	expect(scoreboard.status).toBe(200);
	expect(Array.isArray(await scoreboard.json())).toBe(false);

	// (b) usage/heat/activity/action-items/governance/health are manager-scoped (allReceipts/list/
	// sampleHealth/complianceFindings) — the aggregate must be the UNION of BOTH live org managers,
	// not just one of them (the "must not lie by omission" bar: a partial view would still be a lie).
	const usage = await fetch(`${url}/api/usage`, { headers: bearer(token) }).then((r) => r.json());
	expect(usage.costUsd).toBeCloseTo(4.0, 5); // 1.5 (orgA) + 2.5 (orgB)
	expect(usage.agents).toBe(2); // agent-orgA + agent-orgB

	const heat = await fetch(`${url}/api/heat`, { headers: bearer(token) }).then((r) => r.json());
	expect(heat.hotAreas.map((h: { path: string }) => h.path).sort()).toEqual(["src/orgA.ts", "src/orgB.ts"]);

	const activity = await fetch(`${url}/api/activity/heatmap`, { headers: bearer(token) }).then((r) => r.json());
	expect(activity.total).toBe(2); // one file touched per org

	const actionItems = await fetch(`${url}/api/action-items`, { headers: bearer(token) });
	expect(actionItems.status).toBe(200);
	const actionItemsBody = (await actionItems.json()) as Record<string, unknown>;
	expect(Array.isArray(actionItemsBody)).toBe(false); // was bare `[]` before the fix
	expect(Array.isArray(actionItemsBody.items)).toBe(true);

	const governance = await fetch(`${url}/api/governance`, { headers: bearer(token) });
	expect(governance.status).toBe(200);
	const governanceBody = (await governance.json()) as Record<string, unknown>;
	expect(Array.isArray(governanceBody)).toBe(false); // was bare `[]` before the fix
	expect(governanceBody.authMode).toBe("db");
	expect(Array.isArray((governanceBody.compliance as { findings: unknown[] }).findings)).toBe(true);

	const health = await fetch(`${url}/api/health`, { headers: bearer(token) });
	expect(health.status).toBe(200);
	const healthBody = (await health.json()) as Record<string, unknown>;
	expect(Array.isArray(healthBody)).toBe(false); // was bare `[]` before the fix
	expect(typeof healthBody.ok).toBe("boolean");
});

test("DB-registry org session: observability routes stay scoped to that org's own manager, never the other org's", async () => {
	const token = "bootstrap-admin-token-isolation";
	const url = await startedServer(token);

	const usageA = await fetch(`${url}/api/usage`, { headers: cookie("orgA") }).then((r) => r.json());
	expect(usageA.costUsd).toBeCloseTo(1.5, 5); // orgA's own receipt only — never orgB's 2.5
	expect(usageA.agents).toBe(1);

	const usageB = await fetch(`${url}/api/usage`, { headers: cookie("orgB") }).then((r) => r.json());
	expect(usageB.costUsd).toBeCloseTo(2.5, 5); // orgB's own receipt only — never orgA's 1.5
	expect(usageB.agents).toBe(1);

	const heatA = await fetch(`${url}/api/heat`, { headers: cookie("orgA") }).then((r) => r.json());
	expect(heatA.hotAreas.map((h: { path: string }) => h.path)).toEqual(["src/orgA.ts"]);
});

test("observability routes still 401 unauthenticated in DB-registry mode", async () => {
	const token = "bootstrap-admin-token-401";
	const url = await startedServer(token);

	expect((await fetch(`${url}/api/usage`)).status).toBe(401);
	expect((await fetch(`${url}/api/graph/attribution`)).status).toBe(401);
	expect((await fetch(`${url}/api/governance`)).status).toBe(401);
	expect((await fetch(`${url}/api/action-items`)).status).toBe(401);
});

test("bootstrap-admin WITH a root factory: aggregate unions the root manager AND every live tenant org", async () => {
	// The other shape (OMP_SQUAD_ROOT_FACTORY=1): a real root SquadManager is passed alongside the
	// registry — root-factory.test.ts covers the pure routing decision; this covers the actual HTTP
	// observability payload, which must union singleManager + registry.liveManagers(), not just one.
	const token = "bootstrap-admin-token-root-factory";
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "obs-bootstrap-root-"));
	const rootMgr = new SquadManager({ stateDir: path.join(root, "root") });
	await rootMgr.start();
	await appendReceipt(path.join(root, "root"), receipt("root", 10));
	const registry = new ManagerRegistry({ root, store: (orgId) => new FileStore(path.join(root, "orgs", orgId)), operator });
	await registry.get("orgA");
	await appendReceipt(path.join(root, "orgs", "orgA"), receipt("orgA", 1.5));
	const server = new SquadServer(rootMgr, { port: 0, auth: authStub(), registry, token });
	const url = server.start();
	try {
		const usage = await fetch(`${url}/api/usage`, { headers: bearer(token) }).then((r) => r.json());
		expect(usage.costUsd).toBeCloseTo(11.5, 5); // 10 (root factory) + 1.5 (tenant orgA)
		expect(usage.agents).toBe(2);
	} finally {
		server.stop();
		await registry.stopAll();
		await rootMgr.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
});
