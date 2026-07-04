/**
 * PR reconciler backstop (concern 07) — src/squad-manager.ts's `prReconcileTick` (and the private
 * `reconcileOnePr` / `retryPushFloat` / `ffHealOne` it drives). `landAgentPr` (concern 06) writes truth
 * synchronously at merge-click; this loop is a BACKSTOP for the one case that path can't see (a human
 * merging/closing a PR directly in GitHub's UI) plus the crash-ordering windows it can leave stranded.
 *
 * Real git in tmp dirs + a real bare "origin" remote (mirrors land-mode.test.ts's / land-pr.test.ts's
 * convention); only `gh` is module-mocked. `closePlaneIssue` hits a real, local, in-process Plane HTTP
 * stub (mirrors close-landed-issue-proof.test.ts) so the reconciler's Plane close is proven to run the
 * SAME code path concern 04 already tested, not a re-implementation.
 */

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SubagentTracker } from "../src/subagents.ts";
import { repoIdentity } from "../src/repo-identity.ts";
import type { AgentDTO, IssueRef, PersistedAgent } from "../src/types.ts";

interface GhPr {
	state: "OPEN" | "CLOSED" | "MERGED";
	headRefOid?: string;
	mergeCommit?: { oid: string };
}

let prViewByNumber = new Map<number, GhPr>();
let prListResponse: { number: number; url: string; state: string }[] = [];
let nextPrNumber = 900;
const ghCalls: string[][] = [];

async function mockGh(args: string[], _cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
	ghCalls.push(args);
	if (args[0] === "pr" && args[1] === "view") {
		const num = Number(args[2]);
		const pr = prViewByNumber.get(num);
		return pr ? { code: 0, stdout: JSON.stringify(pr), stderr: "" } : { code: 1, stdout: "", stderr: "pr not found (simulated)" };
	}
	if (args[0] === "pr" && args[1] === "list") return { code: 0, stdout: JSON.stringify(prListResponse), stderr: "" };
	if (args[0] === "pr" && args[1] === "create") {
		const num = nextPrNumber++;
		return { code: 0, stdout: `https://github.com/acme/app/pull/${num}\n`, stderr: "" };
	}
	return { code: 0, stdout: "", stderr: "" };
}

mock.module("../src/gh.ts", () => ({
	gh: mockGh,
	ghJson: async (args: string[], cwd: string) => {
		const r = await mockGh(args, cwd);
		return r.code === 0 ? JSON.parse(r.stdout || "{}") : undefined;
	},
	ghAvailable: async () => true,
}));

const { SquadManager } = await import("../src/squad-manager.ts");
const { recordPendingPr, getPendingPr, listPendingPrs } = await import("../src/land-pr.ts");
const { recordDoneProof, getDoneProofByBranch } = await import("../src/done-proof.ts");

/** Force PR mode deterministically via the `resolveLandModeFor` seam — see land-seam.test.ts for why
 *  this sidesteps `bun test`'s process-wide `mock.module` collision with land-mode.ts. */
class TestManager extends SquadManager {
	forcedDefaultBranch: string | undefined = "main";
	protected resolveLandModeFor(_repo: string): Promise<{ mode: "pr" | "local"; defaultBranch?: string; reason: string }> {
		return Promise.resolve(
			this.forcedDefaultBranch
				? { mode: "pr", defaultBranch: this.forcedDefaultBranch, reason: "forced for reconciler test" }
				: { mode: "local", reason: "forced local for reconciler test" },
		);
	}
	tick(): Promise<void> {
		return (this as unknown as { prReconcileTick(): Promise<void> }).prReconcileTick();
	}
}

beforeEach(() => {
	prViewByNumber = new Map();
	prListResponse = [];
	nextPrNumber = 900;
	ghCalls.length = 0;
});

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function tmpDir(prefix: string): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(d);
	return d;
}

async function git(cwd: string, ...a: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const p = Bun.spawn(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function gitOut(cwd: string, ...a: string[]): Promise<string> {
	return (await git(cwd, ...a)).stdout;
}

/** A repo checked out on `main`, converged with a real bare origin. */
async function convergedRepo(prefix: string): Promise<{ repo: string; origin: string }> {
	const repo = await tmpDir(prefix);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "base.txt"), "base\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	const origin = await tmpDir(`${prefix}origin-`);
	await git(origin, "init", "-q", "--bare");
	await git(repo, "remote", "add", "origin", origin);
	await git(repo, "push", "-q", "origin", "main");
	return { repo, origin };
}

async function branchWorktree(repo: string, branch: string, files: Record<string, string>): Promise<string> {
	const dir = path.join(await tmpDir(`${branch.replace(/\//g, "-")}-wt-`), "wt");
	await git(repo, "worktree", "add", "-q", "-b", branch, dir, "main");
	for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(dir, name), content);
	await git(dir, "add", "-A");
	await git(dir, "commit", "-qm", `${branch} changes`);
	return dir;
}

/** Push `branch` to `origin`, then merge it into origin's `main` DIRECTLY (bypassing the daemon
 *  entirely) — simulates a human clicking merge in GitHub's UI. Returns the merge commit sha. */
async function mergeOutOfBand(repo: string, origin: string, branch: string): Promise<{ mergeCommit: string; headOid: string }> {
	await git(repo, "push", "-q", "origin", branch);
	const headOid = await gitOut(repo, "rev-parse", branch);
	const scratch = path.join(await tmpDir("oob-merge-"), "m");
	await git(repo, "worktree", "add", "-q", "--detach", scratch, "origin/main");
	await git(scratch, "merge", "-q", "--no-ff", branch, "-m", "merge via GitHub UI (simulated)");
	const mergeCommit = await gitOut(scratch, "rev-parse", "HEAD");
	await git(scratch, "push", "-q", "origin", "HEAD:main");
	await git(repo, "worktree", "remove", "--force", scratch);
	return { mergeCommit, headOid };
}

function seedAgent(
	mgr: InstanceType<typeof SquadManager>,
	id: string,
	repo: string,
	worktree: string,
	branch: string,
	opts: { landReady?: boolean; issue?: IssueRef } = {},
): void {
	const dto: AgentDTO = {
		id,
		name: id,
		status: "idle",
		kind: "omp-operator",
		repo,
		worktree,
		branch,
		approvalMode: "yolo",
		pending: [],
		lastActivity: 0,
		messageCount: 0,
		landReady: opts.landReady,
		issue: opts.issue,
	};
	const options: PersistedAgent = { id, name: id, repo, worktree, approvalMode: "yolo" };
	mgr.agents.set(id, { dto, agent: undefined as never, options, transcript: [], assistantBuf: "", streaming: false, subs: new SubagentTracker(), toolEntries: new Map() } as never);
}

/** Minimal Plane HTTP stub: GET .../states/ advertises a completed group; PATCH counts as a close. */
function planeStub(): { server: ReturnType<typeof Bun.serve>; patches: () => number } {
	let patches = 0;
	const server = Bun.serve({
		port: 0,
		fetch: (req) => {
			const url = new URL(req.url);
			if (req.method === "GET" && url.pathname.endsWith("/states/")) {
				return Response.json({ results: [{ id: "s-done", group: "completed" }] });
			}
			if (req.method === "PATCH") {
				patches++;
				return Response.json({ ok: true });
			}
			return new Response("no", { status: 404 });
		},
	});
	return { server, patches: () => patches };
}

async function withPlane<T>(fn: (patches: () => number) => Promise<T>): Promise<T> {
	const { server, patches } = planeStub();
	const saved = { key: process.env.PLANE_API_KEY, ws: process.env.PLANE_WORKSPACE, base: process.env.PLANE_BASE_URL };
	process.env.PLANE_API_KEY = "secret";
	process.env.PLANE_WORKSPACE = "acme";
	process.env.PLANE_BASE_URL = `http://127.0.0.1:${server.port}`;
	try {
		return await fn(patches);
	} finally {
		server.stop(true);
		if (saved.key === undefined) delete process.env.PLANE_API_KEY;
		else process.env.PLANE_API_KEY = saved.key;
		if (saved.ws === undefined) delete process.env.PLANE_WORKSPACE;
		else process.env.PLANE_WORKSPACE = saved.ws;
		if (saved.base === undefined) delete process.env.PLANE_BASE_URL;
		else process.env.PLANE_BASE_URL = saved.base;
	}
}

// ── Out-of-band merge ───────────────────────────────────────────────────────────────────────────

test("prReconcileTick: out-of-band GitHub-UI merge writes DoneProof, clears landReady, closes Plane, updates ledger", async () => {
	await withPlane(async (patches) => {
		const stateDir = await tmpDir("reconcile-oob-state-");
		const { repo, origin } = await convergedRepo("reconcile-oob-");
		const wt = await branchWorktree(repo, "squad/a1", { "feature.txt": "new\n" });
		const issue: IssueRef = { id: "iss-oob", identifier: "PROJ-1", name: "do the thing", projectId: "proj-9" };
		const mgr = new TestManager({ stateDir });
		seedAgent(mgr, "a1", repo, wt, "squad/a1", { landReady: true, issue });

		const { mergeCommit, headOid } = await mergeOutOfBand(repo, origin, "squad/a1");
		recordPendingPr(stateDir, {
			branch: "squad/a1",
			repo: repoIdentity(repo),
			prNumber: 42,
			prUrl: "https://github.com/acme/app/pull/42",
			issueId: issue.id,
			issueIdentifier: issue.identifier,
			agentId: "a1",
			createdAt: Date.now(),
			state: "open",
		});
		prViewByNumber.set(42, { state: "MERGED", headRefOid: headOid, mergeCommit: { oid: mergeCommit } });

		await mgr.tick();

		const proof = getDoneProofByBranch(stateDir, "squad/a1");
		expect(proof?.verified).toBe("green");
		expect(proof?.mode).toBe("pr");
		expect(proof?.detail).toContain("out-of-band");
		expect(mgr.agents.get("a1")?.dto.landReady).toBe(false);
		expect(patches()).toBe(1); // Plane close happened exactly once

		const entry = getPendingPr(stateDir, "squad/a1");
		expect(entry?.state).toBe("merged");
		expect(entry?.mergedAt).toBeDefined();
		expect(entry?.proofAt).toBeDefined();
		expect(entry?.issueClosedAt).toBeDefined(); // close succeeded synchronously within this tick
	});
});

// ── Closed-unmerged ─────────────────────────────────────────────────────────────────────────────

test("prReconcileTick: a PR closed without merging is marked closed, but branch/landReady stay intact", async () => {
	const stateDir = await tmpDir("reconcile-closed-state-");
	const { repo } = await convergedRepo("reconcile-closed-");
	const wt = await branchWorktree(repo, "squad/a2", { "feature.txt": "new\n" });
	const mgr = new TestManager({ stateDir });
	seedAgent(mgr, "a2", repo, wt, "squad/a2", { landReady: true });

	recordPendingPr(stateDir, {
		branch: "squad/a2",
		repo: repoIdentity(repo),
		prNumber: 43,
		prUrl: "https://github.com/acme/app/pull/43",
		agentId: "a2",
		createdAt: Date.now(),
		state: "open",
	});
	prViewByNumber.set(43, { state: "CLOSED" });

	await mgr.tick();

	expect(getPendingPr(stateDir, "squad/a2")?.state).toBe("closed");
	expect(mgr.agents.get("a2")?.dto.landReady).toBe(true); // untouched — human decides, re-Land opens a fresh PR
	expect(mgr.agents.get("a2")?.dto.branch).toBe("squad/a2"); // branch untouched
});

// ── Close-retry (crash-ordering idempotency) ───────────────────────────────────────────────────────

test("prReconcileTick: retries a stranded Plane close (proofAt set, issueClosedAt unset), then stays idempotent", async () => {
	await withPlane(async (patches) => {
		const stateDir = await tmpDir("reconcile-retry-state-");
		const { repo } = await convergedRepo("reconcile-retry-");
		const wt = await branchWorktree(repo, "squad/a3", { "feature.txt": "new\n" });
		const issue: IssueRef = { id: "iss-retry", identifier: "PROJ-2", name: "do another thing", projectId: "proj-9" };
		const mgr = new TestManager({ stateDir });
		// Seed a bystander agent purely so repoPathForIdentity can resolve the ledger entry's repo
		// identity back to a filesystem path without needing real Plane project config.
		seedAgent(mgr, "a3", repo, wt, "squad/a3", { issue });

		recordDoneProof(stateDir, {
			branch: "squad/a3",
			repo: repoIdentity(repo),
			issueId: issue.id,
			issueIdentifier: issue.identifier,
			mode: "pr",
			method: "merge",
			commit: "c3",
			baseRef: "origin/main",
			verified: "green",
			detail: "PR merged, scratch gate green",
			provenAt: Date.now(),
			prNumber: 44,
			prUrl: "https://github.com/acme/app/pull/44",
		});
		recordPendingPr(stateDir, {
			branch: "squad/a3",
			repo: repoIdentity(repo),
			prNumber: 44,
			prUrl: "https://github.com/acme/app/pull/44",
			issueId: issue.id,
			issueIdentifier: issue.identifier,
			agentId: "a3",
			createdAt: Date.now(),
			state: "merged",
			mergedAt: Date.now(),
			proofAt: Date.now(), // proof written, Plane close never confirmed — the stranded case
		});

		await mgr.tick();
		expect(patches()).toBe(1);
		expect(getPendingPr(stateDir, "squad/a3")?.issueClosedAt).toBeDefined();

		await mgr.tick(); // a second tick must NOT close again — the ledger's issueClosedAt now excludes it
		expect(patches()).toBe(1);
	});
});

// ── Push-retry ──────────────────────────────────────────────────────────────────────────────────

test("prReconcileTick: a landReady agent with no ledger entry gets ensurePr retried exactly once per tick", async () => {
	const stateDir = await tmpDir("reconcile-push-state-");
	const { repo, origin } = await convergedRepo("reconcile-push-");
	const wt = await branchWorktree(repo, "squad/a4", { "feature.txt": "new\n" });
	const mgr = new TestManager({ stateDir });
	seedAgent(mgr, "a4", repo, wt, "squad/a4", { landReady: true });

	expect(listPendingPrs(stateDir)).toEqual([]);

	await mgr.tick();

	const createCallsAfterFirst = ghCalls.filter((a) => a[0] === "pr" && a[1] === "create").length;
	expect(createCallsAfterFirst).toBe(1);
	expect(mgr.agents.get("a4")?.dto.prUrl).toBeDefined();
	expect(mgr.agents.get("a4")?.dto.prState).toBe("draft");
	expect(await gitOut(origin, "rev-parse", "refs/heads/squad/a4")).toBe(await gitOut(repo, "rev-parse", "squad/a4"));

	await mgr.tick(); // ledger entry now exists ⇒ no second create
	const createCallsAfterSecond = ghCalls.filter((a) => a[0] === "pr" && a[1] === "create").length;
	expect(createCallsAfterSecond).toBe(1);
});

// ── ff-heal ─────────────────────────────────────────────────────────────────────────────────────

test("prReconcileTick: ff-heals a repo strictly behind origin/<default> while checked out on it", async () => {
	const stateDir = await tmpDir("reconcile-ffheal-state-");
	const { repo, origin } = await convergedRepo("reconcile-ffheal-");
	// Advance origin/main directly (as if another push landed there) without touching `repo`'s checkout.
	const scratch = path.join(await tmpDir("ffheal-advance-"), "s");
	await git(repo, "worktree", "add", "-q", "--detach", scratch, "main");
	await fs.writeFile(path.join(scratch, "advanced.txt"), "advanced\n");
	await git(scratch, "add", "-A");
	await git(scratch, "commit", "-qm", "advance origin");
	await git(scratch, "push", "-q", "origin", "HEAD:main");
	await git(repo, "worktree", "remove", "--force", scratch);
	const localHeadBefore = await gitOut(repo, "rev-parse", "HEAD");
	const originMain = await gitOut(origin, "rev-parse", "main");
	expect(localHeadBefore).not.toBe(originMain);

	const mgr = new TestManager({ stateDir });
	// No branch/worktree needed — ffHealOne only cares about the repo's own primary checkout. Reuse
	// `repo` itself as a stand-in "worktree" so seedAgent's shape is satisfied.
	seedAgent(mgr, "a5", repo, repo, undefined as unknown as string);

	await mgr.tick();

	expect(await gitOut(repo, "rev-parse", "HEAD")).toBe(originMain); // healed
});

test("prReconcileTick: does NOT ff-heal a repo checked out on a non-default branch", async () => {
	const stateDir = await tmpDir("reconcile-ffheal-nondefault-state-");
	const { repo, origin } = await convergedRepo("reconcile-ffheal-nondefault-");
	await git(repo, "checkout", "-q", "-b", "other");
	const scratch = path.join(await tmpDir("ffheal-advance2-"), "s");
	await git(repo, "worktree", "add", "-q", "--detach", scratch, "main");
	await fs.writeFile(path.join(scratch, "advanced.txt"), "advanced\n");
	await git(scratch, "add", "-A");
	await git(scratch, "commit", "-qm", "advance origin");
	await git(scratch, "push", "-q", "origin", "HEAD:main");
	await git(repo, "worktree", "remove", "--force", scratch);
	const localHeadBefore = await gitOut(repo, "rev-parse", "HEAD");

	const mgr = new TestManager({ stateDir });
	seedAgent(mgr, "a6", repo, repo, undefined as unknown as string);

	await mgr.tick();

	expect(await gitOut(repo, "rev-parse", "HEAD")).toBe(localHeadBefore); // untouched — deliberate non-default checkout wins
	expect(await gitOut(origin, "rev-parse", "main")).not.toBe(localHeadBefore);
});

test("prReconcileTick: does NOT ff-heal a repo that is ahead of origin/<default>", async () => {
	const stateDir = await tmpDir("reconcile-ffheal-ahead-state-");
	const { repo } = await convergedRepo("reconcile-ffheal-ahead-");
	await fs.writeFile(path.join(repo, "local-only.txt"), "local\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "local-only, unpushed");
	const localHeadBefore = await gitOut(repo, "rev-parse", "HEAD");

	const mgr = new TestManager({ stateDir });
	seedAgent(mgr, "a7", repo, repo, undefined as unknown as string);

	await mgr.tick();

	expect(await gitOut(repo, "rev-parse", "HEAD")).toBe(localHeadBefore); // ahead — never touched
});

// ── No-op guard ─────────────────────────────────────────────────────────────────────────────────

test("prReconcileTick: an empty ledger and roster is a true no-op — zero gh/git calls", async () => {
	const stateDir = await tmpDir("reconcile-noop-state-");
	const mgr = new TestManager({ stateDir });

	const realSpawn = Bun.spawn.bind(Bun);
	let spawnedGit = false;
	// @ts-expect-error — test-only monkeypatch to observe whether ANY real subprocess call happens.
	Bun.spawn = (argv: unknown, opts?: unknown) => {
		if (Array.isArray(argv) && argv[0] === "git") spawnedGit = true;
		// biome-ignore lint: forwarding to the real implementation
		return realSpawn(argv as never, opts as never);
	};
	try {
		await mgr.tick();
	} finally {
		Bun.spawn = realSpawn;
	}

	expect(spawnedGit).toBe(false);
	expect(ghCalls.length).toBe(0);
});
