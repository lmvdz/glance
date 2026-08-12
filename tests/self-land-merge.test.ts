/**
 * Self-land REAL merge path (glance#391 round 4) — the mutation-proof standard both critics required:
 * drive `SquadManager.selfLand` through the ACTUAL `landAgentPr` with a fake gh, moving a remote
 * head/base/state BETWEEN the live read and the merge and proving the land refuses (or, for a merge
 * queue, is recorded QUEUED not aborted). Real git tmp repos + a real bare origin; only `gh` is
 * module-mocked (the exact convention land-pr.test.ts uses — proven to coexist in the full suite;
 * the round-2 leak was an explicit two-file `bun test A B` sharing a process, not the discovery run).
 */

import { afterEach, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// One shared, mutable PR fixture the mock reads. Reset per test.
interface PrState {
	number: number;
	branch: string;
	head: string; // current head SHA the mock reports
	base: string;
	state: "OPEN" | "MERGED" | "CLOSED";
	isDraft: boolean;
	body: string;
	mergeCommit?: string;
}
let PR: PrState;
/** When set, ADVANCE the head to this SHA the first time the live merge-guard `pr view` runs — i.e.
 *  simulate another actor pushing a descendant AFTER we measured but BEFORE `gh pr merge`. */
let advanceHeadAfterLiveView: string | undefined;
/** When set, ADVANCE the base to this ref the first time the live merge-guard `pr view` runs. */
let advanceBaseAfterLiveView: string | undefined;
/** When true, `gh pr merge` exits 0 but does NOT merge (enqueued into a merge queue). */
let enqueueInsteadOfMerge = false;
let mergeSimulator: ((cwd: string) => Promise<void>) | undefined;
const mergeCalls: string[][] = [];

function jsonFields(args: string[]): string[] {
	const i = args.indexOf("--json");
	return i >= 0 && args[i + 1] ? args[i + 1].split(",") : [];
}

async function mockGh(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
	if (args[0] === "pr" && args[1] === "view") {
		const fields = jsonFields(args);
		// The live merge-point guard reads exactly these four — advance head/base right AFTER it returns,
		// to model a push that lands between the live read and the merge.
		const isLiveGuard = fields.includes("baseRefName") && fields.includes("headRefOid") && fields.includes("isDraft") && fields.includes("state");
		const out: Record<string, unknown> = {};
		if (fields.includes("number")) out.number = PR.number;
		if (fields.includes("url")) out.url = `https://github.com/lmvdz/glance/pull/${PR.number}`;
		if (fields.includes("state")) out.state = PR.state;
		if (fields.includes("headRefName")) out.headRefName = PR.branch;
		if (fields.includes("headRefOid")) out.headRefOid = PR.head;
		if (fields.includes("baseRefName")) out.baseRefName = PR.base;
		if (fields.includes("isDraft")) out.isDraft = PR.isDraft;
		if (fields.includes("title")) out.title = `pr ${PR.number}`;
		if (fields.includes("body")) out.body = PR.body;
		if (fields.includes("mergeStateStatus")) out.mergeStateStatus = enqueueInsteadOfMerge ? "QUEUED" : "CLEAN";
		if (fields.includes("mergeCommit")) out.mergeCommit = PR.mergeCommit ? { oid: PR.mergeCommit } : null;
		const res = { code: 0, stdout: JSON.stringify(out), stderr: "" };
		if (isLiveGuard) {
			if (advanceHeadAfterLiveView) PR.head = advanceHeadAfterLiveView;
			if (advanceBaseAfterLiveView) PR.base = advanceBaseAfterLiveView;
		}
		return res;
	}
	if (args[0] === "pr" && args[1] === "list") {
		// ensurePr's `--state all` and prForBranch's `--state open` both read the branch's PR.
		return { code: 0, stdout: JSON.stringify([{ number: PR.number, url: `https://github.com/lmvdz/glance/pull/${PR.number}`, state: PR.state, headRefName: PR.branch, headRefOid: PR.head, baseRefName: PR.base, isDraft: PR.isDraft, body: PR.body }]), stderr: "" };
	}
	if (args[0] === "pr" && args[1] === "merge") {
		mergeCalls.push(args);
		// Honour --match-head-commit: GitHub refuses if the head moved since it was gated.
		const i = args.indexOf("--match-head-commit");
		if (i >= 0 && args[i + 1] && args[i + 1] !== PR.head) {
			return { code: 1, stdout: "", stderr: `Head branch was modified. Review and try the merge again. (expected ${args[i + 1]}, head is ${PR.head})` };
		}
		if (enqueueInsteadOfMerge) return { code: 0, stdout: "", stderr: "" }; // enqueued, state stays OPEN
		if (mergeSimulator) await mergeSimulator(cwd);
		PR.state = "MERGED";
		PR.mergeCommit = PR.head;
		return { code: 0, stdout: "", stderr: "" };
	}
	if (args[0] === "pr" && (args[1] === "ready" || args[1] === "comment" || args[1] === "edit")) return { code: 0, stdout: "", stderr: "" };
	return { code: 0, stdout: "", stderr: "" };
}

mock.module("../src/gh.ts", () => ({
	gh: mockGh,
	ghJson: async (args: string[], cwd: string) => {
		const r = await mockGh(args, cwd);
		return r.code === 0 && r.stdout ? JSON.parse(r.stdout) : undefined;
	},
	ghAvailable: async () => true,
}));

const { SquadManager } = await import("../src/squad-manager.ts");
const { readLandReceiptIndex, isMeasuredLand } = await import("../src/rail/land-metrics.ts");
const { readSelfLandJournal } = await import("../src/rail/self-land/journal.ts");
import type { GateStage } from "../src/intake.ts";
import type { Judge } from "../src/validator.ts";

const tmps: string[] = [];
afterEach(async () => {
	advanceHeadAfterLiveView = undefined;
	advanceBaseAfterLiveView = undefined;
	enqueueInsteadOfMerge = false;
	mergeSimulator = undefined;
	mergeCalls.length = 0;
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});
async function tmpDir(prefix: string): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(d);
	return d;
}
async function git(cwd: string, ...a: string[]): Promise<{ code: number; stdout: string }> {
	const p = Bun.spawn(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, , code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { code, stdout: stdout.trim() };
}

const passJudge: Judge = async ({ criteria }) => ({ perCriterion: criteria.map((c) => ({ id: c.id, satisfied: true })), confidence: 0.9, rationale: "ok" });
const GREEN: GateStage[] = [{ name: "gate", command: "true" }];
const BRANCH = "deepen/merge-fixture";
const ledgerRow = (n: number): string => JSON.stringify({ at: "2026-08-01", lineage: "native", concernClass: `fix-${n}`, survived: true, source: "fixture", note: `finding ${n}` });

class TestManager extends SquadManager {
	judge: Judge | undefined = passJudge;
	protected validatorJudgeOverride(): Judge | undefined {
		return this.judge;
	}
	ledgerPath: string | undefined;
	protected reviewerLedgerPathOverride(): string | undefined {
		return this.ledgerPath;
	}
	protected selfLandGateStages(): Promise<GateStage[]> {
		return Promise.resolve(GREEN);
	}
	protected resolveLandModeFor(): Promise<{ mode: "pr"; defaultBranch: string; reason: string }> {
		return Promise.resolve({ mode: "pr", defaultBranch: "main", reason: "forced pr for test" });
	}
}

/** A repo on main + a bare origin, with a feature branch pushed; returns the tip SHA (the PR head). */
async function prRepo(prefix: string): Promise<{ repo: string; tip: string }> {
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
	await git(repo, "checkout", "-q", "-b", BRANCH);
	await fs.writeFile(path.join(repo, "feature.txt"), "feature\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "add feature");
	await git(repo, "push", "-q", "origin", BRANCH);
	const tip = (await git(repo, "rev-parse", "HEAD")).stdout;
	await git(repo, "checkout", "-q", "main");
	return { repo, tip };
}

async function mkManager(prefix: string): Promise<{ mgr: TestManager; stateDir: string }> {
	const stateDir = await tmpDir(`${prefix}state-`);
	const mgr = new TestManager({ stateDir });
	const ledgerDir = await tmpDir(`${prefix}ledger-`);
	const ledgerFile = path.join(ledgerDir, "l.jsonl");
	await fs.writeFile(ledgerFile, [ledgerRow(0), ledgerRow(1)].join("\n") + "\n");
	mgr.ledgerPath = ledgerFile;
	return { mgr, stateDir };
}

/** Simulate GitHub's merge: push the branch tip into origin/main so ancestry + the C-2 base check pass. */
function pushIntoMain(repo: string, tip: string): () => Promise<void> {
	return async () => {
		await git(repo, "push", "-q", "origin", `${tip}:refs/heads/main`);
	};
}

// ── happy path: the REAL merge, with --match-head-commit on the actual call ─────────────────────

test("HAPPY: a real PR-mode merge passes --match-head-commit and writes a measured row + finalized journal", async () => {
	const { repo, tip } = await prRepo("selfland-merge-happy-");
	const { mgr, stateDir } = await mkManager("selfland-merge-happy-");
	PR = { number: 370, branch: BRANCH, head: tip, base: "main", state: "OPEN", isDraft: false, body: "## Acceptance\n\n- [ ] it works\n" };
	mergeSimulator = pushIntoMain(repo, tip);

	const result = await mgr.selfLand({ repo, pr: 370, expectBase: "main" });

	expect(result.refusal).toBeUndefined();
	expect(result.ok).toBe(true);
	expect(result.measured).toBe(true);
	// The REAL gh pr merge call carried --match-head-commit <tip>.
	const mergeArgs = mergeCalls[0]!;
	expect(mergeArgs).toContain("--match-head-commit");
	expect(mergeArgs[mergeArgs.indexOf("--match-head-commit") + 1]).toBe(tip);
	// A measured row is in the index AND the journal is finalized (crash-safe evidence).
	const { rows } = await readLandReceiptIndex(stateDir);
	expect(rows.length).toBe(1);
	expect(isMeasuredLand(rows[0]!)).toBe(true);
	const journal = await readSelfLandJournal(stateDir);
	expect([...journal.values()].some((e) => e.status === "finalized")).toBe(true);
});

// ── mutation between the live read and the merge → refuse, nothing recorded ─────────────────────

test("C-1: a descendant pushed BETWEEN the live read and the merge → --match-head-commit REFUSES (no row)", async () => {
	const { repo, tip } = await prRepo("selfland-merge-headmove-");
	const { mgr, stateDir } = await mkManager("selfland-merge-headmove-");
	PR = { number: 371, branch: BRANCH, head: tip, base: "main", state: "OPEN", isDraft: false, body: "## Acceptance\n\n- [ ] x\n" };
	// The live guard sees `tip` (matches expectHeadOid, passes); then the head advances to a descendant
	// H2 before `gh pr merge`, which carries --match-head-commit <tip> and is refused by the mock.
	advanceHeadAfterLiveView = "f".repeat(40);
	mergeSimulator = pushIntoMain(repo, tip);

	const result = await mgr.selfLand({ repo, pr: 371, expectBase: "main" });

	expect(result.ok).toBe(false);
	expect(result.measured).toBe(false);
	expect(PR.state).toBe("OPEN"); // never merged
	expect((await readLandReceiptIndex(stateDir)).rows).toEqual([]); // no measured row
	// The journal aborted this attempt (not left dangling as pending).
	const journal = await readSelfLandJournal(stateDir);
	expect([...journal.values()].every((e) => e.status !== "finalized")).toBe(true);
});

test("C-2: the base retargeted BETWEEN the live read and the merge → the guard/merge refuses (no row)", async () => {
	const { repo, tip } = await prRepo("selfland-merge-basemove-");
	const { mgr, stateDir } = await mkManager("selfland-merge-basemove-");
	PR = { number: 372, branch: BRANCH, head: tip, base: "main", state: "OPEN", isDraft: false, body: "## Acceptance\n\n- [ ] x\n" };
	// The base flips to `production` right after the live guard reads `main` — the merge would land on a
	// branch the caller never authorized. gh pr merge into a non-existent/other base fails; nothing lands.
	advanceBaseAfterLiveView = "production";
	mergeSimulator = pushIntoMain(repo, tip);

	const result = await mgr.selfLand({ repo, pr: 372, expectBase: "main" });

	// Either the merge fails against the retargeted base, or the post-merge base check catches it — either
	// way the land does NOT record a measured row on a base the caller never authorized.
	expect(result.measured).toBe(false);
	expect((await readLandReceiptIndex(stateDir)).rows).toEqual([]);
});

// ── merge-queue: enqueue is recorded QUEUED, never aborted ──────────────────────────────────────

test("H-2: gh pr merge that ENQUEUES (exit 0, not merged) is journaled QUEUED, not aborted, and not counted", async () => {
	const { repo, tip } = await prRepo("selfland-merge-queue-");
	const { mgr, stateDir } = await mkManager("selfland-merge-queue-");
	PR = { number: 373, branch: BRANCH, head: tip, base: "main", state: "OPEN", isDraft: false, body: "## Acceptance\n\n- [ ] x\n" };
	enqueueInsteadOfMerge = true; // gh pr merge exits 0 but the PR stays OPEN (queued)

	const result = await mgr.selfLand({ repo, pr: 373, expectBase: "main" });

	expect(result.ok).toBe(false);
	expect(result.refusal).toBe("queued");
	// The journal records it QUEUED — NOT aborted (a queued PR that later merges is a real land).
	const journal = await readSelfLandJournal(stateDir);
	const entries = [...journal.values()];
	expect(entries.some((e) => e.status === "queued")).toBe(true);
	expect(entries.some((e) => e.status === "aborted")).toBe(false);
	// Not counted as measured (nothing merged yet).
	expect((await readLandReceiptIndex(stateDir)).rows).toEqual([]);
});

// ── no open PR in PR mode → refuse (never mutating-create an unpinned land) ─────────────────────

test("C-1: PR mode with NO open PR refuses (never takes the mutating-create path)", async () => {
	const { repo } = await prRepo("selfland-merge-nopr-");
	const { mgr, stateDir } = await mkManager("selfland-merge-nopr-");
	// Route by BRANCH; the mock returns an empty open-PR list for prForBranch by reporting a non-OPEN PR.
	PR = { number: 0, branch: BRANCH, head: "0".repeat(40), base: "main", state: "CLOSED", isDraft: false, body: "" };

	const result = await mgr.selfLand({ repo, branch: BRANCH, criteria: ["done"], expectBase: "main" });

	expect(result.ok).toBe(false);
	expect(result.refusal).toBe("no-pr");
	expect(mergeCalls.length).toBe(0); // never reached gh pr merge
});
