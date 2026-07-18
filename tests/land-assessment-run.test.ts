/**
 * Concern 06 (replay-cli-and-report) verification: `store-reader.ts`'s strict-with-accounting read and
 * attempt reconstruction; `run.ts`'s manifest scoring (real recall, unclaimed-class exclusion, missing
 * -ref resolution), synthetic scoring, and corpus scoring; `report.ts`'s metric computation and
 * Markdown/JSON rendering; `cli.ts`'s `replay`/`inspect` subcommands including the malformed-store-line
 * -> INCOMPLETE -> non-zero-exit path.
 *
 * Lives in `tests/`, not co-located under `src/land-assessment/replay/` (the concern doc's literal
 * TOUCHES path) -- matches every other land-assessment concern's own deviation (`bunfig.toml`'s
 * `[test] root = "tests"`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { git } from "../src/land-assessment/analyzers/plugin.ts";
import { LocalStorageBackend, setStorageBackend } from "../src/dal/storage.ts";
import { computeRepositoryId } from "../src/land-assessment/id.ts";
import type { IncidentManifest, ManifestEntry } from "../src/land-assessment/replay/incident-taxonomy.ts";
import type { ReplayCorpus, ReplayTriple } from "../src/land-assessment/replay/corpus.ts";
import { computeMetrics, renderMarkdown, toJson } from "../src/land-assessment/replay/report.ts";
import { cmdInspect, cmdReplay, runLandAssessmentCli } from "../src/land-assessment/cli.ts";
import { reconstructRepositoryStore, readRepositoryStore } from "../src/land-assessment/store-reader.ts";
import { appendLandAttemptEvent, repoHash16 } from "../src/land-assessment/store.ts";
import { SCHEMA_VERSION, type LandAttemptEvent } from "../src/land-assessment/schema.ts";
import { resolveManifestEntryContext, runReplay } from "../src/land-assessment/replay/run.ts";

// ── git fixture builders (real git, no mocking -- mirrors topology.test.ts/structural-delta.test.ts) ──

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
	setStorageBackend(new LocalStorageBackend());
});
beforeEach(() => {
	setStorageBackend(new LocalStorageBackend());
});

async function tmpDir(prefix: string): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(d);
	return d;
}

async function gitRepo(prefix: string): Promise<string> {
	const repo = await tmpDir(prefix);
	await git(["init", "-q", "-b", "main"], repo);
	await git(["config", "user.email", "t@t"], repo);
	await git(["config", "user.name", "t"], repo);
	await git(["config", "commit.gpgsign", "false"], repo);
	return repo;
}

async function commit(repo: string, file: string, content: string, message: string): Promise<string> {
	await fs.writeFile(path.join(repo, file), content);
	await git(["add", "-A"], repo);
	await git(["commit", "-q", "-m", message], repo);
	return (await git(["rev-parse", "HEAD"], repo)).stdout;
}

function emptyManifest(overrides: Partial<IncidentManifest> = {}): IncidentManifest {
	return {
		manifestVersion: 0,
		generatedAt: "2026-07-17T00:00:00.000Z",
		positiveCounts: { "git-topology": 0, "textual-conflict": 0, "structural-api": 0, dependency: 0, behavioral: 0, "acceptance-criterion": 0, "proof-freshness": 0, "workflow-state": 0, operational: 0 },
		benchmarkParameters: { negativeSampleTarget: 40, negativeSampleCollected: 2, reviewBudgetK: 5, reviewBudgetPerLands: 100, rationale: "test fixture" },
		entries: [],
		unpinnable: [],
		...overrides,
	};
}

function manifestEntry(overrides: Partial<ManifestEntry> & Pick<ManifestEntry, "id" | "taxonomyClasses" | "refs" | "expectedOutcome">): ManifestEntry {
	return { repo: "fixture-repo", narrative: "fixture entry", source: "manual", ...overrides };
}

// ── resolveManifestEntryContext ─────────────────────────────────────────────────────────────────────

describe("resolveManifestEntryContext", () => {
	test("gaps when the entry has no candidateCommit", () => {
		const entry = manifestEntry({ id: "e1", taxonomyClasses: ["git-topology"], refs: { baseCommit: "b" }, expectedOutcome: "should-detect" });
		const r = resolveManifestEntryContext("/repo", "m0", entry);
		expect(r.ok).toBe(false);
	});

	test("missing mainCommit falls back to the caller's resolved current main", () => {
		const entry = manifestEntry({ id: "e2", taxonomyClasses: ["git-topology"], refs: { baseCommit: "b", candidateCommit: "c" }, expectedOutcome: "should-detect" });
		const r = resolveManifestEntryContext("/repo", "current-main", entry);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.context.mainCommit).toBe("current-main");
	});

	test("missing baseCommit defaults to the resolved mainCommit (a no-op default)", () => {
		const entry = manifestEntry({ id: "e3", taxonomyClasses: ["git-topology"], refs: { mainCommit: "m", candidateCommit: "c" }, expectedOutcome: "should-detect" });
		const r = resolveManifestEntryContext("/repo", "current-main", entry);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.context.baseCommit).toBe("m");
			expect(r.context.mainCommit).toBe("m");
		}
	});

	test("should-block-eventually uses detectionAtMainCommit regardless of refs.mainCommit", () => {
		const entry = manifestEntry({
			id: "e4",
			taxonomyClasses: ["git-topology"],
			refs: { baseCommit: "b", mainCommit: "original-main", candidateCommit: "c" },
			expectedOutcome: "should-block-eventually",
			detectionAtMainCommit: "later-main",
		});
		const r = resolveManifestEntryContext("/repo", "current-main", entry);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.context.mainCommit).toBe("later-main");
	});
});

// ── end-to-end manifest scoring over a real fixture repo ───────────────────────────────────────────

describe("runReplay: manifest scoring", () => {
	test("should-detect stacked-base incident fires topology; a should-not-flag entry stays silent; an unclaimed-class entry is never scored", async () => {
		const repo = await gitRepo("run-manifest-");
		const root = await commit(repo, "root.txt", "root\n", "root");
		await git(["checkout", "-qb", "sibling-base"], repo);
		await commit(repo, "sibling.txt", "sibling\n", "sibling work");
		await git(["checkout", "-qb", "candidate"], repo);
		const candidateTip = await commit(repo, "candidate.txt", "candidate\n", "candidate work");
		await git(["checkout", "-q", "main"], repo);
		const mainTip = await commit(repo, "main-only.txt", "main advances\n", "main advances");
		void root;

		// The should-not-flag exemplar. topology's four detections have no single triple that is
		// SIMULTANEOUSLY "candidate still unmerged" (stacked-base's own negative shape) and "candidate
		// already landed" (orphaned-merge's own negative shape, per topology.test.ts's own fixtures) --
		// discovered empirically while writing this test, and confirmed against the REAL incident
		// manifest's own pr36/pr41 clean-relanding entries (`git rev-list <candidate> --not <declared
		// main>` on the real historical shas is non-empty for both). The one triple genuinely silent on
		// ALL four detections is `candidate === base` (nothing new to land, an ancestor of a
		// LATER-advanced main) -- degenerate, but a real, mathematically clean negative rather than an
		// overfit assertion about a specific detection's behavior.
		const laterMain = await commit(repo, "later.txt", "later\n", "main advances again");

		const manifest = emptyManifest({
			entries: [
				manifestEntry({
					id: "positive-stacked-base",
					taxonomyClasses: ["git-topology", "workflow-state"],
					refs: { baseCommit: "sibling-base", mainCommit: mainTip, candidateCommit: candidateTip },
					expectedOutcome: "should-detect",
				}),
				manifestEntry({
					id: "negative-clean-relanding",
					taxonomyClasses: ["git-topology"],
					refs: { baseCommit: mainTip, mainCommit: laterMain, candidateCommit: mainTip },
					expectedOutcome: "should-not-flag",
				}),
				manifestEntry({
					id: "unclaimed-only",
					taxonomyClasses: ["textual-conflict"],
					refs: { baseCommit: mainTip, mainCommit: mainTip, candidateCommit: candidateTip },
					expectedOutcome: "should-detect",
				}),
			],
		});

		const stateDir = await tmpDir("run-manifest-state-");
		const run = await runReplay({ repo, stateDir, manifest, mainCommitForUnpinnedEntries: mainTip });

		expect(run.incomplete).toBe(false);

		const positiveRow = run.incidentRows.find((r) => r.entryId === "positive-stacked-base")!;
		expect(positiveRow.perAnalyzer).toHaveLength(1);
		expect(positiveRow.perAnalyzer[0]!.analyzer).toBe("topology");
		expect(positiveRow.perAnalyzer[0]!.fired).toBe(true);
		expect(positiveRow.unclaimedClasses).toEqual([]);

		const negativeRow = run.incidentRows.find((r) => r.entryId === "negative-clean-relanding")!;
		expect(negativeRow.perAnalyzer[0]!.fired).toBe(false);

		const unclaimedRow = run.incidentRows.find((r) => r.entryId === "unclaimed-only")!;
		expect(unclaimedRow.perAnalyzer).toHaveLength(0); // no analyzer ever run for this entry
		expect(unclaimedRow.unclaimedClasses).toEqual(["textual-conflict"]);

		// The unclaimed entry contributes ZERO class-recall samples anywhere -- never counted as a miss.
		expect(run.classRecallSamples.some((s) => s.entryId === "unclaimed-only")).toBe(false);

		const metrics = computeMetrics(run, manifest);
		const gitTopology = metrics.classRecall.find((c) => c.taxonomyClass === "git-topology")!;
		expect(gitTopology.n).toBe(1); // only the should-detect entry counts; should-not-flag is a negative
		expect(gitTopology.hits).toBe(1);
		expect(gitTopology.recall).toBe(1);

		const negatives = metrics.negatives.find((n) => n.taxonomyClass === "git-topology" && n.analyzer === "topology")!;
		expect(negatives.n).toBe(1);
		expect(negatives.falsePositives).toBe(0);

		expect(metrics.unclaimedClassesPresent).toEqual(["textual-conflict"]);

		// A class with zero real positives reports recall as null, never a misleading 0.
		const structuralApi = metrics.classRecall.find((c) => c.taxonomyClass === "structural-api")!;
		expect(structuralApi.n).toBe(0);
		expect(structuralApi.recall).toBeNull();

		const md = renderMarkdown(metrics);
		expect(md).toContain("git-topology");
		expect(md).toContain("Land Assessment replay report");
		const json = JSON.parse(toJson(metrics));
		expect(json.repositoryId).toBe(computeRepositoryId(repo));
	});
});

// ── synthetic scoring ────────────────────────────────────────────────────────────────────────────────

describe("runReplay: synthetic scoring", () => {
	test("a synthetic export-removal pair over a real exported function fires structural-delta and is labeled with the circular-generation caveat", async () => {
		const repo = await tmpDir("run-synth-repo-"); // synthetic pairs never touch this repo's git history
		const manifest = emptyManifest();
		const stateDir = await tmpDir("run-synth-state-");
		const source = `export function alpha(x: number): number {\n  return x + 1;\n}\n`;

		const run = await runReplay({
			repo,
			stateDir,
			manifest,
			mainCommitForUnpinnedEntries: "unused",
			syntheticFiles: [{ sourcePath: "alpha.ts", sourceContent: source }],
		});

		expect(run.syntheticSamples.length).toBeGreaterThan(0);
		expect(run.syntheticSamples.every((s) => s.taxonomyClass === "structural-api" || s.taxonomyClass === "dependency")).toBe(true);
		expect(run.syntheticSamples.some((s) => s.fired)).toBe(true);

		const metrics = computeMetrics(run, manifest);
		const structuralApi = metrics.syntheticRecall.find((c) => c.taxonomyClass === "structural-api");
		expect(structuralApi).toBeDefined();
		expect(structuralApi!.n).toBeGreaterThan(0);
		expect(structuralApi!.caveat).toBe("synthetic (circular-generation caveat)");

		const md = renderMarkdown(metrics);
		expect(md).toContain("synthetic (circular-generation caveat)");
	});
});

// ── corpus scoring ───────────────────────────────────────────────────────────────────────────────────

describe("runReplay: corpus scoring", () => {
	test("real-corpus triples feed runtime/coverage/precision-at-budget stats, never manifest recall", async () => {
		const repo = await gitRepo("run-corpus-");
		await commit(repo, "root.txt", "root\n", "root");
		const mainTip = await commit(repo, "a.txt", "a\n", "advance a");
		await git(["checkout", "-qb", "feature"], repo);
		const candidateTip = await commit(repo, "b.txt", "b\n", "feature work");
		await git(["checkout", "-q", "main"], repo);

		const triple: ReplayTriple = {
			id: "triple-1",
			source: "merge-commit",
			repo: computeRepositoryId(repo),
			baseCommit: mainTip,
			mainCommit: mainTip,
			candidateCommit: candidateTip,
			outcome: { verified: "unknown", forced: false, validatorOverridden: false, failureStreakAtOutcome: 0 },
		};
		const corpus: ReplayCorpus = { repositoryId: computeRepositoryId(repo), triples: [triple], coverage: [], generatedAt: "2026-07-17T00:00:00.000Z" };

		const manifest = emptyManifest();
		const stateDir = await tmpDir("run-corpus-state-");
		const run = await runReplay({ repo, stateDir, manifest, mainCommitForUnpinnedEntries: mainTip, corpus });

		expect(run.corpusSamples).toHaveLength(1);
		expect(run.corpusSamples[0]!.tripleId).toBe("triple-1");

		const metrics = computeMetrics(run, manifest);
		expect(metrics.precisionAtBudget).not.toBeNull();
		expect(metrics.precisionAtBudget!.landsSampled).toBe(1);
		expect(metrics.runtimes.some((r) => r.analyzer === "topology")).toBe(true);
	});

	test("no corpus supplied -> precisionAtBudget is null, never a fabricated zero", async () => {
		const repo = await gitRepo("run-nocorpus-");
		await commit(repo, "root.txt", "root\n", "root");
		const manifest = emptyManifest();
		const stateDir = await tmpDir("run-nocorpus-state-");
		const run = await runReplay({ repo, stateDir, manifest, mainCommitForUnpinnedEntries: "HEAD" });
		const metrics = computeMetrics(run, manifest);
		expect(metrics.precisionAtBudget).toBeNull();
	});
});

// ── store-reader: strict-with-accounting + attempt reconstruction ──────────────────────────────────

describe("store-reader.ts", () => {
	function baseEvent(overrides: Partial<LandAttemptEvent> = {}): LandAttemptEvent {
		return {
			schemaVersion: SCHEMA_VERSION,
			eventId: "event-1",
			attemptId: "attempt-1",
			repositoryId: "repo-a",
			seq: 0,
			stage: "attempt-started",
			refs: {},
			criteria: { declaredCriterionRefs: [], impactStatus: "not-evaluated" },
			observedAt: "2026-07-17T00:00:00.000Z",
			evidence: [],
			...overrides,
		};
	}

	test("reconstructRepositoryStore folds events by attemptId and classifies a terminal-less attempt as incomplete", async () => {
		const stateDir = await tmpDir("store-reader-attempt-");
		await appendLandAttemptEvent(stateDir, baseEvent({ eventId: "e0", attemptId: "a-open", seq: 0, stage: "attempt-started" }));
		await appendLandAttemptEvent(stateDir, baseEvent({ eventId: "e1", attemptId: "a-closed", seq: 0, stage: "attempt-started" }));
		await appendLandAttemptEvent(stateDir, baseEvent({ eventId: "e2", attemptId: "a-closed", seq: 1, stage: "landed", resultCommit: "r1", resultTree: "t1" }));

		const reconstructed = await reconstructRepositoryStore(stateDir, "repo-a");
		expect(reconstructed.malformed).toHaveLength(0);
		const open = reconstructed.attempts.find((a) => a.attemptId === "a-open")!;
		expect(open.terminal).toBe("incomplete");
		const closed = reconstructed.attempts.find((a) => a.attemptId === "a-closed")!;
		expect(closed.terminal).toBe("landed");
		expect(closed.events).toHaveLength(2);
	});

	test("a malformed line is counted, not silently skipped, and does not derail the surrounding valid lines", async () => {
		const stateDir = await tmpDir("store-reader-malformed-");
		await appendLandAttemptEvent(stateDir, baseEvent({ eventId: "e0" }));
		const shardFile = path.join(stateDir, "land-assessment", repoHash16("repo-a"), "events-2026-07.jsonl");
		await fs.appendFile(shardFile, "deadbeef:{not valid json\n");
		await appendLandAttemptEvent(stateDir, baseEvent({ eventId: "e1" }));

		const { records, malformed } = await readRepositoryStore(stateDir, "repo-a");
		expect(records).toHaveLength(2);
		expect(malformed).toHaveLength(1);
		expect(malformed[0]!.file).toBe(shardFile);
	});
});

// ── cli.ts: replay + inspect, including the INCOMPLETE -> non-zero-exit path ───────────────────────

describe("cli.ts", () => {
	test("cmdReplayForTests returns a non-zero code when the store has a malformed line, zero otherwise", async () => {
		const repo = await gitRepo("cli-replay-");
		await commit(repo, "root.txt", "root\n", "root");
		const stateDir = await tmpDir("cli-replay-state-");

		const clean = await cmdReplay(["--repo", repo, "--state-dir", stateDir, "--main-ref", "main", "--skip-corpus", "--skip-synthetic", "--json"]);
		expect(clean.code).toBe(0);
		const cleanReport = JSON.parse(clean.stdout);
		expect(cleanReport.incomplete).toBe(false);

		const resolvedRepo = computeRepositoryId(repo);
		const shardFile = path.join(stateDir, "land-assessment", repoHash16(resolvedRepo), "events-2026-07.jsonl");
		await fs.mkdir(path.dirname(shardFile), { recursive: true });
		await fs.appendFile(shardFile, "deadbeef:{not valid json\n");

		const dirty = await cmdReplay(["--repo", repo, "--state-dir", stateDir, "--main-ref", "main", "--skip-corpus", "--skip-synthetic", "--json"]);
		expect(dirty.code).toBe(1);
		const dirtyReport = JSON.parse(dirty.stdout);
		expect(dirtyReport.incomplete).toBe(true);
		expect(dirtyReport.store.malformedCount).toBe(1);
	});

	test("cmdReplayForTests defaults to Markdown when --json is not passed", async () => {
		const repo = await gitRepo("cli-replay-md-");
		await commit(repo, "root.txt", "root\n", "root");
		const stateDir = await tmpDir("cli-replay-md-state-");
		const { code, stdout } = await cmdReplay(["--repo", repo, "--state-dir", stateDir, "--main-ref", "main", "--skip-corpus", "--skip-synthetic"]);
		expect(code).toBe(0);
		expect(stdout).toContain("Land Assessment replay report");
	});

	test("cmdInspect: not-found returns non-zero; a real attempt round-trips", async () => {
		const repo = await gitRepo("cli-inspect-");
		await commit(repo, "root.txt", "root\n", "root");
		const stateDir = await tmpDir("cli-inspect-state-");
		const resolvedRepo = computeRepositoryId(repo);

		const missing = await cmdInspect(["nope", "--repo", repo, "--state-dir", stateDir]);
		expect(missing.code).toBe(1);

		await appendLandAttemptEvent(stateDir, {
			schemaVersion: SCHEMA_VERSION,
			eventId: "ev-1",
			attemptId: "attempt-xyz",
			repositoryId: resolvedRepo,
			seq: 0,
			stage: "attempt-started",
			refs: {},
			criteria: { declaredCriterionRefs: [], impactStatus: "not-evaluated" },
			observedAt: "2026-07-17T00:00:00.000Z",
			evidence: [],
		});
		const found = await cmdInspect(["attempt-xyz", "--repo", repo, "--state-dir", stateDir]);
		expect(found.code).toBe(0);
		expect(JSON.parse(found.stdout).attemptId).toBe("attempt-xyz");
	});

	test("runLandAssessmentCli with no subcommand prints help and does not throw", async () => {
		await runLandAssessmentCli([]);
	});
});
