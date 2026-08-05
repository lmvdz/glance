/**
 * Gauntlet-panel ledger projection (T5 gauntlet round 1, glance#333, finding A1 — CRITICAL, both
 * lineages independently converged) — `src/rail/panel-ledger.ts`.
 *
 * THE BUG this closes: the panel used to append directly to the git-TRACKED
 * `plans/.reviews/reviewer-ledger.jsonl` DURING the pre-land advisory panel — i.e. BEFORE
 * `landAgentLocked`'s dirty-main check — so a clean branch that PASSED the validator could get
 * BLOCKED by the panel's own successful write. These tests prove the QUEUE + PROJECTION split: a
 * finding queued under stateDir never touches a repo's working tree, and `projectPendingPanelFindings`
 * — guarded by the SAME `withRepoLandLock` a live land uses — is the sole path from that queue into
 * the tracked ledger, run OUT of the land path.
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
