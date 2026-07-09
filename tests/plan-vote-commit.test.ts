/**
 * Commit-on-pass (PLAN-VOTE-COMMIT.md §D/§H3) — `SquadManager#onVotePassed`, the seam V2 left as a
 * no-op. A PASSED vote must COMMIT the plan-doc revision to the operator checkout, scoped to the one
 * reviewed file; a REJECTED vote must never touch the shared tree at all. The money-shot assertion in
 * every "committed" test is a real `git log` on the real operator checkout — not a mock.
 *
 * `revisionSha` here is a real commit on a real local branch in the SAME repo as the operator
 * checkout: every squad worktree is a `git worktree add` of one repo, so its history (and this test's
 * fixture branch) is reachable from the main checkout by SHA alone, exactly as `onVotePassed` assumes.
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileStore } from "../src/dal/store.ts";
import { withRepoLandLock } from "../src/land.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { PlanVoteRound, SquadEvent } from "../src/types.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function git(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`);
	return { code, stdout: stdout.trim(), stderr };
}

const PLAN_PATH = "plans/ctx/01-spec.md";

/** A real git repo (the "operator checkout") with a committed plan doc on its default branch, plus a
 *  "squad/reviser-1" branch carrying a real edit to that doc — the shape `onVotePassed` lands. */
async function repoFixture(opts: { revisedContent?: string } = {}): Promise<{ repo: string; baseSha: string; revisionSha: string }> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "plan-vote-commit-repo-"));
	await git(["init", "-q"], repo);
	await git(["config", "user.email", "t@t"], repo);
	await git(["config", "user.name", "t"], repo);
	await fs.mkdir(path.join(repo, "plans", "ctx"), { recursive: true });
	await fs.writeFile(path.join(repo, PLAN_PATH), "# Spec\n\nOriginal content.\n");
	await git(["add", "-A"], repo);
	await git(["commit", "-m", "init"], repo);
	const defaultBranch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], repo)).stdout;
	const baseSha = (await git(["rev-parse", "HEAD"], repo)).stdout;

	await git(["checkout", "-b", "squad/reviser-1"], repo);
	await fs.writeFile(path.join(repo, PLAN_PATH), opts.revisedContent ?? "# Spec\n\nReviewed and tightened content.\n");
	await git(["add", "-A"], repo);
	await git(["commit", "-m", "revise the spec"], repo);
	const revisionSha = (await git(["rev-parse", "HEAD"], repo)).stdout;
	await git(["checkout", defaultBranch], repo);

	return { repo, baseSha, revisionSha };
}

async function managerFixture(): Promise<SquadManager> {
	const state = await fs.mkdtemp(path.join(os.tmpdir(), "plan-vote-commit-state-"));
	const manager = new SquadManager({ stateDir: state, store: new FileStore(state) });
	cleanups.push(async () => {
		await manager.stop();
		await fs.rm(state, { recursive: true, force: true });
	});
	return manager;
}

function registerRepoCleanup(repo: string): void {
	cleanups.push(async () => fs.rm(repo, { recursive: true, force: true }));
}

// ── the money-shot: PASS commits ──────────────────────────────────────────────────────────────────

test("PASS commits the plan-doc revision to the operator checkout — git log proves it, trailers included", async () => {
	const { repo, baseSha, revisionSha } = await repoFixture();
	registerRepoCleanup(repo);
	const manager = await managerFixture();

	const candidate = await manager.addPlanRevisionCandidate({ repo, featureId: "feat1", planPath: PLAN_PATH, summary: "tighten the plan wording" });
	const opened = await manager.openPlanVote({ featureId: "feat1", repo, planPath: PLAN_PATH, candidateId: candidate.id, baseSha, revisionSha, assignees: ["db:u1", "db:u2"], openedBy: "db:u1" });
	if ("conflict" in opened) throw new Error("unexpected conflict");

	await manager.castPlanVote("feat1", opened.id, "db:u1", "approve", "db:u1"); // 1/2 — not yet decided
	const { round } = await manager.castPlanVote("feat1", opened.id, "db:u2", "approve", "db:u2"); // 2/2 — passes, commits
	expect(round.state).toBe("passed");

	const closed = (await manager.listPlanVoteRounds({ repo, featureId: "feat1" })).find((r) => r.id === opened.id)!;
	expect(closed.commitOutcome).toBe("committed");
	expect(closed.commitSha).toBeTruthy();

	// The real evidence: a real commit on the real operator checkout.
	const log = await git(["log", "-1", "--format=%H%n%B", "--", PLAN_PATH], repo);
	expect(log.stdout).toContain(closed.commitSha!);
	expect(log.stdout).toContain("plan(plans/ctx): adopt reviewed revision — tighten the plan wording");
	expect(log.stdout).toContain("Approved-by: db:u1");
	expect(log.stdout).toContain("Approved-by: db:u2");
	expect(log.stdout).toContain(`Vote-round: ${opened.id}`);

	const content = await fs.readFile(path.join(repo, PLAN_PATH), "utf8");
	expect(content).toBe("# Spec\n\nReviewed and tightened content.\n");

	const status = await git(["status", "--porcelain"], repo);
	expect(status.stdout).toBe(""); // clean — landed, nothing left dangling

	const candidates = await manager.listPlanRevisionCandidates({ repo, featureId: "feat1" });
	expect(candidates.find((c) => c.id === candidate.id)?.state).toBe("accepted");
});

test("audits plan-vote.commit on a landed pass", async () => {
	const { repo, baseSha, revisionSha } = await repoFixture();
	registerRepoCleanup(repo);
	const manager = await managerFixture();
	const events: SquadEvent[] = [];
	manager.on("event", (e) => events.push(e as SquadEvent));

	const candidate = await manager.addPlanRevisionCandidate({ repo, featureId: "feat1", planPath: PLAN_PATH, summary: "x" });
	const opened = await manager.openPlanVote({ featureId: "feat1", repo, planPath: PLAN_PATH, candidateId: candidate.id, baseSha, revisionSha, assignees: ["local"], openedBy: "local" });
	if ("conflict" in opened) throw new Error("unexpected conflict");
	await manager.castPlanVote("feat1", opened.id, "local", "approve", "local");

	await new Promise((r) => setTimeout(r, 0)); // recordAudit's own emit is fire-and-forget
	const actions = events.filter((e) => e.type === "audit").map((e) => (e as { entry: { action: string; outcome: string } }).entry);
	expect(actions.find((a) => a.action === "plan-vote.commit" && a.outcome === "ok")).toBeTruthy();
});

// ── idempotency (defense-in-depth: V2's per-feature lock makes onVotePassed fire once; this proves a
// second, non-locked invocation — e.g. a crash-and-retry — is STILL a safe no-op) ───────────────────

test("idempotent: a second onVotePassed for an already-committed round is a pure no-op (no second commit)", async () => {
	const { repo, baseSha, revisionSha } = await repoFixture();
	registerRepoCleanup(repo);
	const manager = await managerFixture();
	const privileged = manager as unknown as { onVotePassed(round: PlanVoteRound): Promise<void> };

	const candidate = await manager.addPlanRevisionCandidate({ repo, featureId: "feat1", planPath: PLAN_PATH, summary: "solo pass" });
	const opened = await manager.openPlanVote({ featureId: "feat1", repo, planPath: PLAN_PATH, candidateId: candidate.id, baseSha, revisionSha, assignees: ["local"], openedBy: "local" });
	if ("conflict" in opened) throw new Error("unexpected conflict");
	const { round } = await manager.castPlanVote("feat1", opened.id, "local", "approve", "local"); // sole assignee auto-pass, commits
	expect(round.state).toBe("passed");

	const afterFirst = (await manager.listPlanVoteRounds({ repo, featureId: "feat1" })).find((r) => r.id === opened.id)!;
	const firstSha = afterFirst.commitSha;
	expect(firstSha).toBeTruthy();

	await privileged.onVotePassed(afterFirst); // simulate a future non-locked / crash-and-retry re-invocation

	const afterSecond = (await manager.listPlanVoteRounds({ repo, featureId: "feat1" })).find((r) => r.id === opened.id)!;
	expect(afterSecond.commitSha).toBe(firstSha); // unchanged

	const log = await git(["log", "--oneline", "--", PLAN_PATH], repo);
	expect(log.stdout.split("\n").filter(Boolean)).toHaveLength(2); // init + the ONE adopt commit — never two

	const candidates = await manager.listPlanRevisionCandidates({ repo, featureId: "feat1" });
	expect(candidates.find((c) => c.id === candidate.id)?.state).toBe("accepted"); // not re-transitioned either
});

// ── the base-SHA guard (§H3 — mandatory) ─────────────────────────────────────────────────────────

test("base-SHA guard: the plan doc moved under the vote → REFUSES to commit, round + candidate marked superseded", async () => {
	const { repo, baseSha, revisionSha } = await repoFixture();
	registerRepoCleanup(repo);
	const manager = await managerFixture();

	const candidate = await manager.addPlanRevisionCandidate({ repo, featureId: "feat1", planPath: PLAN_PATH, summary: "should never land" });
	const opened = await manager.openPlanVote({ featureId: "feat1", repo, planPath: PLAN_PATH, candidateId: candidate.id, baseSha, revisionSha, assignees: ["local"], openedBy: "local" });
	if ("conflict" in opened) throw new Error("unexpected conflict");

	// The doc changed under the voters — someone committed to it while the vote was open.
	await fs.writeFile(path.join(repo, PLAN_PATH), "# Spec\n\nA DIFFERENT concurrent edit.\n");
	await git(["add", "-A"], repo);
	await git(["commit", "-m", "an unrelated concurrent edit"], repo);

	const { round } = await manager.castPlanVote("feat1", opened.id, "local", "approve", "local");
	expect(round.state).toBe("passed"); // the VOTE still passed — quorum math is untouched by this guard...

	// ...but commit-on-pass refuses to land it.
	const closed = (await manager.listPlanVoteRounds({ repo, featureId: "feat1" })).find((r) => r.id === opened.id)!;
	expect(closed.commitOutcome).toBe("superseded");
	expect(closed.commitSha).toBeUndefined();
	expect(closed.commitDetail).toContain("re-call the vote");

	const candidates = await manager.listPlanRevisionCandidates({ repo, featureId: "feat1" });
	expect(candidates.find((c) => c.id === candidate.id)?.state).toBe("superseded");

	const content = await fs.readFile(path.join(repo, PLAN_PATH), "utf8");
	expect(content).toBe("# Spec\n\nA DIFFERENT concurrent edit.\n"); // untouched by the refused commit

	const log = await git(["log", "--oneline", "--", PLAN_PATH], repo);
	expect(log.stdout.split("\n").filter(Boolean)).toHaveLength(2); // init + the concurrent edit — never a 3rd
});

test("audits plan-vote.superseded on a base-SHA refusal", async () => {
	const { repo, baseSha, revisionSha } = await repoFixture();
	registerRepoCleanup(repo);
	const manager = await managerFixture();
	const events: SquadEvent[] = [];
	manager.on("event", (e) => events.push(e as SquadEvent));

	const candidate = await manager.addPlanRevisionCandidate({ repo, featureId: "feat1", planPath: PLAN_PATH, summary: "x" });
	const opened = await manager.openPlanVote({ featureId: "feat1", repo, planPath: PLAN_PATH, candidateId: candidate.id, baseSha, revisionSha, assignees: ["local"], openedBy: "local" });
	if ("conflict" in opened) throw new Error("unexpected conflict");
	// planDocHeadRevision is scoped to commits that TOUCH this path — an empty commit wouldn't move it,
	// so actually edit the doc to advance its head SHA out from under the vote.
	await fs.writeFile(path.join(repo, PLAN_PATH), "# Spec\n\nmoved out from under the vote.\n");
	await git(["add", "-A"], repo);
	await git(["commit", "-m", "moves the doc's head SHA"], repo);

	await manager.castPlanVote("feat1", opened.id, "local", "approve", "local");
	await new Promise((r) => setTimeout(r, 0));
	const actions = events.filter((e) => e.type === "audit").map((e) => (e as { entry: { action: string; outcome: string } }).entry);
	expect(actions.find((a) => a.action === "plan-vote.superseded" && a.outcome === "error")).toBeTruthy();
});

// ── REJECT: the shared tree is never touched ─────────────────────────────────────────────────────

test("REJECT never touches the shared tree — git status stays clean, candidate rejected, no commit added", async () => {
	const { repo, baseSha, revisionSha } = await repoFixture();
	registerRepoCleanup(repo);
	const manager = await managerFixture();

	const candidate = await manager.addPlanRevisionCandidate({ repo, featureId: "feat1", planPath: PLAN_PATH, summary: "a change nobody wants" });
	const opened = await manager.openPlanVote({ featureId: "feat1", repo, planPath: PLAN_PATH, candidateId: candidate.id, baseSha, revisionSha, assignees: ["db:u1", "db:u2", "db:u3"], openedBy: "db:u1" });
	if ("conflict" in opened) throw new Error("unexpected conflict");

	await manager.castPlanVote("feat1", opened.id, "db:u1", "reject", "db:u1");
	const { round } = await manager.castPlanVote("feat1", opened.id, "db:u2", "reject", "db:u2");
	expect(round.state).toBe("rejected");

	const candidates = await manager.listPlanRevisionCandidates({ repo, featureId: "feat1" });
	expect(candidates.find((c) => c.id === candidate.id)?.state).toBe("rejected");

	// Nothing to revert: the edit only ever lived on the candidate's producer branch (never merged,
	// never applied to the working tree) — a reject discards it by simply never touching main at all.
	const status = await git(["status", "--porcelain"], repo);
	expect(status.stdout).toBe("");
	const content = await fs.readFile(path.join(repo, PLAN_PATH), "utf8");
	expect(content).toBe("# Spec\n\nOriginal content.\n");
	const log = await git(["log", "--oneline", "--", PLAN_PATH], repo);
	expect(log.stdout.split("\n").filter(Boolean)).toHaveLength(1); // only ever the init commit

	// onVotePassed never runs on a reject — no commit-outcome marker at all.
	const closed = (await manager.listPlanVoteRounds({ repo, featureId: "feat1" })).find((r) => r.id === opened.id)!;
	expect(closed.commitOutcome).toBeUndefined();
});

// ── edge cases the guard must degrade honestly on, never silently ───────────────────────────────

test("no resolvable revision (producer branch/worktree already gone) → failed outcome, candidate left for a human, tree untouched", async () => {
	const { repo, baseSha } = await repoFixture();
	registerRepoCleanup(repo);
	const manager = await managerFixture();

	const candidate = await manager.addPlanRevisionCandidate({ repo, featureId: "feat1", planPath: PLAN_PATH, summary: "orphaned" });
	const opened = await manager.openPlanVote({ featureId: "feat1", repo, planPath: PLAN_PATH, candidateId: candidate.id, baseSha, revisionSha: "", assignees: ["local"], openedBy: "local" });
	if ("conflict" in opened) throw new Error("unexpected conflict");

	const { round } = await manager.castPlanVote("feat1", opened.id, "local", "approve", "local");
	expect(round.state).toBe("passed");

	const closed = (await manager.listPlanVoteRounds({ repo, featureId: "feat1" })).find((r) => r.id === opened.id)!;
	expect(closed.commitOutcome).toBe("failed");
	expect(closed.commitDetail).toContain("no revision to land");

	const candidates = await manager.listPlanRevisionCandidates({ repo, featureId: "feat1" });
	expect(candidates.find((c) => c.id === candidate.id)?.state).toBe("candidate"); // left as-is, not silently accepted

	const status = await git(["status", "--porcelain"], repo);
	expect(status.stdout).toBe("");
});

test("a revisionSha that no longer resolves in the repo (worktree object horizon gone) → failed, never a throw", async () => {
	const { repo, baseSha } = await repoFixture();
	registerRepoCleanup(repo);
	const manager = await managerFixture();

	const bogusSha = "0".repeat(40);
	const candidate = await manager.addPlanRevisionCandidate({ repo, featureId: "feat1", planPath: PLAN_PATH, summary: "x" });
	const opened = await manager.openPlanVote({ featureId: "feat1", repo, planPath: PLAN_PATH, candidateId: candidate.id, baseSha, revisionSha: bogusSha, assignees: ["local"], openedBy: "local" });
	if ("conflict" in opened) throw new Error("unexpected conflict");

	await manager.castPlanVote("feat1", opened.id, "local", "approve", "local");

	const closed = (await manager.listPlanVoteRounds({ repo, featureId: "feat1" })).find((r) => r.id === opened.id)!;
	expect(closed.commitOutcome).toBe("failed");
	expect(closed.commitDetail).toContain("not a reachable commit");
});

test("identical revision content still accepts the candidate against the existing HEAD (no-op commit, not superseded)", async () => {
	const { repo, baseSha } = await repoFixture();
	registerRepoCleanup(repo);
	const manager = await managerFixture();

	// revisionSha points at the SAME commit as baseSha — the simplest honest case of "the reviser's
	// revision carries no actual content change" (no divergent branch needed to prove this path).
	const candidate = await manager.addPlanRevisionCandidate({ repo, featureId: "feat1", planPath: PLAN_PATH, summary: "no actual change" });
	const opened = await manager.openPlanVote({ featureId: "feat1", repo, planPath: PLAN_PATH, candidateId: candidate.id, baseSha, revisionSha: baseSha, assignees: ["local"], openedBy: "local" });
	if ("conflict" in opened) throw new Error("unexpected conflict");

	await manager.castPlanVote("feat1", opened.id, "local", "approve", "local");

	const closed = (await manager.listPlanVoteRounds({ repo, featureId: "feat1" })).find((r) => r.id === opened.id)!;
	expect(closed.commitOutcome).toBe("committed");
	expect(closed.commitSha).toBe(baseSha); // nothing new to land — HEAD didn't move

	const candidates = await manager.listPlanRevisionCandidates({ repo, featureId: "feat1" });
	expect(candidates.find((c) => c.id === candidate.id)?.state).toBe("accepted");

	const log = await git(["log", "--oneline", "--", PLAN_PATH], repo);
	expect(log.stdout.split("\n").filter(Boolean)).toHaveLength(1); // no new commit added
});

// ══ SECURITY REVIEW FIXES (cross-lineage review on PR #144) ═════════════════════════════════════

// HIGH 1b — even if a non-plan-doc candidate somehow exists in storage (bypassing the creation
// gate), onVotePassed REFUSES to commit it. Proves the vote can never commit source/config code.
test("HIGH 1b: onVotePassed refuses a non-plan-doc path (never commits code), even with a real revision", async () => {
	const CODE_PATH = "src/server.ts";
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "plan-vote-commit-code-"));
	registerRepoCleanup(repo);
	await git(["init", "-q"], repo);
	await git(["config", "user.email", "t@t"], repo);
	await git(["config", "user.name", "t"], repo);
	await fs.mkdir(path.join(repo, "src"), { recursive: true });
	await fs.writeFile(path.join(repo, CODE_PATH), "export const real = 1;\n");
	await git(["add", "-A"], repo);
	await git(["commit", "-m", "init"], repo);
	const defaultBranch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], repo)).stdout;
	const baseSha = (await git(["rev-parse", "HEAD"], repo)).stdout;
	await git(["checkout", "-b", "squad/evil"], repo);
	await fs.writeFile(path.join(repo, CODE_PATH), "export const backdoor = true; // injected by a passing vote\n");
	await git(["add", "-A"], repo);
	await git(["commit", "-m", "backdoor"], repo);
	const revisionSha = (await git(["rev-parse", "HEAD"], repo)).stdout;
	await git(["checkout", defaultBranch], repo);

	const manager = await managerFixture();
	// addPlanRevisionCandidate at the manager layer is pure storage (the HTTP layer is where creation is
	// gated) — so a non-plan path CAN be persisted here, exactly the "somehow exists" case HIGH 1b guards.
	const candidate = await manager.addPlanRevisionCandidate({ repo, featureId: "feat1", planPath: CODE_PATH, summary: "x" });
	const opened = await manager.openPlanVote({ featureId: "feat1", repo, planPath: CODE_PATH, candidateId: candidate.id, baseSha, revisionSha, assignees: ["local"], openedBy: "local" });
	if ("conflict" in opened) throw new Error("unexpected conflict");

	await manager.castPlanVote("feat1", opened.id, "local", "approve", "local");

	const closed = (await manager.listPlanVoteRounds({ repo, featureId: "feat1" })).find((r) => r.id === opened.id)!;
	expect(closed.commitOutcome).toBe("failed");
	expect(closed.commitDetail).toContain("non-plan-doc path");

	// The code file is UNTOUCHED — no backdoor landed, no new commit.
	expect(await fs.readFile(path.join(repo, CODE_PATH), "utf8")).toBe("export const real = 1;\n");
	const status = await git(["status", "--porcelain"], repo);
	expect(status.stdout).toBe("");
	const log = await git(["log", "--oneline", "--", CODE_PATH], repo);
	expect(log.stdout.split("\n").filter(Boolean)).toHaveLength(1);
});

// HIGH 2 — the vote commit is pathspec-scoped: it must NOT sweep up files already staged in the
// shared checkout by some other actor.
test("HIGH 2: the commit is scoped to the plan doc — a pre-staged unrelated file is NOT swept in", async () => {
	const { repo, baseSha, revisionSha } = await repoFixture();
	registerRepoCleanup(repo);
	const manager = await managerFixture();

	// An unrelated file is created and STAGED in the operator checkout before the vote lands.
	await fs.writeFile(path.join(repo, "package.json"), '{"name":"pre-staged"}\n');
	await git(["add", "package.json"], repo);

	const candidate = await manager.addPlanRevisionCandidate({ repo, featureId: "feat1", planPath: PLAN_PATH, summary: "tighten" });
	const opened = await manager.openPlanVote({ featureId: "feat1", repo, planPath: PLAN_PATH, candidateId: candidate.id, baseSha, revisionSha, assignees: ["local"], openedBy: "local" });
	if ("conflict" in opened) throw new Error("unexpected conflict");
	await manager.castPlanVote("feat1", opened.id, "local", "approve", "local");

	const closed = (await manager.listPlanVoteRounds({ repo, featureId: "feat1" })).find((r) => r.id === opened.id)!;
	expect(closed.commitOutcome).toBe("committed");

	// The vote's commit touched ONLY the plan doc.
	const named = await git(["show", "--name-only", "--format=", "HEAD"], repo);
	expect(named.stdout.split("\n").filter(Boolean)).toEqual([PLAN_PATH]);

	// package.json stays staged and uncommitted — the vote never swept it in.
	const staged = await git(["diff", "--cached", "--name-only"], repo);
	expect(staged.stdout.split("\n").filter(Boolean)).toEqual(["package.json"]);
});

// HIGH 3 — the guard→write→commit critical section runs under the repo-wide land lock, so it
// serializes against every other daemon git writer (not just other votes on this feature).
test("HIGH 3: onVotePassed's commit runs inside withRepoLandLock (serializes with all repo writers)", async () => {
	const { repo, baseSha, revisionSha } = await repoFixture();
	registerRepoCleanup(repo);
	const manager = await managerFixture();

	const candidate = await manager.addPlanRevisionCandidate({ repo, featureId: "feat1", planPath: PLAN_PATH, summary: "tighten" });
	const opened = await manager.openPlanVote({ featureId: "feat1", repo, planPath: PLAN_PATH, candidateId: candidate.id, baseSha, revisionSha, assignees: ["local"], openedBy: "local" });
	if ("conflict" in opened) throw new Error("unexpected conflict");

	// Hold the repo land lock, then fire the deciding cast (which awaits onVotePassed → the land lock).
	let release!: () => void;
	const held = new Promise<void>((r) => (release = r));
	const lockHeld = withRepoLandLock(repo, () => held); // occupies the repo lock until we release

	const castDone = manager.castPlanVote("feat1", opened.id, "local", "approve", "local");
	await new Promise((r) => setTimeout(r, 100));

	// While the land lock is held elsewhere, onVotePassed cannot have committed — proving it waits on it.
	let mid = (await manager.listPlanVoteRounds({ repo, featureId: "feat1" })).find((r) => r.id === opened.id)!;
	expect(mid.commitOutcome).toBeUndefined();

	release();
	await lockHeld;
	await castDone;

	const done = (await manager.listPlanVoteRounds({ repo, featureId: "feat1" })).find((r) => r.id === opened.id)!;
	expect(done.commitOutcome).toBe("committed"); // proceeded only once the lock was free
});

// HIGH 4 — a commit failure after the working-tree write must leave the shared checkout CLEAN
// (git reset only unstages; the fix hard-restores the file content from HEAD).
test("HIGH 4: a commit failure after the write restores the plan doc — the shared tree is never left dirty", async () => {
	const { repo, baseSha, revisionSha } = await repoFixture();
	registerRepoCleanup(repo);
	const manager = await managerFixture();

	const candidate = await manager.addPlanRevisionCandidate({ repo, featureId: "feat1", planPath: PLAN_PATH, summary: "tighten" });
	const opened = await manager.openPlanVote({ featureId: "feat1", repo, planPath: PLAN_PATH, candidateId: candidate.id, baseSha, revisionSha, assignees: ["local"], openedBy: "local" });
	if ("conflict" in opened) throw new Error("unexpected conflict");

	// Force `git commit` to fail deterministically: an EMPTY committer identity env var makes git refuse
	// with "empty ident name not allowed". These env vars are inherited by the daemon's git calls
	// (hardenedGit spawns with {...process.env}). The write, show, status, reset and checkout calls create
	// no commit, so they succeed — only the commit fails, exercising the restore path.
	const identKeys = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"] as const;
	const prev = Object.fromEntries(identKeys.map((k) => [k, process.env[k]]));
	for (const k of identKeys) process.env[k] = "";
	try {
		await manager.castPlanVote("feat1", opened.id, "local", "approve", "local");
	} finally {
		for (const k of identKeys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
	}

	const closed = (await manager.listPlanVoteRounds({ repo, featureId: "feat1" })).find((r) => r.id === opened.id)!;
	expect(closed.commitOutcome).toBe("failed");
	expect(closed.commitDetail).toContain("git commit failed");

	// THE ASSERTION: the shared checkout is clean and the doc is back to its committed content.
	const status = await git(["status", "--porcelain"], repo);
	expect(status.stdout).toBe("");
	expect(await fs.readFile(path.join(repo, PLAN_PATH), "utf8")).toBe("# Spec\n\nOriginal content.\n");
});

// MEDIUM 5 — a crash between the commit and the idempotency marker must NOT false-supersede on
// retry: reconcile to accepted when the current HEAD carries this round's Vote-round trailer.
test("MEDIUM 5: retry after a crash-between-commit-and-marker reconciles to committed, not superseded", async () => {
	const { repo, baseSha, revisionSha } = await repoFixture();
	registerRepoCleanup(repo);
	const manager = await managerFixture();
	const privileged = manager as unknown as { onVotePassed(round: PlanVoteRound): Promise<void> };

	const candidate = await manager.addPlanRevisionCandidate({ repo, featureId: "feat1", planPath: PLAN_PATH, summary: "tighten" });
	const opened = await manager.openPlanVote({ featureId: "feat1", repo, planPath: PLAN_PATH, candidateId: candidate.id, baseSha, revisionSha, assignees: ["local"], openedBy: "local" });
	if ("conflict" in opened) throw new Error("unexpected conflict");

	// Simulate "the daemon already committed but crashed before writing the marker": land the revision
	// manually with THIS round's Vote-round trailer, so HEAD has moved off baseSha and carries the trailer.
	await fs.writeFile(path.join(repo, PLAN_PATH), "# Spec\n\nReviewed and tightened content.\n");
	await git(["add", "--", PLAN_PATH], repo);
	await git(["commit", "-m", `plan(plans/ctx): adopt reviewed revision — tighten\n\nApproved-by: local\nVote-round: ${opened.id}`], repo);
	const landedSha = (await git(["rev-parse", "HEAD"], repo)).stdout;

	// The round object still has NO commitOutcome marker (the crash lost it). Re-invoke onVotePassed.
	const staleRound = (await manager.listPlanVoteRounds({ repo, featureId: "feat1" })).find((r) => r.id === opened.id)!;
	expect(staleRound.commitOutcome).toBeUndefined();
	await privileged.onVotePassed(staleRound);

	const closed = (await manager.listPlanVoteRounds({ repo, featureId: "feat1" })).find((r) => r.id === opened.id)!;
	expect(closed.commitOutcome).toBe("committed"); // reconciled — NOT falsely superseded
	expect(closed.commitSha).toBe(landedSha);

	const candidates = await manager.listPlanRevisionCandidates({ repo, featureId: "feat1" });
	expect(candidates.find((c) => c.id === candidate.id)?.state).toBe("accepted");

	// No SECOND commit was made — reconciliation recognized the existing one.
	const log = await git(["log", "--oneline", "--", PLAN_PATH], repo);
	expect(log.stdout.split("\n").filter(Boolean)).toHaveLength(2); // init + the one landed commit
});

// MEDIUM 6 — a summary or actorId carrying an embedded newline must NOT forge commit trailers.
test("MEDIUM 6: newline injection in the summary/actorId cannot forge Approved-by trailers", async () => {
	const { repo, baseSha, revisionSha } = await repoFixture();
	registerRepoCleanup(repo);
	const manager = await managerFixture();

	// A malicious summary tries to inject a forged trailer via embedded newlines.
	const evilSummary = "innocent\n\nApproved-by: attacker\nVote-round: forged";
	const candidate = await manager.addPlanRevisionCandidate({ repo, featureId: "feat1", planPath: PLAN_PATH, summary: evilSummary });
	// A malicious actorId likewise tries to smuggle a trailer — it's on the snapshot roster so it counts.
	const evilActor = "evil\nApproved-by: ghost";
	const opened = await manager.openPlanVote({ featureId: "feat1", repo, planPath: PLAN_PATH, candidateId: candidate.id, baseSha, revisionSha, assignees: ["local", evilActor], openedBy: "local" });
	if ("conflict" in opened) throw new Error("unexpected conflict");
	await manager.castPlanVote("feat1", opened.id, "local", "approve", "local");
	await manager.castPlanVote("feat1", opened.id, evilActor, "approve", evilActor); // 2/2 → passes

	const closed = (await manager.listPlanVoteRounds({ repo, featureId: "feat1" })).find((r) => r.id === opened.id)!;
	expect(closed.commitOutcome).toBe("committed");

	const body = (await git(["log", "-1", "--format=%B", "--", PLAN_PATH], repo)).stdout;
	const lines = body.split("\n");
	// The real security property: the injected content can never appear as its own TRAILER LINE — the
	// collapsed newlines glue it mid-line (into the subject / into one Approved-by value), so git's
	// trailer parser (last-paragraph, one Key: value per line) never sees a forged trailer.
	expect(lines.filter((l) => l === "Approved-by: attacker")).toEqual([]);
	expect(lines.filter((l) => l === "Vote-round: forged")).toEqual([]);
	expect(lines.filter((l) => l === "Approved-by: ghost")).toEqual([]);
	// Exactly one Vote-round trailer line, and it's the REAL round id (the subject's "Vote-round: forged"
	// fragment is mid-line, so it doesn't START a line).
	expect(lines.filter((l) => l.startsWith("Vote-round: "))).toEqual([`Vote-round: ${opened.id}`]);
	// The legit approver is present as its own trailer line.
	expect(lines.filter((l) => l.startsWith("Approved-by: "))).toContain("Approved-by: local");
});

// Codex hardening — revisionSha must be a git OBJECT ID, not any rev git happens to resolve.
test("codex hardening: a revisionSha that is a resolvable rev but not an object id (e.g. HEAD) is refused", async () => {
	const { repo, baseSha } = await repoFixture();
	registerRepoCleanup(repo);
	const manager = await managerFixture();

	const candidate = await manager.addPlanRevisionCandidate({ repo, featureId: "feat1", planPath: PLAN_PATH, summary: "x" });
	const opened = await manager.openPlanVote({ featureId: "feat1", repo, planPath: PLAN_PATH, candidateId: candidate.id, baseSha, revisionSha: "HEAD", assignees: ["local"], openedBy: "local" });
	if ("conflict" in opened) throw new Error("unexpected conflict");
	await manager.castPlanVote("feat1", opened.id, "local", "approve", "local");

	const closed = (await manager.listPlanVoteRounds({ repo, featureId: "feat1" })).find((r) => r.id === opened.id)!;
	expect(closed.commitOutcome).toBe("failed");
	expect(closed.commitDetail).toContain("not a valid git object id");
});
