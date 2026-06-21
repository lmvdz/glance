/**
 * Feature derivation — land-status readiness, plan-dir scan, buildFeatures.
 * Real git repos in temp dirs (gpgsign off for headless).
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildFeatures, featureLandStatus, listPlanDirs } from "../src/features.ts";
import type { AgentDTO } from "../src/types.ts";

const tmps: string[] = [];
afterEach(async () => {
	for (const t of tmps) await fs.rm(t, { recursive: true, force: true }).catch(() => {});
	tmps.length = 0;
});

async function git(repo: string, ...a: string[]): Promise<void> {
	await Bun.spawn(["git", "-C", repo, ...a], { stdout: "ignore", stderr: "ignore" }).exited;
}

async function baseRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "feat-"));
	tmps.push(repo);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "base.txt"), "base\n");
	await git(repo, "add", ".");
	await git(repo, "commit", "-qm", "base");
	return repo;
}

function agent(over: Partial<AgentDTO> & { id: string; worktree: string }): AgentDTO {
	return { name: over.id, status: "idle", kind: "omp-operator", repo: "", approvalMode: "yolo", pending: [], lastActivity: 0, messageCount: 0, ...over };
}

test("featureLandStatus: no-branch when worktree === repo", async () => {
	const repo = await baseRepo();
	const [s] = await featureLandStatus([{ worktree: repo, repo }]);
	expect(s.readiness).toBe("no-branch");
});

test("featureLandStatus: ahead branch is 'ahead'; dirty worktree is 'uncommitted'", async () => {
	const repo = await baseRepo();
	await git(repo, "checkout", "-q", "-b", "feat");
	await fs.writeFile(path.join(repo, "a.txt"), "a\n");
	await git(repo, "add", ".");
	await git(repo, "commit", "-qm", "feat-1");
	await git(repo, "checkout", "-q", "main");
	const wt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "wt-")), "feat");
	tmps.push(path.dirname(wt));
	await git(repo, "worktree", "add", "-q", wt, "feat");

	const [clean] = await featureLandStatus([{ branch: "feat", worktree: wt, repo }]);
	expect(clean.readiness).toBe("ahead");
	expect(clean.ahead).toBe(1);
	expect(clean.behind).toBe(0);

	await fs.writeFile(path.join(wt, "b.txt"), "dirty\n");
	const [dirty] = await featureLandStatus([{ branch: "feat", worktree: wt, repo }]);
	expect(dirty.readiness).toBe("uncommitted");
	expect(dirty.changedFiles).toBeGreaterThan(0);
});

test("featureLandStatus: branch that conflicts with advanced main is 'diverged'", async () => {
	const repo = await baseRepo();
	await git(repo, "checkout", "-q", "-b", "div");
	await fs.writeFile(path.join(repo, "f.txt"), "X\n");
	await git(repo, "add", ".");
	await git(repo, "commit", "-qm", "div-x");
	await git(repo, "checkout", "-q", "main");
	await fs.writeFile(path.join(repo, "f.txt"), "Y\n");
	await git(repo, "add", ".");
	await git(repo, "commit", "-qm", "main-y");
	const wt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "wt-")), "div");
	tmps.push(path.dirname(wt));
	await git(repo, "worktree", "add", "-q", wt, "div");

	const [s] = await featureLandStatus([{ branch: "div", worktree: wt, repo }]);
	expect(s.ahead).toBe(1);
	expect(s.behind).toBe(1);
	expect(s.readiness).toBe("diverged");
});

test("listPlanDirs finds plan dirs and their PLANE pointers", async () => {
	const repo = await baseRepo();
	await fs.mkdir(path.join(repo, "plans", "auth"), { recursive: true });
	await fs.writeFile(path.join(repo, "plans", "auth", "01-login.md"), "# Login\nPLANE: ACME-12\nsome text\n");
	await fs.writeFile(path.join(repo, "plans", "auth", "02-tokens.md"), "PLANE: ACME-13\n");
	await fs.mkdir(path.join(repo, "plans", "empty"), { recursive: true }); // no markdown → skipped

	const dirs = await listPlanDirs(repo);
	expect(dirs.map((d) => d.dir)).toEqual(["plans/auth"]);
	expect(dirs[0].issueIds.sort()).toEqual(["ACME-12", "ACME-13"]);
});

test("buildFeatures: plan dir → planned/issues-created feature; agent → in-flight feature", async () => {
	const repo = await baseRepo();
	// agent on an ahead branch (committed, unmerged) → review (needs land)
	await git(repo, "checkout", "-q", "-b", "work");
	await fs.writeFile(path.join(repo, "c.txt"), "c\n");
	await git(repo, "add", ".");
	await git(repo, "commit", "-qm", "work-1");
	await git(repo, "checkout", "-q", "main");
	const wt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "wt-")), "work");
	tmps.push(path.dirname(wt));
	await git(repo, "worktree", "add", "-q", wt, "work");
	// plan dir on disk in the main checkout (buildFeatures scans the filesystem)
	await fs.mkdir(path.join(repo, "plans", "auth"), { recursive: true });
	await fs.writeFile(path.join(repo, "plans", "auth", "01.md"), "PLANE: ACME-1\n");

	const feats = await buildFeatures(repo, [agent({ id: "a1", worktree: wt, branch: "work", repo, status: "idle" })]);
	const plan = feats.find((f) => f.id.startsWith("plan:"));
	const ag = feats.find((f) => f.id === "agent:a1");
	expect(plan?.stage).toBe("issues-created"); // has a PLANE pointer
	expect(plan?.issueIdentifiers).toEqual(["ACME-1"]);
	expect(ag?.stage).toBe("review"); // ahead commit, not merged → needs land
	expect(ag?.agentIds).toEqual(["a1"]);
	expect(ag?.worktrees[0].readiness).toBe("ahead");
});
