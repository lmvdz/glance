/**
 * DoneProof ledger — the single artifact that later authorizes a Done write (concern 04) or a
 * PR-mode reachability claim (concern 06). This concern only builds the ledger + `isAncestor` +
 * folds `land()`'s manager-layer write in; it does not gate anything yet.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getDoneProofByBranch, getDoneProofByIssue, hasProof, isAncestor, readDoneProofLedger, recordDoneProof } from "../src/done-proof.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { LandResult } from "../src/land.ts";
import { SubagentTracker } from "../src/subagents.ts";
import type { AgentDTO, IssueRef, PersistedAgent } from "../src/types.ts";

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function tmpDir(prefix: string): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(d);
	return d;
}

// ── ledger round-trip ────────────────────────────────────────────────────────

test("recordDoneProof round-trips through getDoneProofByBranch/getDoneProofByIssue/hasProof", async () => {
	const stateDir = await tmpDir("done-proof-rt-");
	recordDoneProof(stateDir, {
		branch: "squad/a1",
		repo: "github.com/acme/app",
		issueId: "iss-1",
		issueIdentifier: "PROJ-1",
		mode: "local",
		commit: "deadbeef",
		baseRef: "HEAD",
		verified: "green",
		detail: "merged squad/a1",
		provenAt: 1000,
	});

	expect(getDoneProofByBranch(stateDir, "squad/a1")?.commit).toBe("deadbeef");
	expect(getDoneProofByIssue(stateDir, "PROJ-1")?.branch).toBe("squad/a1");
	expect(getDoneProofByIssue(stateDir, "proj-1")?.branch).toBe("squad/a1"); // case-insensitive lookup
	expect(hasProof(stateDir, "PROJ-1")).toBe(true);
	expect(hasProof(stateDir, "PROJ-999")).toBe(false);
});

test("a second recordDoneProof for the same branch overwrites the entry", async () => {
	const stateDir = await tmpDir("done-proof-overwrite-");
	recordDoneProof(stateDir, { branch: "squad/a1", repo: "r", mode: "local", commit: "c1", baseRef: "HEAD", verified: "green", detail: "first", provenAt: 1 });
	recordDoneProof(stateDir, { branch: "squad/a1", repo: "r", mode: "local", commit: "c2", baseRef: "HEAD", verified: "green", detail: "second", provenAt: 2 });

	const proof = getDoneProofByBranch(stateDir, "squad/a1");
	expect(proof?.commit).toBe("c2");
	expect(proof?.detail).toBe("second");
});

test("a second issue-identifier record for a DIFFERENT branch updates byIssue to the newer branch (most-recent-wins)", async () => {
	const stateDir = await tmpDir("done-proof-redispatch-");
	recordDoneProof(stateDir, { branch: "squad/a1", repo: "r", issueIdentifier: "PROJ-7", mode: "local", commit: "c1", baseRef: "HEAD", verified: "green", detail: "first land", provenAt: 1 });
	recordDoneProof(stateDir, { branch: "squad/a2", repo: "r", issueIdentifier: "PROJ-7", mode: "local", commit: "c2", baseRef: "HEAD", verified: "green", detail: "re-dispatched land", provenAt: 2 });

	expect(getDoneProofByIssue(stateDir, "PROJ-7")?.branch).toBe("squad/a2");
	// the older branch's own entry is untouched — only the issue index moved
	expect(getDoneProofByBranch(stateDir, "squad/a1")?.detail).toBe("first land");
});

// ── corrupt / missing file ───────────────────────────────────────────────────

test("readDoneProofLedger returns the empty shape on a missing file, never throws", async () => {
	const stateDir = await tmpDir("done-proof-missing-");
	expect(readDoneProofLedger(stateDir)).toEqual({ byBranch: {}, byIssue: {} });
});

test("readDoneProofLedger returns the empty shape on a corrupt file, never throws", async () => {
	const stateDir = await tmpDir("done-proof-corrupt-");
	await fs.writeFile(path.join(stateDir, "done-proofs.json"), "{ not json");
	expect(readDoneProofLedger(stateDir)).toEqual({ byBranch: {}, byIssue: {} });
});

// ── isAncestor ───────────────────────────────────────────────────────────────

async function git(cwd: string, ...a: string[]): Promise<void> {
	await Bun.spawn(["git", "-C", cwd, ...a], { stdout: "ignore", stderr: "ignore" }).exited;
}

async function gitOut(cwd: string, ...a: string[]): Promise<string> {
	const p = Bun.spawn(["git", "-C", cwd, ...a], { stdout: "pipe", stderr: "pipe" });
	const [s] = await Promise.all([new Response(p.stdout).text(), p.exited]);
	return s.trim();
}

async function gitRepo(prefix: string): Promise<string> {
	const repo = await tmpDir(prefix);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	return repo;
}

async function commit(repo: string, file: string, content: string, message: string): Promise<string> {
	await fs.writeFile(path.join(repo, file), content);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", message);
	return gitOut(repo, "rev-parse", "HEAD");
}

test("isAncestor: fast-forward relationship is true one way, false the other", async () => {
	const repo = await gitRepo("done-proof-ff-");
	const base = await commit(repo, "a.txt", "a\n", "base");
	const tip = await commit(repo, "b.txt", "b\n", "tip");

	expect(await isAncestor(base, tip, repo)).toBe(true);
	expect(await isAncestor(tip, base, repo)).toBe(false);
});

test("isAncestor: two unrelated diverged commits are false in both directions", async () => {
	const repo = await gitRepo("done-proof-diverge-");
	await commit(repo, "root.txt", "root\n", "root");
	await git(repo, "branch", "side");

	const mainTip = await commit(repo, "main-only.txt", "m\n", "main advances");
	await git(repo, "checkout", "-q", "side");
	const sideTip = await commit(repo, "side-only.txt", "s\n", "side advances");

	expect(await isAncestor(mainTip, sideTip, repo)).toBe(false);
	expect(await isAncestor(sideTip, mainTip, repo)).toBe(false);
});

// ── land() delegation: manager-layer write on a real merge ─────────────────

/** SquadManager with the land seam faked to a configurable result, so land()'s DoneProof write is unit-testable. */
class TestManager extends SquadManager {
	landResult: LandResult = { ok: true, committed: true, merged: true, message: "landed" };
	protected landBranch(): Promise<LandResult> {
		return Promise.resolve(this.landResult);
	}
}

function seed(mgr: TestManager, id: string, issue?: IssueRef): void {
	const dto: AgentDTO = {
		id,
		name: id,
		status: "idle",
		kind: "omp-operator",
		repo: "/r",
		worktree: "/r",
		branch: `squad/${id}`,
		approvalMode: "yolo",
		pending: [],
		lastActivity: 0,
		messageCount: 0,
		issue,
	};
	const options: PersistedAgent = { id, name: id, repo: "/r", worktree: "/r", approvalMode: "yolo", issue };
	mgr.agents.set(id, { dto, agent: undefined as never, options, transcript: [], assistantBuf: "", streaming: false, subs: new SubagentTracker() });
}

const trackedIssue: IssueRef = { id: "iss-1", identifier: "PROJ-1", name: "do the thing", projectId: "proj-9" };

test("land() records a DoneProof for a real merge, mode local, verified green", async () => {
	const stateDir = await tmpDir("done-proof-land-");
	const mgr = new TestManager({ stateDir });
	seed(mgr, "a1", trackedIssue);

	const r = await mgr.land("a1");
	expect(r.ok).toBe(true);

	const proof = getDoneProofByBranch(stateDir, "squad/a1");
	expect(proof).toBeDefined();
	expect(proof?.mode).toBe("local");
	expect(proof?.verified).toBe("green");
	expect(getDoneProofByIssue(stateDir, "PROJ-1")?.branch).toBe("squad/a1");
});

test("land() records verified red-baseline when the land detail says so", async () => {
	const stateDir = await tmpDir("done-proof-land-redbase-");
	const mgr = new TestManager({ stateDir });
	mgr.landResult = { ok: true, committed: true, merged: true, message: "landed", detail: "landed onto a red baseline — main was not green at head0 (bun test)" };
	seed(mgr, "a1", trackedIssue);

	await mgr.land("a1");
	expect(getDoneProofByBranch(stateDir, "squad/a1")?.verified).toBe("red-baseline");
});

test("land() does NOT record a DoneProof when the land made no merge", async () => {
	const stateDir = await tmpDir("done-proof-land-nomerge-");
	const mgr = new TestManager({ stateDir });
	mgr.landResult = { ok: true, committed: false, merged: false, message: "nothing to land" };
	seed(mgr, "a1", trackedIssue);

	await mgr.land("a1");
	expect(getDoneProofByBranch(stateDir, "squad/a1")).toBeUndefined();
});
