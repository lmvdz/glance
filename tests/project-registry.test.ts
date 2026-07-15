/**
 * Project registry + `SquadManager.projects()` union.
 *
 * A "project" used to be an artifact of the live roster: `projects()` grouped LIVE AGENTS by repo, so a
 * repo existed in the UI only while it had a running agent. Observed on the operator's own daemon —
 * `/api/projects` returned only `omp-squad` seconds after lunarpup's last agent was reaped, so lunarpup
 * (the daemon's own cwd) vanished from the sidebar and reappeared only when an agent respawned. Its two
 * features were DERIVED from those agents, not persisted — nothing was left to anchor the repo at all.
 * There was no POST to add a project, and nothing in the web UI could switch between them.
 *
 * Now: a durable registry, unioned with live-agent repos and persisted-feature repos, so a project can
 * never silently disappear.
 *
 * Real filesystem + real git (the convention of land-mode.test.ts); no mocks.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SubagentTracker } from "../src/subagents.ts";
import type { AgentDTO, PersistedAgent } from "../src/types.ts";
import { normalizeRepoPath, openProjectRegistry } from "../src/project-registry.ts";

const { SquadManager } = await import("../src/squad-manager.ts");

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function tmpDir(prefix: string): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(d);
	return d;
}

async function gitRepo(prefix: string): Promise<string> {
	const repo = await tmpDir(prefix);
	const run = async (...a: string[]): Promise<void> => {
		const p = Bun.spawn(["git", ...a], { cwd: repo, stdout: "ignore", stderr: "ignore" });
		await p.exited;
	};
	await run("init", "-q", "-b", "main");
	await run("config", "user.email", "t@t");
	await run("config", "user.name", "t");
	await fs.writeFile(path.join(repo, "a.txt"), "a\n");
	await run("add", "-A");
	await run("commit", "-qm", "base");
	return repo;
}

// ── the durable set ─────────────────────────────────────────────────────────────────────────────

test("registers, persists across reopen, dedupes, and un-registers", async () => {
	const stateDir = await tmpDir("pr-basic-");

	const reg = openProjectRegistry(stateDir);
	expect(reg.list()).toEqual([]);
	expect(reg.add("/srv/alpha")).toBe("added");
	expect(reg.add("/srv/alpha")).toBe("exists"); // idempotent
	expect(reg.add("/srv/beta")).toBe("added");
	expect(reg.list()).toEqual(["/srv/alpha", "/srv/beta"]); // sorted

	// A fresh registry over the same stateDir sees the same set — this is the whole point.
	const reopened = openProjectRegistry(stateDir);
	expect(reopened.list()).toEqual(["/srv/alpha", "/srv/beta"]);
	expect(reopened.has("/srv/alpha")).toBe(true);

	expect(reopened.delete("/srv/alpha")).toBe("removed");
	expect(reopened.delete("/srv/alpha")).toBe("absent"); // idempotent
	expect(openProjectRegistry(stateDir).list()).toEqual(["/srv/beta"]);
});

test("normalizes the repo key so the union in projects() actually collapses", () => {
	expect(normalizeRepoPath("/srv/alpha/")).toBe("/srv/alpha");
	expect(normalizeRepoPath("/srv/alpha//")).toBe("/srv/alpha");
	expect(normalizeRepoPath("  /srv/alpha  ")).toBe("/srv/alpha");
	expect(normalizeRepoPath("/srv/./alpha")).toBe("/srv/alpha");
	expect(normalizeRepoPath("/srv/x/../alpha")).toBe("/srv/alpha");
});

test("a corrupt projects.json degrades to empty rather than crashing the daemon", async () => {
	const stateDir = await tmpDir("pr-corrupt-");
	await fs.writeFile(path.join(stateDir, "projects.json"), "{not json at all");
	expect(openProjectRegistry(stateDir).list()).toEqual([]);
	// …and a later add still persists cleanly over the garbage.
	const reg = openProjectRegistry(stateDir);
	expect(reg.add("/srv/gamma")).toBe("added");
	expect(openProjectRegistry(stateDir).list()).toEqual(["/srv/gamma"]);
});

// ── validation: this path is where the daemon will spawn agents ─────────────────────────────────

test("registerProject refuses a relative path — never resolved against the daemon's cwd", async () => {
	const stateDir = await tmpDir("pr-rel-state-");
	const mgr = new SquadManager({ stateDir } as never);
	const r = await mgr.registerProject("some/relative/path");
	expect(r.ok).toBe(false);
	if (!r.ok) expect(r.reason).toContain("absolute");
});

test("registerProject refuses a missing directory and a non-git directory", async () => {
	const stateDir = await tmpDir("pr-bad-state-");
	const notGit = await tmpDir("pr-notgit-");
	const mgr = new SquadManager({ stateDir } as never);

	const missing = await mgr.registerProject(path.join(notGit, "nope"));
	expect(missing.ok).toBe(false);
	if (!missing.ok) expect(missing.reason).toContain("no such directory");

	const plain = await mgr.registerProject(notGit);
	expect(plain.ok).toBe(false);
	if (!plain.ok) expect(plain.reason).toContain("not a git repository");
});

test("registerProject accepts a real git repo, is idempotent, and survives a fresh manager", async () => {
	const stateDir = await tmpDir("pr-good-state-");
	const repo = await gitRepo("pr-good-repo-");

	const mgr = new SquadManager({ stateDir } as never);
	const first = await mgr.registerProject(`${repo}/`); // trailing slash — must normalize
	expect(first.ok).toBe(true);
	if (first.ok) {
		expect(first.added).toBe(true);
		expect(first.repo).toBe(repo);
	}
	const again = await mgr.registerProject(repo);
	expect(again.ok && again.added).toBe(false); // already registered

	// A restart re-reads the durable set.
	const reborn = new SquadManager({ stateDir } as never);
	expect(reborn.projects().map((p) => p.repo)).toContain(repo);
});

// ── the union: a project must never vanish ──────────────────────────────────────────────────────

function seedAgent(mgr: InstanceType<typeof SquadManager>, id: string, repo: string): void {
	const dto: AgentDTO = { id, name: id, status: "idle", kind: "omp-operator", repo, worktree: `${repo}/wt`, approvalMode: "yolo", pending: [], lastActivity: 1, messageCount: 0 };
	const options: PersistedAgent = { id, name: id, repo, worktree: `${repo}/wt`, approvalMode: "yolo" };
	mgr.agents.set(id, { dto, agent: undefined as never, options, transcript: [], assistantBuf: "", streaming: false, subs: new SubagentTracker(), toolEntries: new Map() } as never);
}

function seedFeature(mgr: InstanceType<typeof SquadManager>, id: string, repo: string): void {
	(mgr as unknown as { featureStore: Map<string, { id: string; title: string; repo: string }> }).featureStore.set(id, { id, title: id, repo });
}

test("a registered project stays listed with ZERO agents and ZERO features — the vanishing bug", async () => {
	const stateDir = await tmpDir("pr-union-empty-");
	const repo = await gitRepo("pr-union-empty-repo-");
	const mgr = new SquadManager({ stateDir } as never);
	await mgr.registerProject(repo);

	const projects = mgr.projects();
	expect(projects).toHaveLength(1);
	expect(projects[0]).toMatchObject({ repo, registered: true, agentCount: 0, featureCount: 0 });
});

test("a repo with only PERSISTED FEATURES stays listed after its last agent is reaped", async () => {
	const stateDir = await tmpDir("pr-union-feat-");
	const mgr = new SquadManager({ stateDir } as never);
	seedFeature(mgr, "f1", "/srv/lunarpup");
	seedFeature(mgr, "f2", "/srv/lunarpup");
	seedAgent(mgr, "a1", "/srv/other"); // a busier repo exists — this is what used to hide lunarpup

	const byRepo = new Map(mgr.projects().map((p) => [p.repo, p]));
	expect(byRepo.get("/srv/lunarpup")).toMatchObject({ featureCount: 2, agentCount: 0, registered: false });
	expect(byRepo.get("/srv/other")).toMatchObject({ agentCount: 1 });
});

test("a repo with only LIVE AGENTS still lists (an unregistered `glance add <repo>`)", async () => {
	const stateDir = await tmpDir("pr-union-agent-");
	const mgr = new SquadManager({ stateDir } as never);
	seedAgent(mgr, "a1", "/srv/adhoc");

	expect(mgr.projects().map((p) => p.repo)).toEqual(["/srv/adhoc"]);
	expect(mgr.projects()[0].registered).toBe(false);
});

test("the three sources collapse onto ONE row for the same repo, however it is spelled", async () => {
	const stateDir = await tmpDir("pr-union-collapse-");
	const repo = await gitRepo("pr-union-collapse-repo-");
	const mgr = new SquadManager({ stateDir } as never);

	await mgr.registerProject(`${repo}/`); // registry (trailing slash)
	seedFeature(mgr, "f1", repo); // feature
	seedAgent(mgr, "a1", repo); // live agent

	const projects = mgr.projects();
	expect(projects).toHaveLength(1);
	expect(projects[0]).toMatchObject({ repo, registered: true, featureCount: 1, agentCount: 1 });
});

test("un-registering does NOT hide a repo that still has agents or features", async () => {
	const stateDir = await tmpDir("pr-union-unreg-");
	const repo = await gitRepo("pr-union-unreg-repo-");
	const mgr = new SquadManager({ stateDir } as never);
	await mgr.registerProject(repo);
	seedAgent(mgr, "a1", repo);

	const dropped = await mgr.unregisterProject(repo);
	expect(dropped.ok && dropped.removed).toBe(true);

	const projects = mgr.projects();
	expect(projects).toHaveLength(1); // still there — the work exists
	expect(projects[0]).toMatchObject({ repo, registered: false, agentCount: 1 });
});

test("un-registering an idle, workless project removes it from the list", async () => {
	const stateDir = await tmpDir("pr-union-gone-");
	const repo = await gitRepo("pr-union-gone-repo-");
	const mgr = new SquadManager({ stateDir } as never);
	await mgr.registerProject(repo);
	expect(mgr.projects()).toHaveLength(1);

	await mgr.unregisterProject(repo);
	expect(mgr.projects()).toEqual([]);
});

/** `isGitRepo` is true for any directory INSIDE a repo, so registering `/repo/src` used to mint a
 *  project whose id matched no agent's `dto.repo` and no feature's `repo` — two rows for one
 *  repository, and a broken task↔project join. Found by cross-lineage review (grok-4.5). */
test("registering a SUBDIRECTORY canonicalizes to the repo root, not a phantom project", async () => {
	const stateDir = await tmpDir("pr-subdir-state-");
	const repo = await gitRepo("pr-subdir-repo-");
	await fs.mkdir(path.join(repo, "src", "deep"), { recursive: true });

	const mgr = new SquadManager({ stateDir } as never);
	const r = await mgr.registerProject(path.join(repo, "src", "deep"));
	expect(r.ok).toBe(true);
	if (r.ok) expect(r.repo).toBe(repo); // the ROOT, not the subdir
	expect(mgr.projects().map((p) => p.repo)).toEqual([repo]);
});

test("registering through a SYMLINK canonicalizes to the same single row", async () => {
	const stateDir = await tmpDir("pr-link-state-");
	const repo = await gitRepo("pr-link-repo-");
	const linkDir = await tmpDir("pr-link-holder-");
	const link = path.join(linkDir, "alias");
	await fs.symlink(repo, link, "dir");

	const mgr = new SquadManager({ stateDir } as never);
	const viaLink = await mgr.registerProject(link);
	expect(viaLink.ok).toBe(true);
	if (viaLink.ok) expect(viaLink.repo).toBe(await fs.realpath(repo));

	const viaReal = await mgr.registerProject(repo);
	expect(viaReal.ok && viaReal.added).toBe(false); // already registered under the canonical root
	expect(mgr.projects()).toHaveLength(1); // ONE row, not two
});

/** A glance worktree is a git repo too; registering one would make the daemon's own scratch space a
 *  project whose lifetime belongs to an agent, not to the operator. */
test("refuses a path inside glance's own state directory (covers EVERY org's worktrees, not just the root's)", async () => {
	const stateDir = await tmpDir("pr-wt-state-");
	const { worktreeBase } = await import("../src/worktree.ts");
	const base = worktreeBase();
	await fs.mkdir(base, { recursive: true }).catch(() => {});
	const inside = path.join(base, "pr-wt-fixture");
	await fs.mkdir(inside, { recursive: true });
	tmps.push(inside);
	const run = async (...a: string[]): Promise<void> => {
		const proc = Bun.spawn(["git", ...a], { cwd: inside, stdout: "ignore", stderr: "ignore" });
		await proc.exited;
	};
	await run("init", "-q", "-b", "main");

	const mgr = new SquadManager({ stateDir } as never);
	const r = await mgr.registerProject(inside);
	expect(r.ok).toBe(false);
	if (!r.ok) expect(r.reason).toContain("state directory");
});

/** A failed disk write must NOT be reported to the operator as a successful registration: they would
 *  see "project added", and the next restart would disagree. Found by cross-lineage review (grok-4.5). */
test("a registry write failure rolls back and reports error — never a phantom success", async () => {
	const holder = await tmpDir("pr-wfail-");
	const notADir = path.join(holder, "stateDir-is-a-file");
	await fs.writeFile(notADir, "");

	const reg = openProjectRegistry(notADir);
	expect(reg.add("/srv/alpha")).toBe("error");
	expect(reg.list()).toEqual([]); // rolled back, not left in memory
	expect(reg.has("/srv/alpha")).toBe(false);
});

test("registerProject surfaces a persist failure as ok:false, and adds nothing", async () => {
	const holder = await tmpDir("pr-wfail-mgr-");
	const notADir = path.join(holder, "stateDir-is-a-file");
	await fs.writeFile(notADir, "");
	const repo = await gitRepo("pr-wfail-repo-");

	const mgr = new SquadManager({ stateDir: notADir } as never);
	const r = await mgr.registerProject(repo);
	expect(r.ok).toBe(false);
	if (!r.ok) expect(r.reason).toContain("could not persist");
});

/** Per-org managers put worktrees under `<stateRoot>/orgs/<orgId>/worktrees`, while `worktreeBase()`
 *  only names the ROOT manager's `<stateRoot>/worktrees`. Guarding the latter alone let one org's admin
 *  register ANOTHER org's managed worktree — and registration widens the viewer-readable `/api/graph*`
 *  allowlist, whose `/api/graph/commit` returns source diffs. Cross-tenant read, not a role bypass.
 *  Found by cross-lineage review (gpt-5.6-sol). */
test("refuses another ORG's managed worktree — the cross-tenant read", async () => {
	const { resolveStateDir } = await import("../src/state-dir.ts");
	const stateRoot = resolveStateDir();
	const stateDir = await tmpDir("pr-tenant-state-");
	const otherOrg = path.join(stateRoot, "orgs", "org_someone_else", "worktrees", "their-repo");
	await fs.mkdir(otherOrg, { recursive: true });
	tmps.push(path.join(stateRoot, "orgs", "org_someone_else"));
	const proc = Bun.spawn(["git", "init", "-q", "-b", "main"], { cwd: otherOrg, stdout: "ignore", stderr: "ignore" });
	await proc.exited;

	const mgr = new SquadManager({ stateDir } as never);
	const r = await mgr.registerProject(otherOrg);
	expect(r.ok).toBe(false);
	if (!r.ok) expect(r.reason).toContain("state directory");
});

test("normalizeRepoPath preserves the filesystem root rather than collapsing it to an empty key", () => {
	expect(normalizeRepoPath("/")).toBe("/");
	expect(normalizeRepoPath("//")).toBe("/");
});

/** A failed `writeDurableSync` is not proof nothing was written (rename can succeed, then the directory
 *  fsync throws). A naive in-memory rollback would disagree with disk, and the restart would resurrect a
 *  registration the operator was told had failed. Believe disk. (gpt-5.6-sol) */
test("after a write failure the in-memory set matches DISK, not a guessed rollback", async () => {
	const stateDir = await tmpDir("pr-resync-");
	const reg = openProjectRegistry(stateDir);
	expect(reg.add("/srv/already-there")).toBe("added"); // durably on disk

	// Simulate the partial-failure shape: disk now holds MORE than the caller believes.
	await fs.writeFile(path.join(stateDir, "projects.json"), JSON.stringify(["/srv/already-there", "/srv/snuck-in"]));

	// Force a write failure by making the target undeletable-as-a-file: replace it with a directory.
	await fs.rm(path.join(stateDir, "projects.json"));
	await fs.mkdir(path.join(stateDir, "projects.json"));

	expect(reg.add("/srv/new")).toBe("error");
	// The set was resynced from disk (which is now an unreadable directory ⇒ empty), never left holding
	// a phantom "/srv/new".
	expect(reg.has("/srv/new")).toBe(false);
});

// Live finding 2026-07-15: a literal-tilde repo path ("~/sui/omp-graph") survived registration,
// rode into an agent's spawn cwd, and ENOENT-looped the console agent for an afternoon — shells
// expand ~, nothing else does.
import * as os from "node:os";
import { expandHomePath } from "../src/project-registry.ts";

test("normalizeRepoPath expands a leading ~ so the tilde form and absolute form collapse to one key", () => {
	expect(normalizeRepoPath("~/sui/omp-graph")).toBe(path.join(os.homedir(), "sui/omp-graph"));
	expect(normalizeRepoPath("~")).toBe(os.homedir());
	expect(normalizeRepoPath("/already/absolute")).toBe("/already/absolute");
	expect(normalizeRepoPath("no~tilde/inside~path")).toBe("no~tilde/inside~path"); // only a LEADING ~ expands
});

test("expandHomePath is exported for spawn-path defense and leaves non-tilde paths untouched", () => {
	expect(expandHomePath("~/x")).toBe(path.join(os.homedir(), "x"));
	expect(expandHomePath("/abs")).toBe("/abs");
});
