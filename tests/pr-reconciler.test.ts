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

const AUTOCLOSE_ENV = ["OMP_SQUAD_AUTOCLOSE"] as const;
const savedAutoclose: Record<string, string | undefined> = {};
for (const k of AUTOCLOSE_ENV) savedAutoclose[k] = process.env[k];
afterEach(() => {
	for (const k of AUTOCLOSE_ENV) {
		if (savedAutoclose[k] === undefined) delete process.env[k];
		else process.env[k] = savedAutoclose[k];
	}
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

/** Same as `mergeOutOfBand`, but a real `git merge --squash` — the branch tip is NOT an ancestor of
 *  the resulting commit (squash rewrites history), same as a human clicking GitHub's Squash button. */
async function squashMergeOutOfBand(repo: string, origin: string, branch: string): Promise<{ mergeCommit: string; headOid: string }> {
	await git(repo, "push", "-q", "origin", branch);
	const headOid = await gitOut(repo, "rev-parse", branch);
	const scratch = path.join(await tmpDir("oob-squash-"), "m");
	await git(repo, "worktree", "add", "-q", "--detach", scratch, "origin/main");
	await git(scratch, "merge", "-q", "--squash", branch);
	await git(scratch, "commit", "-qm", "squash merge via GitHub UI (simulated)");
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
		// Honest tri-state: the daemon's own gate never re-ran for a merge that happened outside it, so
		// this must NOT read "green" (which would claim a re-verified gate that didn't happen).
		expect(proof?.verified).toBe("unverified");
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

test("prReconcileTick: method-agnostic assertion — a UI SQUASH merge reconciles even though this repo's configured mergeMethod is the default \"merge\"", async () => {
	await withPlane(async (patches) => {
		const stateDir = await tmpDir("reconcile-squash-state-");
		const { repo, origin } = await convergedRepo("reconcile-squash-");
		const wt = await branchWorktree(repo, "squad/a2", { "feature.txt": "new\n" });
		const issue: IssueRef = { id: "iss-squash", identifier: "PROJ-2", name: "do the squash thing", projectId: "proj-9" };
		const mgr = new TestManager({ stateDir }); // mergeMethod() defaults to "merge" — never configured to squash
		seedAgent(mgr, "a2", repo, wt, "squad/a2", { landReady: true, issue });

		// A real `git merge --squash`: the branch tip is NOT an ancestor of the resulting commit, so the
		// "merge"-method ancestry check (isAncestor(branchTip, origin/main)) fails — exactly the case that
		// used to warn "merge reachability assertion failed" every tick forever.
		const { mergeCommit, headOid } = await squashMergeOutOfBand(repo, origin, "squad/a2");
		recordPendingPr(stateDir, {
			branch: "squad/a2",
			repo: repoIdentity(repo),
			prNumber: 43,
			prUrl: "https://github.com/acme/app/pull/43",
			issueId: issue.id,
			issueIdentifier: issue.identifier,
			agentId: "a2",
			createdAt: Date.now(),
			state: "open",
		});
		prViewByNumber.set(43, { state: "MERGED", headRefOid: headOid, mergeCommit: { oid: mergeCommit } });

		await mgr.tick();

		const proof = getDoneProofByBranch(stateDir, "squad/a2");
		expect(proof).toBeDefined();
		expect(proof?.method).toBe("squash"); // reflects the check that actually held, not the configured default
		expect(proof?.verified).toBe("unverified");
		expect(proof?.detail).toContain("gh-view");
		expect(mgr.agents.get("a2")?.dto.landReady).toBe(false);
		expect(patches()).toBe(1);

		const entry = getPendingPr(stateDir, "squad/a2");
		expect(entry?.state).toBe("merged");
		expect(entry?.mergedAt).toBeDefined();
	});
});

test("prReconcileTick: closes Plane for an ORPHANED entry (its agent removed from the roster) via the ledger's persisted issueProjectId", async () => {
	await withPlane(async (patches) => {
		const stateDir = await tmpDir("reconcile-orphan-state-");
		const { repo, origin } = await convergedRepo("reconcile-orphan-");
		const wt = await branchWorktree(repo, "squad/a9", { "feature.txt": "new\n" });
		const issue: IssueRef = { id: "iss-orphan", identifier: "PROJ-9", name: "orphaned work", projectId: "proj-9" };
		const mgr = new TestManager({ stateDir });
		// The agent that pushed "squad/a9" has since been reaped/removed from the roster entirely — only
		// a DIFFERENT live agent on the same repo keeps the repo itself reachable to the reconciler.
		seedAgent(mgr, "sibling", repo, wt, undefined as unknown as string);
		expect(mgr.agents.get("a9")).toBeUndefined(); // confirm truly orphaned — no agent tracks this branch

		const { mergeCommit, headOid } = await mergeOutOfBand(repo, origin, "squad/a9");
		recordPendingPr(stateDir, {
			branch: "squad/a9",
			repo: repoIdentity(repo),
			prNumber: 77,
			prUrl: "https://github.com/acme/app/pull/77",
			issueId: issue.id,
			issueIdentifier: issue.identifier,
			issueProjectId: issue.projectId, // persisted at ensurePr time — the fix under test
			agentId: "a9",
			createdAt: Date.now(),
			state: "open",
		});
		prViewByNumber.set(77, { state: "MERGED", headRefOid: headOid, mergeCommit: { oid: mergeCommit } });

		await mgr.tick();

		expect(patches()).toBe(1); // Plane close succeeded via the synthetic IssueRef's persisted projectId
		const entry = getPendingPr(stateDir, "squad/a9");
		expect(entry?.state).toBe("merged");
		expect(entry?.issueClosedAt).toBeDefined(); // NOT stuck retrying forever
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
	// ff-heal is scoped to repos with actual ledger activity (DESIGN's "active only when ledger
	// non-empty" ruling) — a fully-resolved ("closed") entry is enough to put the repo in scope without
	// triggering any further `reconcileOnePr` work of its own (only "open"/unconfirmed-"merged" entries do).
	recordPendingPr(stateDir, { branch: "squad/a5-done", repo: repoIdentity(repo), prNumber: 1, prUrl: "https://github.com/acme/app/pull/1", createdAt: Date.now(), state: "closed" });

	await mgr.tick();

	expect(await gitOut(repo, "rev-parse", "HEAD")).toBe(originMain); // healed
});

/**
 * Now load-bearing. This used to pass vacuously: `resolveLandMode` refused pr mode outright on a
 * non-default checkout (old probe 4), so `ffHealOne` bailed at `mode !== "pr"` and never reached its
 * own `current !== defaultBranch` guard. That interlock was removed — pr mode is valid off-default —
 * so this test is the ONLY thing standing between a feature checkout and `merge --ff-only`. Verified
 * by mutation: deleting the guard in `ffHealOne` turns this test red.
 */
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
	recordPendingPr(stateDir, { branch: "squad/a6-done", repo: repoIdentity(repo), prNumber: 2, prUrl: "https://github.com/acme/app/pull/2", createdAt: Date.now(), state: "closed" });

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
	recordPendingPr(stateDir, { branch: "squad/a7-done", repo: repoIdentity(repo), prNumber: 3, prUrl: "https://github.com/acme/app/pull/3", createdAt: Date.now(), state: "closed" });

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

test("prReconcileTick: an empty ledger with a live (non-landReady) agent is still a true no-op — zero gh/git calls", async () => {
	// Regression guard: the activity gate must be derived from the ledger (∪ push-retry candidates),
	// NEVER from "every repo a live agent happens to be in" — a daemon with agents but nothing to
	// reconcile (including pure local-mode repos) must never probe `gh`/`git` on every tick.
	const stateDir = await tmpDir("reconcile-noop-liveagent-state-");
	const { repo } = await convergedRepo("reconcile-noop-liveagent-");
	const mgr = new TestManager({ stateDir });
	seedAgent(mgr, "a8", repo, repo, undefined as unknown as string); // live, but no branch/PR/ledger activity

	expect(listPendingPrs(stateDir)).toEqual([]);

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

// ── Ledger retirement (fully-confirmed entries) ────────────────────────────────────────────────

test("prReconcileTick: retires a fully-confirmed merged entry left over from a prior tick, and stops ff-healing its repo", async () => {
	// A pre-existing entry that is ALREADY fully confirmed (mergedAt + proofAt + issueClosedAt all set)
	// before this tick even runs — e.g. confirmed on a previous tick, or a leftover from before this fix
	// shipped. It must be swept even though there is nothing else in the ledger to reconcile this tick
	// (the activity gate must still open for a stale-confirmed-only ledger).
	const stateDir = await tmpDir("reconcile-retire-state-");
	const { repo } = await convergedRepo("reconcile-retire-");
	const mgr = new TestManager({ stateDir });
	seedAgent(mgr, "a10", repo, repo, undefined as unknown as string);
	recordPendingPr(stateDir, {
		branch: "squad/a10-done",
		repo: repoIdentity(repo),
		prNumber: 10,
		prUrl: "https://github.com/acme/app/pull/10",
		issueId: "iss-10",
		issueIdentifier: "PROJ-10",
		createdAt: Date.now(),
		state: "merged",
		mergedAt: Date.now(),
		proofAt: Date.now(),
		issueClosedAt: Date.now(),
	});

	await mgr.tick();

	expect(getPendingPr(stateDir, "squad/a10-done")).toBeUndefined(); // retired — no longer in the ledger
	expect(ghCalls.length).toBe(0); // fully confirmed ⇒ never even an ff-heal `gh`/`git` probe for its repo
});

test("prReconcileTick: an entry fully confirmed DURING this tick stays visible this tick, then retires next tick", async () => {
	await withPlane(async () => {
		const stateDir = await tmpDir("reconcile-retire-lag-state-");
		const { repo, origin } = await convergedRepo("reconcile-retire-lag-");
		const wt = await branchWorktree(repo, "squad/a11", { "feature.txt": "new\n" });
		const issue: IssueRef = { id: "iss-11", identifier: "PROJ-11", name: "do the thing", projectId: "proj-9" };
		const mgr = new TestManager({ stateDir });
		seedAgent(mgr, "a11", repo, wt, "squad/a11", { landReady: true, issue });

		const { mergeCommit, headOid } = await mergeOutOfBand(repo, origin, "squad/a11");
		recordPendingPr(stateDir, {
			branch: "squad/a11",
			repo: repoIdentity(repo),
			prNumber: 43,
			prUrl: "https://github.com/acme/app/pull/43",
			issueId: issue.id,
			issueIdentifier: issue.identifier,
			agentId: "a11",
			createdAt: Date.now(),
			state: "open",
		});
		prViewByNumber.set(43, { state: "MERGED", headRefOid: headOid, mergeCommit: { oid: mergeCommit } });

		await mgr.tick(); // this tick both confirms AND would otherwise be eligible for retirement
		const afterFirstTick = getPendingPr(stateDir, "squad/a11");
		expect(afterFirstTick?.state).toBe("merged");
		expect(afterFirstTick?.issueClosedAt).toBeDefined(); // fully confirmed already...

		await mgr.tick(); // ...but only retired on the NEXT tick's fresh read
		expect(getPendingPr(stateDir, "squad/a11")).toBeUndefined();
	});
});

test("prReconcileTick: a CLOSED-unmerged entry is never retired and keeps its repo in ff-heal scope", async () => {
	const stateDir = await tmpDir("reconcile-noretire-closed-state-");
	const { repo, origin } = await convergedRepo("reconcile-noretire-closed-");
	const scratch = path.join(await tmpDir("noretire-advance-"), "s");
	await git(repo, "worktree", "add", "-q", "--detach", scratch, "main");
	await fs.writeFile(path.join(scratch, "advanced.txt"), "advanced\n");
	await git(scratch, "add", "-A");
	await git(scratch, "commit", "-qm", "advance origin");
	await git(scratch, "push", "-q", "origin", "HEAD:main");
	await git(repo, "worktree", "remove", "--force", scratch);
	const originMain = await gitOut(origin, "rev-parse", "main");

	const mgr = new TestManager({ stateDir });
	seedAgent(mgr, "a12", repo, repo, undefined as unknown as string);
	recordPendingPr(stateDir, { branch: "squad/a12-closed", repo: repoIdentity(repo), prNumber: 12, prUrl: "https://github.com/acme/app/pull/12", createdAt: Date.now(), state: "closed" });

	await mgr.tick();

	expect(getPendingPr(stateDir, "squad/a12-closed")).toBeDefined(); // kept — carries surfaced state
	expect(await gitOut(repo, "rev-parse", "HEAD")).toBe(originMain); // still ff-healed — repo stayed in scope
});

// ── Autoclose disabled (OMP_SQUAD_AUTOCLOSE=0) ─────────────────────────────────────────────────

test("prReconcileTick: with autoclose off, a stranded merged entry stamps issueClosedAt (done, not retried) instead of retrying a no-op close forever", async () => {
	await withPlane(async (patches) => {
		process.env.OMP_SQUAD_AUTOCLOSE = "0"; // read at construction → closeOnDone false
		const stateDir = await tmpDir("reconcile-noautoclose-state-");
		const { repo } = await convergedRepo("reconcile-noautoclose-");
		const wt = await branchWorktree(repo, "squad/a13", { "feature.txt": "new\n" });
		const issue: IssueRef = { id: "iss-13", identifier: "PROJ-13", name: "do another thing", projectId: "proj-9" };
		const mgr = new TestManager({ stateDir });
		seedAgent(mgr, "a13", repo, wt, "squad/a13", { issue });

		recordDoneProof(stateDir, {
			branch: "squad/a13",
			repo: repoIdentity(repo),
			issueId: issue.id,
			issueIdentifier: issue.identifier,
			mode: "pr",
			method: "merge",
			commit: "c13",
			baseRef: "origin/main",
			verified: "green",
			detail: "PR merged, scratch gate green",
			provenAt: Date.now(),
			prNumber: 45,
			prUrl: "https://github.com/acme/app/pull/45",
		});
		recordPendingPr(stateDir, {
			branch: "squad/a13",
			repo: repoIdentity(repo),
			prNumber: 45,
			prUrl: "https://github.com/acme/app/pull/45",
			issueId: issue.id,
			issueIdentifier: issue.identifier,
			agentId: "a13",
			createdAt: Date.now(),
			state: "merged",
			mergedAt: Date.now(),
			proofAt: Date.now(), // proof written, close never confirmed — the stranded case, with autoclose off
		});

		await mgr.tick();
		expect(patches()).toBe(0); // autoclose off ⇒ never actually calls Plane
		const afterFirstTick = getPendingPr(stateDir, "squad/a13");
		expect(afterFirstTick?.issueClosedAt).toBeDefined(); // stamped as done, not left stranded

		await mgr.tick(); // second tick: no more retrying (already stamped), only retirement
		expect(patches()).toBe(0); // still never touched Plane — confirms "disabled" isn't retried as "failed"
	});
});
