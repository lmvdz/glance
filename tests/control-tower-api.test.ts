import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendReceipt } from "../src/receipts.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer } from "../src/server.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

async function serverOn(stateDir: string): Promise<string> {
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

async function server(): Promise<string> {
	return serverOn(await fs.mkdtemp(path.join(os.tmpdir(), "ct-api-state-")));
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
	expect(action.items.filter((item: { source?: string }) => item.source !== "health")).toEqual([]);

	const governance = await fetch(`${url}/api/governance`).then((r) => r.json());
	expect(governance.authMode).toBe("file");
	expect(governance.audit.available).toBe(true);
});

test("usage/heat/activity aggregate the PERSISTED receipt ledger, not just live-roster agents", async () => {
	// A receipt on disk for an agent that is NOT in the roster (reaped, or a prior boot). This is the
	// exact state a restart leaves: the ledger persists, the roster is empty.
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "ct-api-state-"));
	const repo = path.join(os.tmpdir(), "ghost-repo");
	const now = Date.now();
	await appendReceipt(stateDir, {
		agentId: "ghost-not-in-roster",
		name: "ghost",
		repo,
		runId: "g1",
		startedAt: now - 1000,
		endedAt: now,
		status: "stopped",
		toolCalls: 7,
		toolTally: { edit: 7 },
		filesTouched: ["src/ghost.ts", "src/other.ts"],
		costUsd: 0.42,
		harness: "omp",
	});

	const url = await serverOn(stateDir); // roster starts EMPTY — nothing is live
	const q = `repo=${encodeURIComponent(repo)}`;

	const usage = await fetch(`${url}/api/usage?${q}`).then((r) => r.json());
	expect(usage.toolCalls).toBe(7); // was 0 when scoped to the (empty) live roster
	expect(usage.costUsd).toBe(0.42);
	expect(usage.agents).toBe(1); // the ghost agent, never in the roster
	expect(usage.runs).toHaveLength(1);

	const heat = await fetch(`${url}/api/heat?${q}`).then((r) => r.json());
	expect(heat.hotAreas.map((h: { path: string }) => h.path)).toEqual(expect.arrayContaining(["src/ghost.ts", "src/other.ts"]));

	const activity = await fetch(`${url}/api/activity/heatmap?${q}`).then((r) => r.json());
	expect(activity.total).toBe(2); // two files touched
});

test("/api/heat: same-named files across different repos never collapse into one heat array (comprehension concern 04)", async () => {
	// Regression for a pre-existing bug: heatPayload's byFile map was keyed by the bare file path, so
	// an unfiltered (no `?repo=`) read that spans more than one repo — a normal file-mode operator with
	// two registered projects, or a bootstrap-admin's cross-org break-glass view — silently SUMMED two
	// unrelated files' touch counts into one tree node just because they shared a path, e.g. "src/index.ts"
	// in repo A and repo B. Fixed by keying `${normalizeRepoPath(repo)}\0${file}`, the same join
	// convention comprehension-fog.ts's `fogKey` uses.
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "ct-api-state-"));
	const repoA = path.join(os.tmpdir(), "collide-repo-a");
	const repoB = path.join(os.tmpdir(), "collide-repo-b");
	const now = Date.now();
	await appendReceipt(stateDir, {
		agentId: "a1",
		name: "a1",
		repo: repoA,
		runId: "ra1",
		startedAt: now - 1000,
		endedAt: now,
		status: "stopped",
		toolCalls: 3,
		toolTally: { edit: 3 },
		filesTouched: ["src/index.ts"],
		harness: "omp",
	});
	await appendReceipt(stateDir, {
		agentId: "b1",
		name: "b1",
		repo: repoB,
		runId: "rb1",
		startedAt: now - 1000,
		endedAt: now,
		status: "stopped",
		toolCalls: 5,
		toolTally: { edit: 5 },
		filesTouched: ["src/index.ts"],
		harness: "omp",
	});

	const url = await serverOn(stateDir);
	const heat = await fetch(`${url}/api/heat?days=3`).then((r) => r.json());

	const nodes = heat.tree.filter((n: { id: string }) => n.id === "src/index.ts");
	expect(nodes).toHaveLength(2); // NOT collapsed into a single node
	const byRepo = new Map(nodes.map((n: { repo: string; heat: number[] }) => [n.repo, n.heat]));
	const repoATotal = (byRepo.get(repoA) as number[]).reduce((a, b) => a + b, 0);
	const repoBTotal = (byRepo.get(repoB) as number[]).reduce((a, b) => a + b, 0);
	expect(repoATotal).toBe(1); // one receipt touched it once, not summed with repo B's
	expect(repoBTotal).toBe(1);

	const hotAreaRepos = heat.hotAreas.filter((h: { path: string }) => h.path === "src/index.ts").map((h: { repo: string }) => h.repo);
	expect(hotAreaRepos.sort()).toEqual([repoA, repoB].sort());
});

test("/api/heat: repo filter matches an equivalent-but-differently-formed path (normalizeRepoPath equality)", async () => {
	// Regression for a pre-existing bug: heatPayload's repo filter used raw `r.repo === repo`, so a
	// receipt stored with a trailing slash never matched a `?repo=` query for the canonical (slash-
	// stripped) form of the same repo — the exact bug class the fabric leak incident was fixed for,
	// in this endpoint specifically.
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "ct-api-state-"));
	const canonical = path.join(os.tmpdir(), "norm-repo");
	const stored = `${canonical}/`; // trailing slash — same repo, different literal form
	const now = Date.now();
	await appendReceipt(stateDir, {
		agentId: "n1",
		name: "n1",
		repo: stored,
		runId: "rn1",
		startedAt: now - 1000,
		endedAt: now,
		status: "stopped",
		toolCalls: 1,
		toolTally: { edit: 1 },
		filesTouched: ["src/normalized.ts"],
		harness: "omp",
	});

	const url = await serverOn(stateDir);
	const heat = await fetch(`${url}/api/heat?days=3&repo=${encodeURIComponent(canonical)}`).then((r) => r.json());
	expect(heat.tree.map((n: { id: string }) => n.id)).toContain("src/normalized.ts");
});

test("/api/automation exposes the background-loop activity shape and accepts its query params", async () => {
	const url = await server();
	const a = await fetch(`${url}/api/automation`).then((r) => r.json());
	expect(Array.isArray(a.events)).toBe(true); // recent feed
	expect(Array.isArray(a.rollup)).toBe(true); // per-loop rollups
	// loop / windowMs / limit / meaningful filters are parsed without erroring the route
	const filtered = await fetch(`${url}/api/automation?loop=scout&windowMs=900000&limit=5&meaningful=1`);
	expect(filtered.status).toBe(200);
	const body = await filtered.json();
	expect(Array.isArray(body.events)).toBe(true);
});

test("feature pipeline returns inline readiness read model", async () => {
	const url = await server();
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "ct-api-repo-"));
	cleanups.push(() => fs.rm(repo, { recursive: true, force: true }));
	const created = await fetch(`${url}/api/features`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ title: "Readiness", repo }),
	});
	expect(created.ok).toBe(true);
	const features = await fetch(`${url}/api/features?repo=${encodeURIComponent(repo)}`).then((r) => r.json());
	const feature = features.find((f: { title?: string }) => f.title === "Readiness");
	expect(feature.readiness).toMatchObject({ ready: false, state: "no-candidate", blockers: ["no-candidate"] });
	const pipeline = await fetch(`${url}/api/features/${encodeURIComponent(feature.id)}/pipeline?repo=${encodeURIComponent(repo)}`).then((r) => r.json());
	expect(pipeline.readiness).toEqual(feature.readiness);
	expect(pipeline.feature.readiness).toEqual(feature.readiness);
});
