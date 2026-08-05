/**
 * The in-code cross-lineage gauntlet panel (T5, glance#333), driven through the REAL land path
 * (`SquadManager.landBranch` -> `runValidatorGate` -> `validatorGate`) — mirrors
 * `tests/validator-land-gate.test.ts`'s TestManager convention (a fake judge injected via
 * `validatorJudgeOverride`; here also a fake panel reviewer pool via `panelReviewersOverride`).
 *
 * What this proves, end to end:
 *  - the master flag gates the panel exactly like every other rollout flag in this codebase (off by
 *    default; a land with the flag off never spawns reviewers, never queues anything);
 *  - a sensitive-path land WITH the flag on spawns >= 2 distinct-lineage reviewers and the land RECEIPT
 *    (`dto.validation.panel`) carries their verdicts;
 *  - the panel's own findings are QUEUED (not written to the tracked ledger directly — A1) during the
 *    land, and PROJECTED into the tracked ledger only after the merge settles;
 *  - none of this changes whether the land SUCCEEDS — a panel objection is visibility, not a new
 *    merge-blocking authority. The land that would have succeeded before this change still succeeds.
 *
 * Gauntlet round 1 (glance#333 PR #353, finding A1 — CRITICAL, both lineages converged): "SELF-LAND OF
 * THIS REPO" is the scenario that exposed the bug — the ledger's own repo IS the repo being landed into
 * (glance managing itself), so the panel's OLD direct-append write dirtied the exact tree
 * `landAgentLocked`'s dirty-main check was about to inspect, turning a clean pass into an accidental
 * refusal. `"SELF-LAND OF THIS REPO"` below reproduces that exact topology against the FIXED
 * architecture and proves the land still succeeds, the tree is clean throughout, and the projected
 * ledger row lands as a real, committed row.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runProof } from "../src/proof.ts";
import { readPendingPanelFindings } from "../src/rail/panel-ledger.ts";
import type { PanelReviewerSpec, PanelVerifyReviewer } from "../src/rail/panel.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SubagentTracker } from "../src/subagents.ts";
import type { AgentDTO, PersistedAgent, PersistedFeature } from "../src/types.ts";
import type { Judge } from "../src/validator.ts";

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

const ENV_KEYS = ["OMP_SQUAD_VALIDATOR", "OMP_SQUAD_REVIEW_PANEL"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
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

/** A repo on `main` plus a worktree branch that touches a SENSITIVE path (a CI workflow file) — enough
 *  to trip `diffRiskTier`'s "sensitive path" arm regardless of file count. Mirrors
 *  `validator-land-gate.test.ts`'s `repoWithBranch`, swapping the touched file. */
async function repoWithSensitiveBranch(prefix: string): Promise<{ repo: string; worktree: string; branch: string }> {
	const repo = await tmpDir(prefix);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "base.txt"), `base ${prefix}\n`);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	const branch = "squad/panel";
	const worktree = path.join(await tmpDir(`${prefix}wt-`), "wt");
	await git(repo, "worktree", "add", "-q", "-b", branch, worktree, "main");
	const wfDir = path.join(worktree, ".github", "workflows");
	await fs.mkdir(wfDir, { recursive: true });
	await fs.writeFile(path.join(wfDir, "deploy.yml"), `on: push (${prefix})\n`);
	await git(worktree, "add", "-A");
	await git(worktree, "commit", "-qm", "touch CI workflow");
	return { repo, worktree, branch };
}

class TestManager extends SquadManager {
	judge: Judge | undefined;
	protected validatorJudgeOverride(): Judge | undefined {
		return this.judge;
	}
	ledgerPath: string | undefined;
	protected reviewerLedgerPathOverride(): string | undefined {
		return this.ledgerPath;
	}
	panelReviewers: (() => PanelReviewerSpec[]) | undefined;
	protected panelReviewersOverride(): (() => PanelReviewerSpec[]) | undefined {
		return this.panelReviewers;
	}
	panelVerify: (() => PanelVerifyReviewer) | undefined;
	protected panelVerifyOverride(): (() => PanelVerifyReviewer) | undefined {
		return this.panelVerify;
	}
	ledgerRepo: string | undefined;
	protected reviewerLedgerRepoOverride(): string | undefined {
		return this.ledgerRepo;
	}
	/** Awaits the LAST fire-and-forget projection attempt `land()` kicked off — the test-only seam
	 *  documented on `SquadManager.lastPanelProjectionForTests`. */
	async waitForPanelProjection(): Promise<{ projected: number; committed: boolean } | undefined> {
		return this.lastPanelProjectionForTests;
	}
}

function seedAgent(mgr: SquadManager, id: string, repo: string, worktree: string, branch: string, featureId?: string): void {
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
		featureId,
	};
	const options: PersistedAgent = { id, name: id, repo, worktree, approvalMode: "yolo" };
	mgr.agents.set(id, { dto, agent: undefined as never, options, transcript: [], assistantBuf: "", streaming: false, subs: new SubagentTracker() });
}

const passJudge: Judge = async () => ({ perCriterion: [{ id: "c1", satisfied: true }] });
const CRITERIA = [{ id: "c1", text: "adds the CI workflow", completed: false }];

const acceptPanel = (lineage: PanelReviewerSpec["lineage"], harness: string): PanelReviewerSpec => ({ lineage, harness, review: async () => ({ disposition: "accept" }) });

async function tmpLedgerFile(): Promise<string> {
	const dir = await tmpDir("panel-land-ledger-");
	return path.join(dir, "reviewer-ledger.jsonl");
}

test("master flag OFF (default) ⇒ a sensitive-path land succeeds with no panel and no reviewers ever called", async () => {
	const stateDir = await tmpDir("panel-land-off-state-");
	const { repo, worktree, branch } = await repoWithSensitiveBranch("panel-off-");
	const mgr = new TestManager({ stateDir });
	mgr.judge = passJudge;
	let called = 0;
	mgr.panelReviewers = () => [
		{
			lineage: "xai",
			harness: "grok",
			review: async () => {
				called++;
				return { disposition: "object", severity: "high" as const, claim: "should never fire" };
			},
		},
		acceptPanel("openai", "codex"),
	];
	seedAgent(mgr, "a1", repo, worktree, branch, "f1");
	(mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore.set("f1", { id: "f1", title: "F1", repo, createdAt: 0, updatedAt: 0, acceptanceCriteria: CRITERIA });
	await runProof({ repo, worktree, command: "true" });

	const result = await mgr.land("a1", undefined, {});

	expect(result.ok).toBe(true);
	expect(result.merged).toBe(true);
	expect(called).toBe(0);
	expect(mgr.agents.get("a1")?.dto.validation?.panel).toBeUndefined();
	expect(readPendingPanelFindings(stateDir)).toEqual([]);
});

test("master flag ON + sensitive-path land ⇒ the receipt carries >= 2 distinct-lineage panel verdicts, and the land STILL SUCCEEDS", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const stateDir = await tmpDir("panel-land-on-state-");
	const { repo, worktree, branch } = await repoWithSensitiveBranch("panel-on-");
	const mgr = new TestManager({ stateDir });
	mgr.judge = passJudge;
	mgr.panelReviewers = () => [acceptPanel("xai", "grok"), acceptPanel("openai", "codex")];
	seedAgent(mgr, "a1", repo, worktree, branch, "f1");
	(mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore.set("f1", { id: "f1", title: "F1", repo, createdAt: 0, updatedAt: 0, acceptanceCriteria: CRITERIA });
	await runProof({ repo, worktree, command: "true" });

	const result = await mgr.land("a1", undefined, {});

	expect(result.ok).toBe(true);
	expect(result.merged).toBe(true);
	const panel = mgr.agents.get("a1")?.dto.validation?.panel;
	expect(panel).toBeDefined();
	expect(panel!.length).toBe(2);
	expect(new Set(panel!.map((p) => p.lineage)).size).toBe(2);
});

test("a HIGH-severity panel objection, confirmed, is QUEUED (A1 — never written to the tracked ledger directly) AND the land STILL SUCCEEDS", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const stateDir = await tmpDir("panel-land-obj-state-");
	const { repo, worktree, branch } = await repoWithSensitiveBranch("panel-obj-");
	const mgr = new TestManager({ stateDir });
	mgr.judge = passJudge;
	mgr.ledgerPath = await tmpLedgerFile();
	mgr.panelReviewers = () => [
		{ lineage: "xai", harness: "grok", review: async () => ({ disposition: "object", severity: "high" as const, claim: "a real-looking finding", concernClass: "fail-open" }) },
		acceptPanel("openai", "codex"),
	];
	mgr.panelVerify = () => async () => true;
	seedAgent(mgr, "a1", repo, worktree, branch, "f1");
	(mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore.set("f1", { id: "f1", title: "F1", repo, createdAt: 0, updatedAt: 0, acceptanceCriteria: CRITERIA });
	await runProof({ repo, worktree, command: "true" });

	const result = await mgr.land("a1", undefined, {});

	// The land that would have succeeded before this change (a clean criteria pass) still succeeds —
	// the panel objection is recorded and surfaced, never a merge-blocking veto.
	expect(result.ok).toBe(true);
	expect(result.merged).toBe(true);
	const panel = mgr.agents.get("a1")?.dto.validation?.panel;
	expect(panel!.find((p) => p.lineage === "xai")).toMatchObject({ verdict: "object", severity: "high", survived: true, concernClass: "fail-open" });

	// A7: queued under the CANONICAL ledger tag ("grok"), not the raw vendor lineage ("xai").
	const queued = readPendingPanelFindings(stateDir);
	expect(queued.length).toBe(1);
	expect(queued[0]).toMatchObject({ lineage: "grok", concernClass: "fail-open", survived: true });
	expect(String(queued[0].source)).toContain(branch);

	// The gate-verdict transcript event also carries the panel, so the receipt is durable, not just
	// an in-memory DTO field.
	const verdict = mgr.getTranscript("a1").find((e) => e.event?.kind === "gate-verdict");
	expect(verdict?.event?.payload).toMatchObject({ verdict: "pass" });
	expect(Array.isArray((verdict?.event?.payload as { panel?: unknown[] } | undefined)?.panel)).toBe(true);
});

test("a docs-only land gets no panel even with the master flag on — reviewers never called", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const stateDir = await tmpDir("panel-land-docs-state-");
	const repo = await tmpDir("panel-docs-");
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "base.txt"), "base\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	const branch = "squad/panel-docs";
	const worktree = path.join(await tmpDir("panel-docs-wt-"), "wt");
	await git(repo, "worktree", "add", "-q", "-b", branch, worktree, "main");
	await fs.writeFile(path.join(worktree, "README.md"), "docs change\n");
	await git(worktree, "add", "-A");
	await git(worktree, "commit", "-qm", "docs only");

	const mgr = new TestManager({ stateDir });
	mgr.judge = passJudge;
	let called = 0;
	mgr.panelReviewers = () => [
		{
			lineage: "xai",
			harness: "grok",
			review: async () => {
				called++;
				return { disposition: "accept" as const };
			},
		},
		acceptPanel("openai", "codex"),
	];
	seedAgent(mgr, "a1", repo, worktree, branch, "f1");
	(mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore.set("f1", { id: "f1", title: "F1", repo, createdAt: 0, updatedAt: 0, acceptanceCriteria: CRITERIA });
	await runProof({ repo, worktree, command: "true" });

	const result = await mgr.land("a1", undefined, {});

	expect(result.ok).toBe(true);
	expect(called).toBe(0);
	expect(mgr.agents.get("a1")?.dto.validation?.panel).toBeUndefined();
});

// ── A1 CRITICAL regression: "SELF-LAND OF THIS REPO" ────────────────────────────────────────────
// The exact topology that exposed the bug: the ledger's OWNING repo IS the repo being landed into
// (glance managing itself). The OLD code appended straight to `<repo>/plans/.reviews/reviewer-ledger.jsonl`
// DURING the pre-land panel — dirtying the very tree `landAgentLocked`'s dirty-main check was about to
// inspect, right after the panel's own successful write. A clean, validator-passing branch would then
// get BLOCKED by the panel's side effect. These tests reproduce that topology against the FIXED
// architecture (queue -> projection, out of the land path) and prove it end to end.

async function selfLandRepo(prefix: string): Promise<{ repo: string; worktree: string; branch: string; ledgerPath: string }> {
	const repo = await tmpDir(prefix);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	const ledgerDir = path.join(repo, "plans", ".reviews");
	await fs.mkdir(ledgerDir, { recursive: true });
	const ledgerPath = path.join(ledgerDir, "reviewer-ledger.jsonl");
	await fs.writeFile(ledgerPath, "");
	await fs.writeFile(path.join(repo, "base.txt"), `base ${prefix}\n`);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	const branch = "squad/self-land";
	const worktree = path.join(await tmpDir(`${prefix}wt-`), "wt");
	await git(repo, "worktree", "add", "-q", "-b", branch, worktree, "main");
	const wfDir = path.join(worktree, ".github", "workflows");
	await fs.mkdir(wfDir, { recursive: true });
	await fs.writeFile(path.join(wfDir, "deploy.yml"), `on: push (${prefix})\n`);
	await git(worktree, "add", "-A");
	await git(worktree, "commit", "-qm", "touch CI workflow");
	return { repo, worktree, branch, ledgerPath };
}

test("SELF-LAND OF THIS REPO (A1 CRITICAL): a clean branch with a confirmed panel objection lands successfully — the panel's own write no longer dirties the tree the land gate is about to inspect", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const stateDir = await tmpDir("panel-selfland-state-");
	const { repo, worktree, branch, ledgerPath } = await selfLandRepo("panel-selfland-");
	const mgr = new TestManager({ stateDir });
	mgr.judge = passJudge;
	mgr.ledgerPath = ledgerPath;
	mgr.ledgerRepo = repo; // the ledger's OWNING repo is the SAME repo being landed into
	mgr.panelReviewers = () => [
		{ lineage: "xai", harness: "grok", review: async () => ({ disposition: "object", severity: "high" as const, claim: "a real-looking finding", concernClass: "fail-open" }) },
		acceptPanel("openai", "codex"),
	];
	mgr.panelVerify = () => async () => true;
	seedAgent(mgr, "a1", repo, worktree, branch, "f1");
	(mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore.set("f1", { id: "f1", title: "F1", repo, createdAt: 0, updatedAt: 0, acceptanceCriteria: CRITERIA });
	await runProof({ repo, worktree, command: "true" });

	const before = await git(repo, "status", "--porcelain");
	expect(before.out).toBe("");

	const result = await mgr.land("a1", undefined, {});

	// (1) THE CORE A1 FIX: the land succeeds — the panel finding a real objection did NOT block it.
	expect(result.ok).toBe(true);
	expect(result.merged).toBe(true);

	// (2) The tree is CLEAN immediately after land() returns — queuing under stateDir never touched
	// the repo being landed, unlike the old direct-append bug (this holds true regardless of whether
	// the fire-and-forget projection below has already raced ahead and completed by this point — the
	// PROPERTY under test is "the tree was never dirtied by the QUEUE write", which the projection lane
	// preserves too: it always returns the tree to clean before releasing its lock).
	const afterLand = await git(repo, "status", "--porcelain");
	expect(afterLand.out).toBe("");

	// (3) `land()` already kicked off the projection fire-and-forget (post-merge, out of the critical
	// path) — await it explicitly rather than racing a timer or assuming it hasn't run yet (it may well
	// have completed before this line, which is fine: the queue write is synchronous and durable either
	// way).
	const projection = await mgr.waitForPanelProjection();
	expect(projection).toEqual({ projected: 1, committed: true });

	// (4) The row is now durably COMMITTED to the tracked ledger, and the tree is clean again.
	const ledgerAfterProjection = await fs.readFile(ledgerPath, "utf8");
	const rows = ledgerAfterProjection
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
	expect(rows.length).toBe(1);
	expect(rows[0]).toMatchObject({ lineage: "grok", concernClass: "fail-open", survived: true });
	const afterProjection = await git(repo, "status", "--porcelain");
	expect(afterProjection.out).toBe("");
	expect(readPendingPanelFindings(stateDir)).toEqual([]);

	// (5) A SECOND land into the SAME repo afterward ALSO succeeds — the projection's own commit left
	// nothing dirty behind to block it (closing the loop this bug would otherwise have reopened one
	// step later).
	const worktree2 = path.join(await tmpDir("panel-selfland-wt2-"), "wt");
	await git(repo, "worktree", "add", "-q", "-b", "squad/self-land-2", worktree2, "main");
	await fs.writeFile(path.join(worktree2, "feature2.txt"), "second change\n");
	await git(worktree2, "add", "-A");
	await git(worktree2, "commit", "-qm", "second change");
	const mgr2 = new TestManager({ stateDir: await tmpDir("panel-selfland-state2-") });
	mgr2.judge = passJudge;
	seedAgent(mgr2, "a2", repo, worktree2, "squad/self-land-2", "f2");
	(mgr2 as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore.set("f2", { id: "f2", title: "F2", repo, createdAt: 0, updatedAt: 0, acceptanceCriteria: [{ id: "c1", text: "x", completed: false }] });
	await runProof({ repo, worktree: worktree2, command: "true" });
	const secondResult = await mgr2.land("a2", undefined, {});
	expect(secondResult.ok).toBe(true);
	expect(secondResult.merged).toBe(true);
});

test("SELF-LAND OF THIS REPO: with the panel flag OFF, nothing is queued and the tree stays untouched throughout (baseline, no regression from the projection machinery existing at all)", async () => {
	const stateDir = await tmpDir("panel-selfland-off-state-");
	const { repo, worktree, branch, ledgerPath } = await selfLandRepo("panel-selfland-off-");
	const mgr = new TestManager({ stateDir });
	mgr.judge = passJudge;
	mgr.ledgerPath = ledgerPath;
	mgr.ledgerRepo = repo;
	seedAgent(mgr, "a1", repo, worktree, branch, "f1");
	(mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore.set("f1", { id: "f1", title: "F1", repo, createdAt: 0, updatedAt: 0, acceptanceCriteria: CRITERIA });
	await runProof({ repo, worktree, command: "true" });

	const result = await mgr.land("a1", undefined, {});

	expect(result.ok).toBe(true);
	const after = await git(repo, "status", "--porcelain");
	expect(after.out).toBe("");
	expect(readPendingPanelFindings(stateDir)).toEqual([]);
});
