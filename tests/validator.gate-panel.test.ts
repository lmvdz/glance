/**
 * validatorGate's cross-lineage gauntlet-panel wiring (T5, glance#333) — mirrors
 * `tests/validator.gate-lens.test.ts`'s structure for the panel's own master-flag gating, plus a real
 * git diff (mirrors `tests/validator.gate-lens-live.test.ts`) to prove the panel actually attaches
 * `record.panel` on the real land path and never changes `verdict`/`veto`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Proof } from "../src/proof.ts";
import type { PanelReviewerSpec, PanelVerifyReviewer } from "../src/rail/panel.ts";
import type { Judge } from "../src/validator.ts";
import { validatorGate } from "../src/validator.ts";

afterEach(() => {
	delete process.env.OMP_SQUAD_REVIEW_PANEL;
	delete process.env.OMP_SQUAD_VALIDATOR;
});

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function git(cwd: string, ...a: string[]): Promise<string> {
	const p = Bun.spawn(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
	const out = await new Response(p.stdout).text();
	await p.exited;
	return out.trim();
}

/** A real repo with a base commit and a follow-up commit touching `files`, so `computeLandDiff` sees a
 *  genuine diff over those exact paths (risk-tiering needs REAL path names, unlike the lens tests which
 *  only care about docs-vs-code). */
async function realDiffRepo(files: Record<string, string>): Promise<{ repo: string; baseCommit: string }> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "panel-live-"));
	tmps.push(repo);
	await git(repo, "init", "-q");
	await git(repo, "config", "user.email", "test@example.com");
	await git(repo, "config", "user.name", "test");
	await fs.writeFile(path.join(repo, "seed.txt"), "seed\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	const baseCommit = await git(repo, "rev-parse", "HEAD");
	for (const [rel, body] of Object.entries(files)) {
		const abs = path.join(repo, rel);
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, body);
	}
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "change");
	return { repo, baseCommit };
}

const passJudge: Judge = async ({ criteria }) => ({ perCriterion: criteria.map((c) => ({ id: c.id, satisfied: true })) });
const vetoJudge: Judge = async ({ criteria }) => ({ perCriterion: criteria.map((c, i) => ({ id: c.id, satisfied: i > 0 })) });

const acceptPanel = (lineage: PanelReviewerSpec["lineage"], harness: string): PanelReviewerSpec => ({ lineage, harness, review: async () => ({ disposition: "accept" }) });

/** A scratch stateDir so an objecting-reviewer test NEVER queues toward the real
 *  `plans/.reviews/reviewer-ledger.jsonl` (T5 gauntlet round 1, finding A1 — the panel QUEUES under
 *  stateDir, it never writes the tracked ledger directly) — every test below that can produce an
 *  adjudicated finding passes this via `panelStateDir`. */
async function tmpStateDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-panel-state-"));
	tmps.push(dir);
	return dir;
}

describe("validatorGate panel gating (master flag, mirrors lens gating)", () => {
	test("master flag OFF ⇒ panel reviewers never invoked, no record.panel", async () => {
		let called = 0;
		const panelReviewers = (): PanelReviewerSpec[] => [
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
		const { record } = await validatorGate({
			criteria: [{ id: "c1", text: "x", completed: false }],
			repo: process.cwd(),
			worktree: process.cwd(),
			judge: passJudge,
			panelReviewers,
		});
		expect(called).toBe(0);
		expect(record.panel).toBeUndefined();
	});

	test("validator disabled ⇒ skipped, panel never consulted even with the master flag on", async () => {
		process.env.OMP_SQUAD_REVIEW_PANEL = "1";
		process.env.OMP_SQUAD_VALIDATOR = "0";
		let called = 0;
		const panelReviewers = (): PanelReviewerSpec[] => [
			{
				lineage: "xai",
				harness: "grok",
				review: async () => {
					called++;
					return { disposition: "object", severity: "high" as const, claim: "x" };
				},
			},
			acceptPanel("openai", "codex"),
		];
		const { record } = await validatorGate({ criteria: [{ id: "c1", text: "x", completed: false }], repo: process.cwd(), worktree: process.cwd(), panelReviewers });
		expect(record.verdict).toBe("skipped");
		expect(called).toBe(0);
	});
});

describe("validatorGate panel wiring — live git diff", () => {
	test("master flag ON + a sensitive-path diff ⇒ the panel fires and attaches record.panel; verdict stays PASS", async () => {
		process.env.OMP_SQUAD_REVIEW_PANEL = "1";
		const { repo, baseCommit } = await realDiffRepo({ ".github/workflows/deploy.yml": "on: push\n" });
		const panelReviewers = (): PanelReviewerSpec[] => [acceptPanel("xai", "grok"), acceptPanel("openai", "codex")];
		const { record } = await validatorGate({
			criteria: [{ id: "c1", text: "does the thing", completed: false }],
			repo,
			worktree: repo,
			proof: { baseCommit } as Proof,
			judge: passJudge,
			panelReviewers,
		});
		expect(record.verdict).toBe("pass");
		expect(record.panel).toBeDefined();
		expect(record.panel!.length).toBe(2);
		expect(record.panel!.every((p) => p.verdict === "accept")).toBe(true);
	});

	test("a docs-only diff ⇒ no panel even with the master flag on", async () => {
		process.env.OMP_SQUAD_REVIEW_PANEL = "1";
		const { repo, baseCommit } = await realDiffRepo({ "README.md": "docs\n" });
		let called = 0;
		const panelReviewers = (): PanelReviewerSpec[] => [
			{
				lineage: "xai",
				harness: "grok",
				review: async () => {
					called++;
					return { disposition: "object", severity: "high" as const, claim: "should never fire on docs" };
				},
			},
			acceptPanel("openai", "codex"),
		];
		const { record } = await validatorGate({ criteria: [{ id: "c1", text: "docs", completed: false }], repo, worktree: repo, proof: { baseCommit } as Proof, judge: passJudge, panelReviewers });
		expect(record.panel).toBeUndefined();
		expect(called).toBe(0);
	});

	test("a VETO verdict on a sensitive-path diff STILL gets a panel — a human overriding the veto deserves the context; the panel does not change the veto", async () => {
		process.env.OMP_SQUAD_REVIEW_PANEL = "1";
		const { repo, baseCommit } = await realDiffRepo({ ".github/workflows/deploy.yml": "on: push\n" });
		const panelReviewers = (): PanelReviewerSpec[] => [acceptPanel("xai", "grok"), acceptPanel("openai", "codex")];
		const { record, veto } = await validatorGate({
			criteria: [{ id: "c1", text: "a", completed: false }, { id: "c2", text: "b", completed: false }],
			repo,
			worktree: repo,
			proof: { baseCommit } as Proof,
			judge: vetoJudge,
			panelReviewers,
		});
		expect(record.verdict).toBe("veto");
		expect(veto).toBeDefined();
		expect(record.panel).toBeDefined();
		expect(record.panel!.length).toBe(2);
	});

	test("a panel objection NEVER turns a pass into a veto — purely additive, no new blocking authority", async () => {
		process.env.OMP_SQUAD_REVIEW_PANEL = "1";
		const { repo, baseCommit } = await realDiffRepo({ ".github/workflows/deploy.yml": "on: push\n" });
		const panelReviewers = (): PanelReviewerSpec[] => [
			{ lineage: "xai", harness: "grok", review: async () => ({ disposition: "object", severity: "high", claim: "a serious-sounding finding" }) },
			acceptPanel("openai", "codex"),
		];
		const verify: () => PanelVerifyReviewer = () => async () => true;
		const stateDir = await tmpStateDir();
		const { record, veto } = await validatorGate({
			criteria: [{ id: "c1", text: "does the thing", completed: false }],
			repo,
			worktree: repo,
			proof: { baseCommit } as Proof,
			judge: passJudge,
			panelReviewers,
			panelVerify: verify,
			panelStateDir: stateDir,
		});
		expect(record.verdict).toBe("pass");
		expect(veto).toBeUndefined();
		expect(record.panel!.find((p) => p.lineage === "xai")).toMatchObject({ verdict: "object", severity: "high", survived: true });
	});
});
