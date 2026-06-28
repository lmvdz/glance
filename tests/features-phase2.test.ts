/**
 * Phase 2 — persisted features: land ordering, branch-cache survival, state.json round-trip.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { archivePlanDir, buildFeatures, deletePlanDir, landOrder, listPlanDirs, restorePlanDir } from "../src/features.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { FeatureWorktreeStatus, LandReadiness, PersistedFeature } from "../src/types.ts";

const tmps: string[] = [];
const managers: SquadManager[] = [];
const PLANE_ENV = ["PLANE_API_KEY", "PLANE_API_TOKEN", "PLANE_WORKSPACE", "PLANE_WORKSPACE_SLUG", "PLANE_PROJECT_MAP", "PLANE_BASE_URL", "PLANE_PROJECT_ID", "PLANE_APP_URL"] as const;
const savedPlaneEnv: Record<string, string | undefined> = {};
for (const key of PLANE_ENV) savedPlaneEnv[key] = process.env[key];

afterEach(async () => {
	for (const m of managers) await m.stop().catch(() => {});
	managers.length = 0;
	for (const t of tmps) await fs.rm(t, { recursive: true, force: true }).catch(() => {});
	tmps.length = 0;
	for (const key of PLANE_ENV) {
		if (savedPlaneEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedPlaneEnv[key];
	}
});

async function git(repo: string, ...a: string[]): Promise<void> {
	await Bun.spawn(["git", "-C", repo, ...a], { stdout: "ignore", stderr: "ignore" }).exited;
}

test("landOrder: ahead first, then uncommitted; clean/diverged/no-branch excluded", () => {
	const w = (readiness: LandReadiness, branch: string): FeatureWorktreeStatus => ({ branch, worktree: `/x/${branch}`, changedFiles: 0, ahead: 1, behind: 0, readiness });
	const order = landOrder([w("uncommitted", "a"), w("diverged", "b"), w("ahead", "c"), w("clean", "d"), w("no-branch", "e")]);
	expect(order.map((x) => x.branch)).toEqual(["c", "a"]);
});

test("buildFeatures: a persisted feature reports cached-branch land status after the agent is gone", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "p2-"));
	tmps.push(repo);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "base.txt"), "base\n");
	await git(repo, "add", ".");
	await git(repo, "commit", "-qm", "base");
	await git(repo, "checkout", "-q", "-b", "gone");
	await fs.writeFile(path.join(repo, "x.txt"), "x\n");
	await git(repo, "add", ".");
	await git(repo, "commit", "-qm", "gone-1");
	await git(repo, "checkout", "-q", "main");
	const wt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "p2-wt-")), "gone");
	tmps.push(path.dirname(wt));
	await git(repo, "worktree", "add", "-q", wt, "gone");

	// Persisted feature whose member agent ("dead") is NOT in the roster — only the cached branch remains.
	const pf: PersistedFeature = { id: "f1", title: "F1", repo, branches: [{ branch: "gone", worktree: wt, agentId: "dead" }], createdAt: 0, updatedAt: 0 };
	const feats = await buildFeatures(repo, [], [pf]);
	const f = feats.find((x) => x.id === "f1");
	expect(f).toBeDefined();
	expect(f?.agentIds).toEqual([]);
	expect(f?.worktrees[0]?.readiness).toBe("ahead"); // land status survives the agent being gone
	expect(f?.stage).toBe("review");
});

test("createFeature round-trips through state.json", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "p2-state-"));
	tmps.push(stateDir);
	const mgr = new SquadManager({ stateDir });
	managers.push(mgr);
	const pf = mgr.createFeature({ title: "Auth", repo: "/x/repo" });
	await mgr.stop(); // flushes persist()
	managers.length = 0; // already stopped

	const restored = new SquadManager({ stateDir });
	managers.push(restored);
	await restored.loadPersisted();
	const feats = await restored.features("/x/repo");
	const got = feats.find((f) => f.id === pf.id);
	expect(got).toBeDefined();
	expect(got?.persisted).toBe(true);
	expect(got?.title).toBe("Auth");
});

test("updateFeature adopts a derived plan feature and persists task-detail edits", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "p2-plan-"));
	tmps.push(repo);
	await git(repo, "init", "-q", "-b", "main");
	await fs.mkdir(path.join(repo, "plans", "ctx"), { recursive: true });
	await fs.writeFile(path.join(repo, "plans", "ctx", "01.md"), "# Ctx\nSTATUS: todo\n");
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "p2-edit-"));
	tmps.push(stateDir);

	const mgr = new SquadManager({ stateDir });
	managers.push(mgr);
	const id = `plan:${repo}:plans/ctx`;
	const edited = await mgr.updateFeature(id, {
		repo,
		description: "Editable description",
		acceptanceCriteria: [{ id: "manual", text: "Manual criterion", completed: false, source: "manual" }],
		decisions: [{ id: "decision", text: "Keep it small", source: "human", createdAt: 1 }],
		relationships: [{ id: "REL-1", targetId: "REL-1", targetTitle: "REL-1", type: "related" }],
	});
	expect(edited?.id).toBe(id);
	await mgr.stop();
	managers.length = 0;

	const restored = new SquadManager({ stateDir });
	managers.push(restored);
	await restored.loadPersisted();
	const got = (await restored.features(repo)).find((feature) => feature.id === id);
	expect(got?.description).toBe("Editable description");
	expect(got?.acceptanceCriteria?.[0]?.text).toBe("Manual criterion");
	expect(got?.decisions?.[0]?.text).toBe("Keep it small");
});

test("archiving a derived plan feature suppresses the scanned plan dir", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "p2-archive-plan-"));
	tmps.push(repo);
	await git(repo, "init", "-q", "-b", "main");
	await fs.mkdir(path.join(repo, "plans", "ctx"), { recursive: true });
	await fs.writeFile(path.join(repo, "plans", "ctx", "01.md"), "# Ctx\n");
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "p2-archive-state-"));
	tmps.push(stateDir);

	const mgr = new SquadManager({ stateDir });
	managers.push(mgr);
	const id = `plan:${repo}:plans/ctx`;
	expect((await mgr.features(repo)).some((feature) => feature.id === id)).toBe(true);

	const archived = await mgr.updateFeature(id, { repo, archived: true });
	expect(archived?.archived).toBe(true);
	expect((await mgr.features(repo)).some((feature) => feature.id === id)).toBe(false);
});

async function exists(p: string): Promise<boolean> {
	try { await fs.stat(p); return true; } catch { return false; }
}

test("archivePlanDir/restorePlanDir round-trips a plan dir through plans/.archive; listPlanDirs skips it", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "p2-plandir-"));
	tmps.push(repo);
	await fs.mkdir(path.join(repo, "plans", "ctx"), { recursive: true });
	await fs.writeFile(path.join(repo, "plans", "ctx", "01.md"), "# Ctx\n");

	expect(await archivePlanDir(repo, "plans/ctx")).toBe(true);
	expect(await exists(path.join(repo, "plans", "ctx"))).toBe(false);
	expect(await exists(path.join(repo, "plans", ".archive", "ctx", "01.md"))).toBe(true);
	// the archive root must NOT surface as a plan
	expect((await listPlanDirs(repo)).some((d) => d.dir.includes(".archive"))).toBe(false);
	// archiving again is a safe no-op
	expect(await archivePlanDir(repo, "plans/ctx")).toBe(false);

	expect(await restorePlanDir(repo, "plans/ctx")).toBe(true);
	expect(await exists(path.join(repo, "plans", "ctx", "01.md"))).toBe(true);
	expect(await exists(path.join(repo, "plans", ".archive", "ctx"))).toBe(false);
});

test("deletePlanDir permanently removes a plan dir from live OR archived location", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "p2-deldir-"));
	tmps.push(repo);
	await fs.mkdir(path.join(repo, "plans", "live"), { recursive: true });
	await fs.writeFile(path.join(repo, "plans", "live", "01.md"), "x\n");
	await fs.mkdir(path.join(repo, "plans", ".archive", "stowed"), { recursive: true });
	await fs.writeFile(path.join(repo, "plans", ".archive", "stowed", "01.md"), "x\n");

	expect(await deletePlanDir(repo, "plans/live")).toBe(true);
	expect(await exists(path.join(repo, "plans", "live"))).toBe(false);
	expect(await deletePlanDir(repo, "plans/stowed")).toBe(true); // resolves to the archived copy
	expect(await exists(path.join(repo, "plans", ".archive", "stowed"))).toBe(false);
	expect(await deletePlanDir(repo, "plans/missing")).toBe(false); // nothing to remove
});

test("updateFeature(archived) cascades the plan dir, and unarchive moves it back", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "p2-arch-cascade-"));
	tmps.push(repo);
	await git(repo, "init", "-q", "-b", "main");
	await fs.mkdir(path.join(repo, "plans", "ctx"), { recursive: true });
	await fs.writeFile(path.join(repo, "plans", "ctx", "01.md"), "# Ctx\n");
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "p2-arch-cascade-state-"));
	tmps.push(stateDir);

	const mgr = new SquadManager({ stateDir });
	managers.push(mgr);
	const pf = mgr.createFeature({ title: "Ctx", repo, planDir: "plans/ctx" });

	await mgr.updateFeature(pf.id, { repo, archived: true });
	expect(await exists(path.join(repo, "plans", "ctx"))).toBe(false);
	expect(await exists(path.join(repo, "plans", ".archive", "ctx"))).toBe(true);
	expect(mgr.archivedFeatures(repo).some((f) => f.id === pf.id && f.planDir === "plans/ctx")).toBe(true);

	await mgr.updateFeature(pf.id, { repo, archived: false });
	expect(await exists(path.join(repo, "plans", "ctx"))).toBe(true);
	expect(await exists(path.join(repo, "plans", ".archive", "ctx"))).toBe(false);
	expect(mgr.archivedFeatures(repo).some((f) => f.id === pf.id)).toBe(false);
});

test("deleteFeature removes the feature + its plan dir (live or archived)", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "p2-del-feature-"));
	tmps.push(repo);
	await git(repo, "init", "-q", "-b", "main");
	await fs.mkdir(path.join(repo, "plans", "ctx"), { recursive: true });
	await fs.writeFile(path.join(repo, "plans", "ctx", "01.md"), "# Ctx\n");
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "p2-del-feature-state-"));
	tmps.push(stateDir);

	const mgr = new SquadManager({ stateDir });
	managers.push(mgr);

	// delete a live feature
	const pf = mgr.createFeature({ title: "Ctx", repo, planDir: "plans/ctx" });
	const res = await mgr.deleteFeature(pf.id, { repo });
	expect(res).toMatchObject({ deleted: true, planDirRemoved: true });
	expect(await exists(path.join(repo, "plans", "ctx"))).toBe(false);
	expect((await mgr.features(repo)).some((f) => f.id === pf.id)).toBe(false);
	expect(mgr.archivedFeatures(repo).some((f) => f.id === pf.id)).toBe(false);

	// archived then hard-deleted: removes the .archive copy too
	await fs.mkdir(path.join(repo, "plans", "ctx2"), { recursive: true });
	await fs.writeFile(path.join(repo, "plans", "ctx2", "01.md"), "# Ctx2\n");
	const pf2 = mgr.createFeature({ title: "Ctx2", repo, planDir: "plans/ctx2" });
	await mgr.updateFeature(pf2.id, { repo, archived: true });
	const res2 = await mgr.deleteFeature(pf2.id, { repo });
	expect(res2.planDirRemoved).toBe(true);
	expect(await exists(path.join(repo, "plans", ".archive", "ctx2"))).toBe(false);

	// deleting a non-existent feature is a clean no-op
	expect((await mgr.deleteFeature("feat-nope", { repo })).deleted).toBe(false);
});

test("createFeatureModule can adopt a plan and fan out open concerns into Plane tickets", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "p2-module-plan-"));
	tmps.push(repo);
	await git(repo, "init", "-q", "-b", "main");
	await fs.mkdir(path.join(repo, "plans", "ctx"), { recursive: true });
	await fs.writeFile(path.join(repo, "plans", "ctx", "00-overview.md"), "# Module Plan\n");
	await fs.writeFile(path.join(repo, "plans", "ctx", "01-api.md"), [
		"# API slice",
		"STATUS: open",
		"TOUCHES: src/api.ts",
		"",
		"## Acceptance Criteria",
		"- API exposes the plan action.",
	].join("\n"));
	await fs.writeFile(path.join(repo, "plans", "ctx", "02-done.md"), "# Done slice\nSTATUS: done\n");
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "p2-module-state-"));
	tmps.push(stateDir);

	const issues: { id: string; sequence_id: number; name: string }[] = [];
	const moduleIssues: string[][] = [];
	let moduleCreates = 0;
	let issueBody = "";
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const url = new URL(req.url);
			if (req.method === "POST" && url.pathname.endsWith("/issues/")) {
				const body = await req.json() as { name: string; description_html?: string };
				issueBody = body.description_html ?? "";
				const issue = { id: `iss-${issues.length + 1}`, sequence_id: issues.length + 1, name: body.name };
				issues.push(issue);
				return Response.json(issue, { status: 201 });
			}
			if (req.method === "POST" && url.pathname.endsWith("/modules/")) {
				moduleCreates += 1;
				return Response.json({ id: "mod-1" }, { status: 201 });
			}
			if (req.method === "POST" && url.pathname.endsWith("/module-issues/")) {
				const body = await req.json() as { issues?: string[] };
				moduleIssues.push(body.issues ?? []);
				return Response.json({ ok: true }, { status: 201 });
			}
			if (req.method === "GET" && url.pathname.endsWith("/issues/")) return Response.json({ results: [] });
			if (req.method === "GET" && url.pathname.endsWith("/projects/proj-9/")) return Response.json({ identifier: "OMPSQ" });
			return new Response("no", { status: 404 });
		},
	});
	try {
		process.env.PLANE_API_KEY = "secret";
		process.env.PLANE_WORKSPACE = "acme";
		process.env.PLANE_BASE_URL = `http://127.0.0.1:${server.port}`;
		process.env.PLANE_APP_URL = "https://app.acme.test";
		process.env.PLANE_PROJECT_MAP = JSON.stringify({ [repo]: "proj-9" });

		const mgr = new SquadManager({ stateDir });
		managers.push(mgr);
		const id = `plan:${repo}:plans/ctx`;
		const moduleOnly = await mgr.createFeatureModule(id, { repo });
		const out = await mgr.createFeatureModule(id, { repo, createTickets: true });

		expect(moduleOnly?.moduleUrl).toBe("https://app.acme.test/acme/projects/proj-9/modules/mod-1");
		expect(out?.moduleUrl).toBe("https://app.acme.test/acme/projects/proj-9/modules/mod-1");
		expect(out?.createdIssues.map((issue) => issue.identifier)).toEqual(["OMPSQ-1"]);
		expect(out?.issueIdentifiers).toEqual(["OMPSQ-1"]);
		expect(moduleIssues).toEqual([["iss-1"]]);
		expect(moduleCreates).toBe(1);
		expect(issueBody).toContain("API exposes the plan action.");
		const feature = (await mgr.features(repo)).find((item) => item.id === id);
		expect(feature?.persisted).toBe(true);
		expect(feature?.issueIdentifiers).toEqual(["OMPSQ-1"]);
	} finally {
		server.stop(true);
	}
});

test("repairFeatureModuleTickets links existing generated tickets and closes duplicates", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "p2-repair-plan-"));
	tmps.push(repo);
	await git(repo, "init", "-q", "-b", "main");
	await fs.mkdir(path.join(repo, "plans", "ctx"), { recursive: true });
	await fs.writeFile(path.join(repo, "plans", "ctx", "01-api.md"), [
		"# API slice",
		"STATUS: open",
		"",
		"## Acceptance Criteria",
		"- API exposes the plan action.",
	].join("\n"));
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "p2-repair-state-"));
	tmps.push(stateDir);

	const issues = [
		{ id: "iss-1", sequence_id: 1, name: "API slice", state: "s-open", body: "Plan path: plans/ctx/01-api.md" },
		{ id: "iss-2", sequence_id: 2, name: "API slice", state: "s-open", body: "Plan path: plans/ctx/01-api.md" },
	];
	const moduleIssues: string[][] = [];
	const closed: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const url = new URL(req.url);
			if (req.method === "POST" && url.pathname.endsWith("/modules/")) return Response.json({ id: "mod-1" }, { status: 201 });
			if (req.method === "POST" && url.pathname.endsWith("/module-issues/")) {
				const body = await req.json() as { issues?: string[] };
				moduleIssues.push(body.issues ?? []);
				return Response.json({ ok: true }, { status: 201 });
			}
			if (req.method === "GET" && url.pathname.endsWith("/issues/")) return Response.json({ results: issues });
			if (req.method === "GET" && url.pathname.endsWith("/states/")) return Response.json({ results: [{ id: "s-open", group: "backlog" }, { id: "s-done", group: "completed" }] });
			if (req.method === "GET" && url.pathname.endsWith("/labels/")) return Response.json({ results: [] });
			if (req.method === "GET" && url.pathname.endsWith("/relations/")) return Response.json({ blocked_by: [] });
			if (req.method === "GET" && url.pathname.endsWith("/projects/proj-9/")) return Response.json({ identifier: "OMPSQ" });
			const issueMatch = url.pathname.match(/\/issues\/([^/]+)\/$/);
			if (req.method === "GET" && issueMatch) {
				const issue = issues.find((item) => item.id === issueMatch[1]);
				return issue ? Response.json({ ...issue, description_stripped: issue.body, project_detail: { identifier: "OMPSQ" } }) : new Response("no", { status: 404 });
			}
			if (req.method === "PATCH" && issueMatch) {
				closed.push(issueMatch[1]);
				return Response.json({ ok: true });
			}
			return new Response("no", { status: 404 });
		},
	});
	try {
		process.env.PLANE_API_KEY = "secret";
		process.env.PLANE_WORKSPACE = "acme";
		process.env.PLANE_BASE_URL = `http://127.0.0.1:${server.port}`;
		process.env.PLANE_APP_URL = "https://app.acme.test";
		process.env.PLANE_PROJECT_MAP = JSON.stringify({ [repo]: "proj-9" });

		const mgr = new SquadManager({ stateDir });
		managers.push(mgr);
		const feature = mgr.createFeature({ title: "Repair", repo, planDir: "plans/ctx" });
		const out = await mgr.repairFeatureModuleTickets(feature.id, { repo, closeOrphans: true });

		expect(out?.linkedIssues.map((issue) => issue.identifier)).toEqual(["OMPSQ-1"]);
		expect(out?.closedIssues.map((issue) => issue.identifier)).toEqual(["OMPSQ-2"]);
		expect(moduleIssues).toEqual([["iss-1"]]);
		expect(closed).toEqual(["iss-2"]);
		const repaired = (await mgr.features(repo)).find((item) => item.id === feature.id);
		expect(repaired?.issueIdentifiers).toEqual(["OMPSQ-1"]);
	} finally {
		server.stop(true);
	}
}, 12000);
