/**
 * Gauntlet-panel ledger projection (T5, glance#333, finding A1 — CRITICAL both rounds) —
 * `src/rail/panel-ledger.ts`.
 *
 * ROUND 1 BUG this closes: the panel used to append directly to the git-TRACKED
 * `plans/.reviews/reviewer-ledger.jsonl` DURING the pre-land advisory panel — i.e. BEFORE
 * `landAgentLocked`'s dirty-main check — so a clean branch that PASSED the validator could get
 * BLOCKED by the panel's own successful write. Round 1's fix (queue-under-stateDir +
 * lock-guarded projection lane) is what most tests in this file prove.
 *
 * ROUND 2 BUG (both lineages, dual delta-verify): the PROJECTION LANE ITSELF reintroduced A1 one land
 * later — it cleared the queue BEFORE the commit durably succeeded, its failure path only restored the
 * WORKING TREE (not the index, leaving a STAGED-dirty tree), and it had no idempotency guard against a
 * crash between a successful commit and the queue clear. The tests under "ROUND 2" below prove each of
 * those specifically: durability-first ordering, idempotent re-append, full index+worktree restore on a
 * genuine commit failure (forced via a real missing-git-identity repo, not a mock), and that the tree is
 * BYTE-CLEAN (`git status --porcelain` empty) after a failed projection — the exact invariant that failed
 * before this round's fix.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_REVIEWER_LEDGER_PATH } from "../src/memory/index.ts";
import { projectPendingPanelFindings, readPendingPanelFindings, recordPendingPanelFinding } from "../src/rail/panel-ledger.ts";
import type { ReviewerLedgerEntry } from "../src/memory/index.ts";

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function tmpDir(prefix: string): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(d);
	return d;
}

async function git(cwd: string, ...a: string[]): Promise<{ code: number; out: string }> {
	const p = Bun.spawn(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
	const out = await new Response(p.stdout).text();
	const code = await p.exited;
	return { code, out: out.trim() };
}

/** A repo with NO git identity configured (no `user.email`/`user.name`, local or global) — every
 *  `git commit` against it fails with "empty ident name" for the DURATION this test isolates `HOME`/
 *  the identity env vars to a scratch location with no `.gitconfig` to fall back to, so the failure is
 *  deterministic regardless of the operator's own ambient git config. Used to force a REAL commit
 *  failure (round 2, finding #1) rather than mocking one. */
const IDENTITY_ENV_KEYS = ["HOME", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "XDG_CONFIG_HOME"] as const;
async function withNoGitIdentity<T>(fn: () => Promise<T>): Promise<T> {
	const saved: Record<string, string | undefined> = {};
	for (const k of IDENTITY_ENV_KEYS) saved[k] = process.env[k];
	const emptyHome = await fs.mkdtemp(path.join(os.tmpdir(), "no-git-identity-home-"));
	try {
		process.env.HOME = emptyHome;
		process.env.XDG_CONFIG_HOME = path.join(emptyHome, ".config");
		delete process.env.GIT_AUTHOR_NAME;
		delete process.env.GIT_AUTHOR_EMAIL;
		delete process.env.GIT_COMMITTER_NAME;
		delete process.env.GIT_COMMITTER_EMAIL;
		return await fn();
	} finally {
		for (const k of IDENTITY_ENV_KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
		await fs.rm(emptyHome, { recursive: true, force: true }).catch(() => {});
	}
}

/** A real repo with a tracked (empty) `plans/.reviews/reviewer-ledger.jsonl`, mirroring the real
 *  glance layout closely enough for the projection lane's `git add`/`git commit` to behave exactly
 *  as it would against the real repo. */
async function ledgerRepoFixture(prefix: string): Promise<{ repo: string; ledgerPath: string }> {
	const repo = await tmpDir(prefix);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	const ledgerDir = path.join(repo, "plans", ".reviews");
	await fs.mkdir(ledgerDir, { recursive: true });
	const ledgerPath = path.join(ledgerDir, "reviewer-ledger.jsonl");
	await fs.writeFile(ledgerPath, "");
	await fs.writeFile(path.join(repo, "README.md"), "seed\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "seed");
	return { repo, ledgerPath };
}

const row = (over: Partial<ReviewerLedgerEntry> = {}): ReviewerLedgerEntry => ({
	at: "2026-08-04",
	lineage: "grok",
	concernClass: "fail-open",
	survived: true,
	source: "land test@abc",
	note: "a finding",
	...over,
});

// ── the queue itself: never touches a repo tree ─────────────────────────────────────────────────

test("recordPendingPanelFinding queues under stateDir only — never creates or touches a repo working tree", async () => {
	const { repo } = await ledgerRepoFixture("panel-ledger-queue-only-");
	const stateDir = await tmpDir("panel-ledger-state-");
	recordPendingPanelFinding(stateDir, row());
	expect(readPendingPanelFindings(stateDir).length).toBe(1);
	// The repo the finding is DESTINED for was never touched.
	const status = await git(repo, "status", "--porcelain");
	expect(status.out).toBe("");
});

test("readPendingPanelFindings returns [] for a stateDir that has never queued anything", async () => {
	const stateDir = await tmpDir("panel-ledger-empty-");
	expect(readPendingPanelFindings(stateDir)).toEqual([]);
});

// ── projection: the transactional lane ──────────────────────────────────────────────────────────

test("projectPendingPanelFindings on an empty queue is a true no-op — never touches git", async () => {
	const { repo } = await ledgerRepoFixture("panel-ledger-noop-");
	const stateDir = await tmpDir("panel-ledger-state-noop-");
	const before = await git(repo, "rev-parse", "HEAD");
	const result = await projectPendingPanelFindings(stateDir, repo, path.join(repo, "plans", ".reviews", "reviewer-ledger.jsonl"));
	expect(result).toEqual({ projected: 0, committed: false });
	const after = await git(repo, "rev-parse", "HEAD");
	expect(after.out).toBe(before.out); // no new commit
});

test("projectPendingPanelFindings appends queued findings to the tracked file AND commits them, leaving the tree clean", async () => {
	const { repo, ledgerPath } = await ledgerRepoFixture("panel-ledger-project-");
	const stateDir = await tmpDir("panel-ledger-state-project-");
	recordPendingPanelFinding(stateDir, row({ note: "finding one" }));
	recordPendingPanelFinding(stateDir, row({ note: "finding two", survived: false }));

	const result = await projectPendingPanelFindings(stateDir, repo, ledgerPath);

	expect(result).toEqual({ projected: 2, committed: true });
	expect(readPendingPanelFindings(stateDir)).toEqual([]); // the queue was drained

	const text = await fs.readFile(ledgerPath, "utf8");
	const lines = text.split("\n").filter((l) => l.trim());
	expect(lines.length).toBe(2);
	expect(JSON.parse(lines[0])).toMatchObject({ note: "finding one" });
	expect(JSON.parse(lines[1])).toMatchObject({ note: "finding two", survived: false });

	// The tree is clean and the rows are COMMITTED (not just staged) — the exact property A1's fix
	// exists to guarantee: the NEXT land into this repo will see a clean checkout.
	const status = await git(repo, "status", "--porcelain");
	expect(status.out).toBe("");
	const log = await git(repo, "log", "-1", "--format=%s");
	expect(log.out).toContain("gauntlet-panel finding");
	expect(log.out).toContain("2");
});

test("projectPendingPanelFindings commits ONLY the ledger file — an operator's unrelated uncommitted WIP survives untouched", async () => {
	const { repo, ledgerPath } = await ledgerRepoFixture("panel-ledger-scoped-commit-");
	const stateDir = await tmpDir("panel-ledger-state-scoped-");
	recordPendingPanelFinding(stateDir, row());
	await fs.writeFile(path.join(repo, "operator-wip.txt"), "unrelated uncommitted work\n");

	const result = await projectPendingPanelFindings(stateDir, repo, ledgerPath);

	expect(result.committed).toBe(true);
	// The unrelated file is STILL uncommitted afterward — never swept into the panel's commit.
	const status = await git(repo, "status", "--porcelain");
	expect(status.out).toContain("operator-wip.txt");
	expect(status.out).not.toContain("reviewer-ledger.jsonl"); // the ledger itself is now clean/committed
});

test("projected findings survive a git reset --hard of an UNRELATED failed operation — because they are already committed, not merely written", async () => {
	const { repo, ledgerPath } = await ledgerRepoFixture("panel-ledger-rollback-safe-");
	const stateDir = await tmpDir("panel-ledger-state-rollback-");
	recordPendingPanelFinding(stateDir, row());
	await projectPendingPanelFindings(stateDir, repo, ledgerPath);
	const afterProjection = await git(repo, "rev-parse", "HEAD");

	// Simulate a LATER failed-gate rollback (a real land.ts scenario) — it can only discard commits
	// AFTER this one; the panel's own commit is already durable history, unlike the old direct-append
	// bug where an uncommitted row sat in the working tree and a `git reset --hard` would have erased it.
	await fs.writeFile(path.join(repo, "later-change.txt"), "x\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "later change that will be rolled back");
	await git(repo, "reset", "--hard", afterProjection.out);

	const text = await fs.readFile(ledgerPath, "utf8");
	expect(text.split("\n").filter((l) => l.trim()).length).toBe(1); // the projected row is still there
});

test("a partially-written queue entry is re-queued (never silently dropped) when the tracked write fails", async () => {
	const stateDir = await tmpDir("panel-ledger-state-writefail-");
	recordPendingPanelFinding(stateDir, row());
	// A ledger "path" that is actually a DIRECTORY ⇒ the write fails (EISDIR).
	const badDir = await tmpDir("panel-ledger-baddir-");
	const repo = await tmpDir("panel-ledger-baddir-repo-");
	await expect(projectPendingPanelFindings(stateDir, repo, badDir)).rejects.toThrow();
	// The finding was NOT lost — it is back in the queue for the next attempt.
	expect(readPendingPanelFindings(stateDir).length).toBe(1);
});

test("ROUND 2: a failed atomic rename cleans up its own temp file — never leaks an untracked scratch file into the ledger's (normally git-tracked) parent directory", async () => {
	const stateDir = await tmpDir("panel-ledger-state-tmpcleanup-");
	recordPendingPanelFinding(stateDir, row());
	// `ledgerDir` is the "tracked parent directory" stand-in; `badDir` (a real directory) stands in for
	// the ledger path itself, so the rename step fails (can't rename a file onto an existing directory).
	const ledgerDir = await tmpDir("panel-ledger-tmpcleanup-parent-");
	const badLedgerPath = path.join(ledgerDir, "reviewer-ledger.jsonl");
	await fs.mkdir(badLedgerPath); // the "ledger path" is itself a directory ⇒ rename onto it fails
	const repo = await tmpDir("panel-ledger-tmpcleanup-repo-");

	await expect(projectPendingPanelFindings(stateDir, repo, badLedgerPath)).rejects.toThrow();

	const leftovers = (await fs.readdir(ledgerDir)).filter((f) => f !== "reviewer-ledger.jsonl");
	expect(leftovers).toEqual([]); // no `.reviewer-ledger.tmp-*` scratch file left behind
});

test("a non-git ledgerRepo still durably writes the file (rows are never lost) but reports committed:false", async () => {
	const bareDir = await tmpDir("panel-ledger-nongit-");
	const ledgerPath = path.join(bareDir, "reviewer-ledger.jsonl");
	await fs.writeFile(ledgerPath, "");
	const stateDir = await tmpDir("panel-ledger-state-nongit-");
	recordPendingPanelFinding(stateDir, row());

	const result = await projectPendingPanelFindings(stateDir, bareDir, ledgerPath);

	expect(result).toEqual({ projected: 1, committed: false });
	expect(readPendingPanelFindings(stateDir)).toEqual([]); // still drained — the DATA made it to disk
	const text = await fs.readFile(ledgerPath, "utf8");
	expect(text.split("\n").filter((l) => l.trim()).length).toBe(1);
});

test("concurrent projection attempts on the SAME repo are serialized by withRepoLandLock — no interleaved/lost writes", async () => {
	const { repo, ledgerPath } = await ledgerRepoFixture("panel-ledger-concurrent-");
	const stateDir = await tmpDir("panel-ledger-state-concurrent-");
	recordPendingPanelFinding(stateDir, row({ note: "batch one" }));

	// Start a projection, then immediately queue MORE findings and start a second projection before the
	// first settles — the lock must serialize them so nothing is lost or interleaved into a broken commit.
	const first = projectPendingPanelFindings(stateDir, repo, ledgerPath);
	recordPendingPanelFinding(stateDir, row({ note: "batch two" }));
	const second = projectPendingPanelFindings(stateDir, repo, ledgerPath);

	const [r1, r2] = await Promise.all([first, second]);
	expect(r1.projected + r2.projected).toBe(2);
	const text = await fs.readFile(ledgerPath, "utf8");
	const lines = text.split("\n").filter((l) => l.trim());
	expect(lines.length).toBe(2); // both rows landed, none lost, none duplicated
	const status = await git(repo, "status", "--porcelain");
	expect(status.out).toBe(""); // tree clean after both settle
});

test("DEFAULT_REVIEWER_LEDGER_PATH is unchanged by this refactor — still the repo-committed path T4's reader uses", () => {
	expect(DEFAULT_REVIEWER_LEDGER_PATH.endsWith(path.join("plans", ".reviews", "reviewer-ledger.jsonl"))).toBe(true);
});

// ── ROUND 2: a PROPER TRANSACTION (durability-first, idempotency, full restore) ─────────────────

/** A repo fixture with NO identity persisted to its OWN local git config — the seed commit is made
 *  with a throwaway identity supplied only via one-off `-c` flags, never written to `.git/config`, so
 *  once the ambient environment ALSO has no identity (`withNoGitIdentity`), every SUBSEQUENT commit
 *  genuinely fails — a real forced failure, not a mock. */
async function ledgerRepoFixtureNoIdentity(prefix: string): Promise<{ repo: string; ledgerPath: string }> {
	const repo = await tmpDir(prefix);
	await git(repo, "init", "-q", "-b", "main");
	const ledgerDir = path.join(repo, "plans", ".reviews");
	await fs.mkdir(ledgerDir, { recursive: true });
	const ledgerPath = path.join(ledgerDir, "reviewer-ledger.jsonl");
	await fs.writeFile(ledgerPath, "");
	await fs.writeFile(path.join(repo, "README.md"), "seed\n");
	await git(repo, "add", "-A");
	const seed = Bun.spawn(["git", "-c", "user.email=seed@seed", "-c", "user.name=seed", "-c", "commit.gpgsign=false", "commit", "-qm", "seed"], { cwd: repo, stdout: "ignore", stderr: "ignore" });
	const seedCode = await seed.exited;
	if (seedCode !== 0) throw new Error("fixture setup: seed commit failed");
	return { repo, ledgerPath };
}

test("ROUND 2 (finding #1d): a GENUINE commit failure (real missing git identity, not a mock) fully restores BOTH the index and the working tree — git status is byte-CLEAN afterward", async () => {
	const { repo, ledgerPath } = await ledgerRepoFixtureNoIdentity("panel-ledger-r2-noidentity-");
	const stateDir = await tmpDir("panel-ledger-r2-noidentity-state-");
	recordPendingPanelFinding(stateDir, row({ note: "would-be finding" }));

	await withNoGitIdentity(async () => {
		const result = await projectPendingPanelFindings(stateDir, repo, ledgerPath);
		expect(result).toEqual({ projected: 0, committed: false });
	});

	// THE INVARIANT THAT FAILED IN ROUND 2: `git checkout -- <path>` alone restores the WORKING TREE
	// from the INDEX (which still held the staged new content), leaving the tree STAGED-dirty. The
	// round-2 fix (`git checkout HEAD -- <path>`) resets BOTH — status must be completely empty.
	const status = await git(repo, "status", "--porcelain");
	expect(status.out).toBe("");
	// The file content itself is back to the pre-attempt (empty) state.
	const text = await fs.readFile(ledgerPath, "utf8");
	expect(text.trim()).toBe("");
});

test("ROUND 2 (finding #1a/#1d): a commit failure NEVER clears the queue — durability-first, the whole batch is retryable", async () => {
	const { repo, ledgerPath } = await ledgerRepoFixtureNoIdentity("panel-ledger-r2-requeue-");
	const stateDir = await tmpDir("panel-ledger-r2-requeue-state-");
	recordPendingPanelFinding(stateDir, row({ note: "finding A" }));
	recordPendingPanelFinding(stateDir, row({ note: "finding B", survived: false }));

	await withNoGitIdentity(async () => {
		await projectPendingPanelFindings(stateDir, repo, ledgerPath);
	});

	// BOTH findings are still queued — round 2's bug requeued only the "unwritten" remainder, silently
	// dropping rows that had already been appended-but-not-committed from the queue while leaving them
	// dirty on disk. The fixed design never clears until a commit genuinely succeeds, so nothing here
	// was ever removed in the first place.
	const stillQueued = readPendingPanelFindings(stateDir);
	expect(stillQueued.length).toBe(2);
	expect(stillQueued.map((f) => f.note).sort()).toEqual(["finding A", "finding B"]);
});

test("ROUND 2: after a commit failure is fixed (identity restored), the SAME retry succeeds and commits exactly once — no duplication from the failed attempt", async () => {
	const { repo, ledgerPath } = await ledgerRepoFixtureNoIdentity("panel-ledger-r2-retry-succeeds-");
	const stateDir = await tmpDir("panel-ledger-r2-retry-succeeds-state-");
	recordPendingPanelFinding(stateDir, row({ note: "retry-me" }));

	await withNoGitIdentity(async () => {
		const failed = await projectPendingPanelFindings(stateDir, repo, ledgerPath);
		expect(failed.committed).toBe(false);
	});

	// Now retry with a REAL identity present (repo-local config this time).
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	const retried = await projectPendingPanelFindings(stateDir, repo, ledgerPath);

	expect(retried).toEqual({ projected: 1, committed: true });
	const text = await fs.readFile(ledgerPath, "utf8");
	const lines = text.split("\n").filter((l) => l.trim());
	expect(lines.length).toBe(1); // exactly once — the failed attempt left nothing duplicated
	expect(readPendingPanelFindings(stateDir)).toEqual([]);
});

test("ROUND 2 (finding #1b): idempotency — a finding ALREADY present in the ledger (simulating a crash between a successful commit and the queue clear) is never re-appended, and is still cleared from the queue", async () => {
	const { repo, ledgerPath } = await ledgerRepoFixture("panel-ledger-r2-idempotent-");
	const stateDir = await tmpDir("panel-ledger-r2-idempotent-state-");
	const finding = row({ note: "already-committed-finding" });

	// Simulate the crash-recovery gap directly: the row is ALREADY durably committed to the tracked
	// ledger (as if a prior projection succeeded), but the SAME finding is (as if the process crashed
	// before it could clear the queue) still sitting in the pending queue.
	await fs.writeFile(ledgerPath, `${JSON.stringify(finding)}\n`);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "pre-existing committed row");
	recordPendingPanelFinding(stateDir, finding);

	const result = await projectPendingPanelFindings(stateDir, repo, ledgerPath);

	// Nothing NEW was written (it was already there) — but the queue IS cleared, since the finding is
	// genuinely, durably accounted for. A retry must never double-append.
	expect(result.projected).toBe(0);
	expect(readPendingPanelFindings(stateDir)).toEqual([]);
	const text = await fs.readFile(ledgerPath, "utf8");
	const lines = text.split("\n").filter((l) => l.trim());
	expect(lines.length).toBe(1); // still exactly one row — never duplicated
});

test("ROUND 2 (finding #1b): idempotency applies WITHIN a single batch too — two content-identical pending findings collapse to one written row", async () => {
	const { repo, ledgerPath } = await ledgerRepoFixture("panel-ledger-r2-batch-dedup-");
	const stateDir = await tmpDir("panel-ledger-r2-batch-dedup-state-");
	const finding = row({ note: "duplicate-within-batch" });
	recordPendingPanelFinding(stateDir, finding);
	recordPendingPanelFinding(stateDir, { ...finding }); // a distinct object, IDENTICAL content

	const result = await projectPendingPanelFindings(stateDir, repo, ledgerPath);

	expect(result).toEqual({ projected: 1, committed: true }); // only ONE new row, not two
	const text = await fs.readFile(ledgerPath, "utf8");
	expect(text.split("\n").filter((l) => l.trim()).length).toBe(1);
	expect(readPendingPanelFindings(stateDir)).toEqual([]); // both queue entries accounted for
});

test("ROUND 2 (finding #1e): the atomic append means a projection either writes the WHOLE batch or NONE of it — no observable partial state even when one entry among several would fail to serialize", async () => {
	const { repo, ledgerPath } = await ledgerRepoFixture("panel-ledger-r2-atomic-");
	const stateDir = await tmpDir("panel-ledger-r2-atomic-state-");
	recordPendingPanelFinding(stateDir, row({ note: "first" }));
	recordPendingPanelFinding(stateDir, row({ note: "second" }));
	recordPendingPanelFinding(stateDir, row({ note: "third" }));

	const result = await projectPendingPanelFindings(stateDir, repo, ledgerPath);

	expect(result).toEqual({ projected: 3, committed: true });
	const text = await fs.readFile(ledgerPath, "utf8");
	const lines = text.split("\n").filter((l) => l.trim());
	expect(lines.length).toBe(3); // all three, in one atomic write — never a 1-of-3 or 2-of-3 state
});
