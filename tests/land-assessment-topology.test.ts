/**
 * Concern 03 (topology-analyzer) verification: each detection fires on its positive fixture and
 * stays silent on the corresponding benign fixture. Real git in tmp dirs, no mocks — same convention
 * as `land-stale-gate.test.ts`/`orphan-audit.test.ts` (a topology analyzer's whole point is fidelity
 * to actual git plumbing, so a fake git graph would prove nothing).
 *
 * `topology.test.ts` lives in `tests/`, not co-located under `src/land-assessment/analyzers/` (the
 * concern doc's literal TOUCHES path) — `bunfig.toml`'s `[test] root = "tests"` was set by the
 * schema-and-identity/batch1-review-fixes concerns specifically so `bun test` (no path) picks up
 * every land-assessment test; a co-located file would silently need `bun test <path>` forever.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runAnalyzers, type AnalyzerContext } from "../src/land-assessment/analyzers/plugin.ts";
import { topologyAnalyzer, TOPOLOGY_ANALYZER_VERSION } from "../src/land-assessment/analyzers/topology.ts";
import type { AssessmentFinding } from "../src/land-assessment/schema.ts";

// ── git fixture builders (real git, no mocking — mirrors land-stale-gate.test.ts/orphan-audit.test.ts) ──

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function git(cwd: string, ...a: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const p = Bun.spawn(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function tmpDir(prefix: string): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(d);
	return d;
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
	return (await git(repo, "rev-parse", "HEAD")).stdout;
}

async function rev(repo: string, ref: string): Promise<string> {
	return (await git(repo, "rev-parse", ref)).stdout;
}

function findingsOfKind(findings: readonly AssessmentFinding[], kind: string): AssessmentFinding[] {
	return findings.filter((f) => f.kind === kind);
}

// ── the analyzer's own metadata ──────────────────────────────────────────────────────────────────

test("topologyAnalyzer: claims exactly git-topology + workflow-state, matching incident-taxonomy's CLAIMED_BY", () => {
	expect(topologyAnalyzer.name).toBe("topology");
	expect(topologyAnalyzer.version).toBe(TOPOLOGY_ANALYZER_VERSION);
	expect([...topologyAnalyzer.claimedClasses].sort()).toEqual(["git-topology", "workflow-state"]);
});

test("topologyAnalyzer: applicable() is true for a well-formed context, false when a commit is missing", () => {
	const ctx: AnalyzerContext = { repo: "/tmp/x", baseCommit: "a", mainCommit: "b", candidateCommit: "c" };
	expect(topologyAnalyzer.applicable(ctx)).toBe(true);
	expect(topologyAnalyzer.applicable({ ...ctx, candidateCommit: "" })).toBe(false);
});

// ── stacked-base ─────────────────────────────────────────────────────────────────────────────────

describe("stacked-base", () => {
	test("fires when the candidate's fork point against main differs from its fork point against the declared base", async () => {
		const repo = await gitRepo("topo-stacked-pos-");
		const root = await commit(repo, "root.txt", "root\n", "root");
		// A sibling branch ("declared base") diverges from root — a stacked PR is built ON TOP of it.
		await git(repo, "checkout", "-qb", "sibling-base");
		const siblingTip = await commit(repo, "sibling.txt", "sibling\n", "sibling work");
		await git(repo, "checkout", "-qb", "candidate");
		const candidateTip = await commit(repo, "candidate.txt", "candidate\n", "candidate work");
		// Meanwhile main advances independently from root, never merging sibling-base.
		await git(repo, "checkout", "-q", "main");
		const mainTip = await commit(repo, "main-only.txt", "main advances\n", "main advances");

		const ctx: AnalyzerContext = { repo, baseCommit: siblingTip, mainCommit: mainTip, candidateCommit: candidateTip };
		const result = await topologyAnalyzer.run(ctx);
		const findings = findingsOfKind(result.findings, "topology.stacked-base");
		expect(findings).toHaveLength(1);
		expect(findings[0]!.statement).toContain(candidateTip);
		expect(findings[0]!.semantics.authority).toBe("deterministic");
		expect(findings[0]!.derivedFromObservations.length).toBeGreaterThan(0);
		void root;
	});

	test("stays silent when the candidate is properly forked from current main", async () => {
		const repo = await gitRepo("topo-stacked-neg-");
		await commit(repo, "root.txt", "root\n", "root");
		const mainTip = await commit(repo, "main.txt", "main\n", "main advances");
		await git(repo, "checkout", "-qb", "candidate");
		const candidateTip = await commit(repo, "candidate.txt", "candidate\n", "candidate work");

		const ctx: AnalyzerContext = { repo, baseCommit: mainTip, mainCommit: mainTip, candidateCommit: candidateTip };
		const result = await topologyAnalyzer.run(ctx);
		expect(findingsOfKind(result.findings, "topology.stacked-base")).toHaveLength(0);
	});
});

// ── orphaned-merge ───────────────────────────────────────────────────────────────────────────────

describe("orphaned-merge", () => {
	test("fires when the candidate's commits never reached main", async () => {
		const repo = await gitRepo("topo-orphan-pos-");
		await commit(repo, "root.txt", "root\n", "root");
		const mainTip = await rev(repo, "HEAD");
		await git(repo, "checkout", "-qb", "feature");
		await commit(repo, "f1.txt", "one\n", "feature commit 1");
		const candidateTip = await commit(repo, "f2.txt", "two\n", "feature commit 2");
		// main never merges feature — the exact orphaned-merged-PR shape.

		const ctx: AnalyzerContext = { repo, baseCommit: mainTip, mainCommit: mainTip, candidateCommit: candidateTip };
		const result = await topologyAnalyzer.run(ctx);
		const findings = findingsOfKind(result.findings, "topology.orphaned-merge");
		expect(findings).toHaveLength(1);
		expect(findings[0]!.statement).toContain("2 commit(s)");
	});

	test("stays silent when the candidate is fully merged into main", async () => {
		const repo = await gitRepo("topo-orphan-neg-");
		await commit(repo, "root.txt", "root\n", "root");
		await git(repo, "checkout", "-qb", "feature");
		const candidateTip = await commit(repo, "f1.txt", "one\n", "feature commit");
		await git(repo, "checkout", "-q", "main");
		await git(repo, "merge", "-q", "--no-ff", "feature", "-m", "merge feature");
		const mainTip = await rev(repo, "HEAD");

		const ctx: AnalyzerContext = { repo, baseCommit: mainTip, mainCommit: mainTip, candidateCommit: candidateTip };
		const result = await topologyAnalyzer.run(ctx);
		expect(findingsOfKind(result.findings, "topology.orphaned-merge")).toHaveLength(0);
	});
});

// ── transplanted-lineage (patch-id duplicate) ───────────────────────────────────────────────────

describe("transplanted-lineage", () => {
	test("fires when a candidate commit's content already landed on main under a different sha (rebase/squash duplication)", async () => {
		const repo = await gitRepo("topo-transplant-pos-");
		const baseTip = await commit(repo, "root.txt", "root\n", "root");
		await git(repo, "checkout", "-qb", "feature");
		const candidateTip = await commit(repo, "feature.txt", "same content\n", "feature work");
		// Simulate a squash/rebase landing: apply the SAME patch directly onto main under a NEW sha
		// (mirrors orphan-audit.test.ts's "rebase-equivalent" fixture — same content, distinct commit).
		await git(repo, "checkout", "-q", "main");
		await commit(repo, "feature.txt", "same content\n", "feature work (rebased onto main)");
		const mainTip = await rev(repo, "HEAD");

		const ctx: AnalyzerContext = { repo, baseCommit: baseTip, mainCommit: mainTip, candidateCommit: candidateTip };
		const result = await topologyAnalyzer.run(ctx);
		const findings = findingsOfKind(result.findings, "topology.transplanted-lineage");
		expect(findings).toHaveLength(1);
		expect(findings[0]!.statement).toContain("1 candidate commit(s)");
	});

	test("stays silent when candidate and main touch the same file with genuinely different content", async () => {
		const repo = await gitRepo("topo-transplant-neg-");
		const baseTip = await commit(repo, "root.txt", "root\n", "root");
		await git(repo, "checkout", "-qb", "feature");
		const candidateTip = await commit(repo, "feature.txt", "candidate content\n", "feature work");
		await git(repo, "checkout", "-q", "main");
		await commit(repo, "feature.txt", "unrelated main content\n", "main's own work");
		const mainTip = await rev(repo, "HEAD");

		const ctx: AnalyzerContext = { repo, baseCommit: baseTip, mainCommit: mainTip, candidateCommit: candidateTip };
		const result = await topologyAnalyzer.run(ctx);
		expect(findingsOfKind(result.findings, "topology.transplanted-lineage")).toHaveLength(0);
	});
});

// ── stale-fork-overlap ───────────────────────────────────────────────────────────────────────────

const LINES = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");

describe("stale-fork-overlap", () => {
	test("fires when the fork point is behind main AND both sides edited the same file", async () => {
		const repo = await gitRepo("topo-stale-pos-");
		await fs.writeFile(path.join(repo, "shared.txt"), `${LINES}\n`);
		await git(repo, "add", "-A");
		await git(repo, "commit", "-qm", "base");
		const baseTip = await rev(repo, "HEAD");

		await git(repo, "checkout", "-qb", "candidate");
		const sharedLines = (await fs.readFile(path.join(repo, "shared.txt"), "utf8")).split("\n");
		sharedLines[0] = "candidate edit";
		await fs.writeFile(path.join(repo, "shared.txt"), sharedLines.join("\n"));
		const candidateTip = await commit(repo, "candidate-only.txt", "candidate\n", "candidate edits top of shared.txt");

		await git(repo, "checkout", "-q", "main");
		const mainLines = (await fs.readFile(path.join(repo, "shared.txt"), "utf8")).split("\n");
		mainLines[0] = "main evolved the same line";
		await fs.writeFile(path.join(repo, "shared.txt"), mainLines.join("\n"));
		await git(repo, "add", "-A");
		await git(repo, "commit", "-qm", "main advances, editing the same top line");
		const mainTip = await rev(repo, "HEAD");

		const ctx: AnalyzerContext = { repo, baseCommit: baseTip, mainCommit: mainTip, candidateCommit: candidateTip };
		const result = await topologyAnalyzer.run(ctx);
		const findings = findingsOfKind(result.findings, "topology.stale-fork-overlap");
		expect(findings).toHaveLength(1);
		expect(findings[0]!.statement).toContain("shared.txt");
	});

	test("stays silent when both sides edit disjoint files (non-overlapping parallel work)", async () => {
		const repo = await gitRepo("topo-stale-neg1-");
		await fs.writeFile(path.join(repo, "shared.txt"), `${LINES}\n`);
		await git(repo, "add", "-A");
		await git(repo, "commit", "-qm", "base");
		const baseTip = await rev(repo, "HEAD");

		await git(repo, "checkout", "-qb", "candidate");
		const candidateTip = await commit(repo, "candidate-only.txt", "candidate\n", "candidate touches its own file");

		await git(repo, "checkout", "-q", "main");
		await commit(repo, "main-only.txt", "main\n", "main touches its own file");
		const mainTip = await rev(repo, "HEAD");

		const ctx: AnalyzerContext = { repo, baseCommit: baseTip, mainCommit: mainTip, candidateCommit: candidateTip };
		const result = await topologyAnalyzer.run(ctx);
		expect(findingsOfKind(result.findings, "topology.stale-fork-overlap")).toHaveLength(0);
	});

	test("stays silent when the candidate forked from main's current tip (never stale)", async () => {
		const repo = await gitRepo("topo-stale-neg2-");
		await commit(repo, "root.txt", "root\n", "root");
		const mainTip = await rev(repo, "HEAD");
		await git(repo, "checkout", "-qb", "candidate");
		const candidateTip = await commit(repo, "candidate.txt", "candidate\n", "candidate work");

		const ctx: AnalyzerContext = { repo, baseCommit: mainTip, mainCommit: mainTip, candidateCommit: candidateTip };
		const result = await topologyAnalyzer.run(ctx);
		expect(findingsOfKind(result.findings, "topology.stale-fork-overlap")).toHaveLength(0);
	});
});

// ── runAnalyzers registry: crash isolation + deterministic sort ────────────────────────────────

describe("runAnalyzers", () => {
	test("a well-formed run through the registry yields the same findings as calling the analyzer directly", async () => {
		const repo = await gitRepo("topo-registry-");
		await commit(repo, "root.txt", "root\n", "root");
		const mainTip = await rev(repo, "HEAD");
		await git(repo, "checkout", "-qb", "feature");
		const candidateTip = await commit(repo, "f1.txt", "one\n", "feature commit");
		// never merged — should trip orphaned-merge

		const ctx: AnalyzerContext = { repo, baseCommit: mainTip, mainCommit: mainTip, candidateCommit: candidateTip };
		const direct = await topologyAnalyzer.run(ctx);
		const viaRegistry = await runAnalyzers([topologyAnalyzer], ctx);
		expect(viaRegistry.findings.map((f) => f.id).sort()).toEqual(direct.findings.map((f) => f.id).sort());
		expect(findingsOfKind(viaRegistry.findings, "topology.orphaned-merge")).toHaveLength(1);
	});

	test("an analyzer whose run() throws degrades to a coverage gap, never rejecting the whole call", async () => {
		const repo = await gitRepo("topo-crash-");
		await commit(repo, "root.txt", "root\n", "root");
		const brokenAnalyzer = {
			name: "broken",
			version: "0.0.0",
			claimedClasses: [] as const,
			applicable: () => true,
			run: async () => {
				throw new Error("boom");
			},
		};
		const ctx: AnalyzerContext = { repo, baseCommit: "HEAD", mainCommit: "HEAD", candidateCommit: "HEAD" };
		const result = await runAnalyzers([brokenAnalyzer, topologyAnalyzer], ctx);
		expect(result.coverage.some((c) => c.gaps.some((g) => g.reason.includes("broken analyzer's run() crashed") && g.reason.includes("boom")))).toBe(true);
		// topologyAnalyzer still ran and contributed its own coverage despite the sibling crash.
		expect(result.coverage.length).toBeGreaterThan(1);
	});

	test("an analyzer whose applicable() throws degrades to a coverage gap and is skipped", async () => {
		const repo = await gitRepo("topo-crash-applicable-");
		await commit(repo, "root.txt", "root\n", "root");
		const brokenAnalyzer = {
			name: "broken-applicable",
			version: "0.0.0",
			claimedClasses: [] as const,
			applicable: () => {
				throw new Error("applicable boom");
			},
			run: async () => ({ observations: [], findings: [], coverage: [] }),
		};
		const ctx: AnalyzerContext = { repo, baseCommit: "HEAD", mainCommit: "HEAD", candidateCommit: "HEAD" };
		const result = await runAnalyzers([brokenAnalyzer], ctx);
		expect(result.coverage.some((c) => c.gaps.some((g) => g.reason.includes("applicable() crashed") && g.reason.includes("applicable boom")))).toBe(true);
	});
});
