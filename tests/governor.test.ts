/**
 * Squad governor — the WIP cap that bounds concurrent live agents (#3) and the
 * close-on-land trigger that retires a tracking issue once its branch merges (#1).
 *
 * `liveAgents` is the pure count-vs-cap core. `create`'s throw is exercised by shadowing
 * the public `list()` so the cap fires before any worktree/omp is touched. close-on-land
 * runs against a stub Plane API (Bun.serve) so the PATCH count pins idempotency + retry.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { agentsToAdopt, liveAgents, newAgentId, SquadManager } from "../src/squad-manager.ts";
import type { AgentDTO, AgentStatus, IssueRef } from "../src/types.ts";

const tmps: string[] = [];
const PLANE_ENV = ["PLANE_API_KEY", "PLANE_WORKSPACE", "PLANE_BASE_URL", "PLANE_PROJECT_MAP", "OMP_SQUAD_MAX_WIP", "OMP_SQUAD_QUEUE_ON_FULL", "OMP_SQUAD_AUTOCLOSE"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of PLANE_ENV) saved[k] = process.env[k];

afterEach(async () => {
	for (const k of PLANE_ENV) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

const dto = (status: AgentStatus): AgentDTO => ({
	id: status,
	name: status,
	status,
	kind: "omp-operator",
	repo: "/r",
	worktree: "/w",
	approvalMode: "write",
	pending: [],
	lastActivity: 0,
	messageCount: 0,
});

async function freshManager(planeBase?: string): Promise<SquadManager> {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gov-"));
	tmps.push(stateDir);
	process.env.PLANE_API_KEY = "secret";
	process.env.PLANE_WORKSPACE = "acme";
	if (planeBase) process.env.PLANE_BASE_URL = planeBase;
	return new SquadManager({ stateDir });
}

// ── #3 WIP cap ──────────────────────────────────────────────────────────────

test("liveAgents counts non-terminal agents only (stopped/error free their slot)", () => {
	const roster = [dto("working"), dto("idle"), dto("starting"), dto("input"), dto("stopped"), dto("error")];
	expect(liveAgents(roster)).toBe(4); // the two terminal statuses don't occupy a slot
	expect(liveAgents([])).toBe(0);
	// the cap decision is liveAgents(roster) >= cap
	expect(liveAgents(roster) >= 4).toBe(true);
	expect(liveAgents(roster) >= 5).toBe(false);
});

test("create throws at the WIP cap before cutting a worktree", async () => {
	const mgr = await freshManager();
	// Shadow the public list() the cap reads, so the guard fires without spawning anything.
	const overridable: { list: () => AgentDTO[] } = mgr;
	overridable.list = () => [dto("working"), dto("working")]; // 2 occupying → fills cap 2
	process.env.OMP_SQUAD_MAX_WIP = "2";
	delete process.env.OMP_SQUAD_QUEUE_ON_FULL; // hermetic: this test asserts the hard-cap throw, not the backpressure enqueue path
	delete process.env.OMP_SQUAD_RESOURCE_GATE; // hermetic: assert the count cap, not ambient host-pressure backoff
	await expect(mgr.create({ repo: "/x/repo", name: "blocked" })).rejects.toThrow(/WIP cap reached \(2\/2\)/);
});

test("create does NOT count idle/landed agents toward the WIP cap (they free their slot)", async () => {
	const mgr = await freshManager();
	const overridable: { list: () => AgentDTO[] } = mgr;
	overridable.list = () => [dto("idle"), dto("idle")]; // 2 idle = 0 occupying
	process.env.OMP_SQUAD_MAX_WIP = "2";
	delete process.env.OMP_SQUAD_QUEUE_ON_FULL;
	delete process.env.OMP_SQUAD_RESOURCE_GATE; // hermetic: count-only — idle agents free their slot regardless of host load
	// idle agents don't occupy a slot → create proceeds (fails fast on the fake repo, never a cap throw)
	const r = await mgr.create({ repo: path.join(os.tmpdir(), "cap-idle-nonexistent-repo"), name: "ok" });
	expect(r.name).toBe("ok");
});

test("create stays under cap when a slot is free (no throw at the boundary)", async () => {
	const mgr = await freshManager();
	const overridable: { list: () => AgentDTO[] } = mgr;
	overridable.list = () => [dto("working"), dto("stopped")]; // 1 live, cap 2 → headroom
	process.env.OMP_SQUAD_MAX_WIP = "2";
	// Past the cap guard it tries to spawn into a non-existent repo, which fails fast and resolves
	// (create swallows spawn failures); the point is it does NOT reject with the cap error.
	const result = await mgr.create({ repo: path.join(os.tmpdir(), "gov-nonexistent-repo"), name: "ok" });
	expect(result.name).toBe("ok");
});

// ── #1 close-on-land ─────────────────────────────────────────────────────────

function planeStub(opts: { completed: boolean; onPatch?: () => void }): { server: ReturnType<typeof Bun.serve>; patches: () => number } {
	let patches = 0;
	const server = Bun.serve({
		port: 0,
		fetch: (req) => {
			const url = new URL(req.url);
			if (req.method === "GET" && url.pathname.endsWith("/states/")) {
				return Response.json({ results: opts.completed ? [{ id: "s-done", group: "completed" }] : [{ id: "s-todo", group: "backlog" }] });
			}
			if (req.method === "PATCH") {
				patches++;
				opts.onPatch?.();
				return Response.json({ ok: true });
			}
			return new Response("no", { status: 404 });
		},
	});
	return { server, patches: () => patches };
}

const trackedIssue: IssueRef = { id: "iss-1", name: "do the thing", projectId: "proj-9" };

test("closeLandedIssue closes the issue once, then is idempotent", async () => {
	const { server, patches } = planeStub({ completed: true });
	try {
		const mgr = await freshManager(`http://127.0.0.1:${server.port}`);
		await mgr.closeLandedIssue(trackedIssue);
		await mgr.closeLandedIssue(trackedIssue); // already closed → no second PATCH
		expect(patches()).toBe(1);
	} finally {
		server.stop(true);
	}
});

test("closeLandedIssue is gated by OMP_SQUAD_AUTOCLOSE (=0 ⇒ no close, even on land)", async () => {
	const { server, patches } = planeStub({ completed: true });
	try {
		process.env.OMP_SQUAD_AUTOCLOSE = "0"; // read at construction → closeOnDone false
		const mgr = await freshManager(`http://127.0.0.1:${server.port}`);
		await mgr.closeLandedIssue(trackedIssue);
		expect(patches()).toBe(0); // auto-close off ⇒ a land never touches Plane; you close manually
	} finally {
		server.stop(true);
	}
});

test("closeLandedIssue no-ops for an issue-less member (no Plane call)", async () => {
	const { server, patches } = planeStub({ completed: true });
	try {
		const mgr = await freshManager(`http://127.0.0.1:${server.port}`);
		await mgr.closeLandedIssue(undefined);
		expect(patches()).toBe(0);
	} finally {
		server.stop(true);
	}
});

test("closeLandedIssue retries after a failed close (id marked only on success)", async () => {
	let completed = false;
	let patches = 0;
	const server = Bun.serve({
		port: 0,
		fetch: (req) => {
			const url = new URL(req.url);
			if (req.method === "GET" && url.pathname.endsWith("/states/")) {
				return Response.json({ results: completed ? [{ id: "s-done", group: "completed" }] : [{ id: "s-todo", group: "backlog" }] });
			}
			if (req.method === "PATCH") {
				patches++;
				return Response.json({ ok: true });
			}
			return new Response("no", { status: 404 });
		},
	});
	try {
		const mgr = await freshManager(`http://127.0.0.1:${server.port}`);
		await mgr.closeLandedIssue(trackedIssue); // no completed state → close fails, id left unmarked
		expect(patches).toBe(0);
		completed = true;
		await mgr.closeLandedIssue(trackedIssue); // now there's a completed state → succeeds
		expect(patches).toBe(1);
	} finally {
		server.stop(true);
	}
});

test("newAgentId never collides — unique branch/worktree per agent (same name, rapid spawns)", () => {
	const ids = Array.from({ length: 200 }, () => newAgentId("agent-1")); // worst case: the reused fallback name
	expect(new Set(ids).size).toBe(200); // every id unique
	expect(new Set(ids.map((id) => `squad/${id}`)).size).toBe(200); // ⇒ unique branches ⇒ no shared worktree
});

test("agentsToAdopt: take over dead-host agents with an on-disk worktree; skip reattached/flue/gone", () => {
	const persisted = [
		{ id: "live", worktree: "/w/live" }, // already reattached (in roster) → skip
		{ id: "dead", worktree: "/w/dead" }, // host gone but worktree has context → adopt
		{ id: "gone", worktree: "/w/gone" }, // worktree removed → nothing to take over → skip
		{ id: "flue", kind: "flue-service", worktree: "/w/flue" }, // flue workers aren't restored → skip
		{ id: "nowt" }, // never had a worktree → skip
	];
	const roster = new Set(["live"]);
	const exists = (wt: string) => wt !== "/w/gone";
	expect(agentsToAdopt(persisted, roster, exists).map((p) => p.id)).toEqual(["dead"]);
});
