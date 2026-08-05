/**
 * The in-code cross-lineage gauntlet panel (T5, glance#333), driven through the REAL land path
 * (`SquadManager.landBranch` -> `runValidatorGate` -> `validatorGate`) — mirrors
 * `tests/validator-land-gate.test.ts`'s TestManager convention (a fake judge injected via
 * `validatorJudgeOverride`; here also a fake panel reviewer pool via `panelReviewersOverride`).
 *
 * What this proves, end to end:
 *  - the master flag gates the panel exactly like every other rollout flag in this codebase (off by
 *    default; a land with the flag off never spawns reviewers, never touches the ledger);
 *  - a sensitive-path land WITH the flag on spawns >= 2 distinct-lineage reviewers and the land RECEIPT
 *    (`dto.validation.panel`) carries their verdicts;
 *  - the panel's own findings are recorded to the reviewer ledger (the same rows a human runs
 *    `reviewer-ledger.ts add` for);
 *  - none of this changes whether the land SUCCEEDS — a panel objection is visibility, not a new
 *    merge-blocking authority. The land that would have succeeded before this change still succeeds.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runProof } from "../src/proof.ts";
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

async function git(cwd: string, ...a: string[]): Promise<void> {
	await Bun.spawn(["git", ...a], { cwd, stdout: "ignore", stderr: "ignore" }).exited;
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

async function readLedgerRows(ledgerPath: string): Promise<Record<string, unknown>[]> {
	const text = await fs.readFile(ledgerPath, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
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

test("a HIGH-severity panel objection, confirmed by the recheck, is recorded to the ledger AND the land STILL SUCCEEDS — visibility, not a new blocking authority", async () => {
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

	const rows = await readLedgerRows(mgr.ledgerPath!);
	expect(rows.length).toBe(1);
	expect(rows[0]).toMatchObject({ lineage: "xai", concernClass: "fail-open", survived: true });
	expect(String(rows[0].source)).toContain(branch);

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
