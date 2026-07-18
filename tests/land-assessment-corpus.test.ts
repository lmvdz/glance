/**
 * Concern 05 (replay-corpus) verification.
 *
 * `corpus.ts`: a scripted git history exercising all three reconstruction sources (a real `--no-ff`
 * merge, a squash-simulated PR merge, and a genuine `--ff-only` local land recorded in a fixture
 * done-proof ledger), plus the outcome-label joins over fixture land-failures/land-forced/
 * land-validator-override ledgers, plus the temporal-holdout split.
 *
 * `synthesize.ts`: determinism (same seed ⇒ byte-identical pairs) for all four mutation kinds, each
 * spot-checked end-to-end through the REAL `typescript-structural-delta` analyzer over a real fixture
 * git repo (not just string-shape assertions) to prove the mutation actually triggers the predicate its
 * class claims — plus the inapplicable-file gap path.
 *
 * `land-assessment-corpus.test.ts` lives in `tests/`, not co-located under `src/land-assessment/replay/`
 * (the concern doc's literal TOUCHES path) — matches every other land-assessment concern's own deviation
 * (topology/structural-delta/manifest/store/schema all moved to `tests/` too): `bunfig.toml`'s
 * `[test] root = "tests"` is what a bare `bun test` actually scans.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { LocalStorageBackend, setStorageBackend } from "../src/dal/storage.ts";
import { runAnalyzers } from "../src/land-assessment/analyzers/plugin.ts";
import { structuralDeltaAnalyzer } from "../src/land-assessment/analyzers/typescript-structural-delta.ts";
import { CLAIMED_BY } from "../src/land-assessment/replay/incident-taxonomy.ts";
import {
	buildReplayCorpus,
	reconstructFfLocalLandTriples,
	reconstructMergeCommitTriples,
	reconstructPrMergeTriples,
	splitCorpusAt,
	type MergedPrRow,
	type ReplayCorpus,
	type ReplayTriple,
} from "../src/land-assessment/replay/corpus.ts";
import {
	generateSyntheticCorpus,
	SYNTHETIC_MUTATION_CLASS,
	SYNTHETIC_MUTATION_KINDS,
	synthesizeMutation,
	type SyntheticMutationKind,
} from "../src/land-assessment/replay/synthesize.ts";

// ── git fixture builders (real git, no mocking — mirrors topology.test.ts/structural-delta.test.ts) ──

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
	setStorageBackend(new LocalStorageBackend());
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

async function writeJson(file: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify(value));
}

// ── corpus.ts: scripted three-source history ────────────────────────────────────────────────────────

describe("replay corpus: scripted history over all three sources", () => {
	test("recovers correct triples + joined outcome labels from a true merge, a squash-simulated PR, and a genuine FF local land", async () => {
		const repo = await gitRepo("corpus-scripted-");
		const stateDir = await tmpDir("corpus-state-");

		// ── setup: root ──
		const root = await commit(repo, "root.txt", "root\n", "root");

		// ── source 1: a TRUE merge (feature-a diverges from root, main also advances, real --no-ff merge) ──
		await git(repo, "checkout", "-qb", "feature-a");
		const featureATip = await commit(repo, "a.txt", "a\n", "feature-a work");
		await git(repo, "checkout", "-q", "main");
		const mainBeforeMerge = await commit(repo, "main1.txt", "main1\n", "main advances");
		await git(repo, "merge", "--no-ff", "-m", "Merge feature-a: test merge", "feature-a");
		const mergeCommitSha = await rev(repo, "HEAD");

		// ── source 2: a squash-simulated PR merge (feature-b branches from post-merge main, squashed back) ──
		const mainAfterMerge = await rev(repo, "main");
		await git(repo, "checkout", "-qb", "feature-b");
		const featureBTip = await commit(repo, "b.txt", "b\n", "feature-b work");
		await git(repo, "checkout", "-q", "main");
		await git(repo, "merge", "--squash", "feature-b");
		await git(repo, "commit", "-qm", "squash pr #42");
		const squashCommitSha = await rev(repo, "HEAD");

		// ── source 3: a genuine FF local land (feature-c, TWO commits, then --ff-only onto main) ──
		const mainAfterSquash = await rev(repo, "main");
		await git(repo, "checkout", "-qb", "feature-c");
		await commit(repo, "c1.txt", "c1\n", "feature-c work 1");
		const featureCTip = await commit(repo, "c2.txt", "c2\n", "feature-c work 2");
		await git(repo, "checkout", "-q", "main");
		const ff = await git(repo, "merge", "--ff-only", "feature-c");
		expect(ff.code).toBe(0);
		const mainTipFinal = await rev(repo, "main");
		expect(mainTipFinal).toBe(featureCTip); // sanity: genuinely fast-forwarded, no new commit

		// ── fixture ledgers ──
		await writeJson(path.join(stateDir, "done-proofs.json"), {
			byBranch: {
				"feature-a": { branch: "feature-a", repo: "repo-a", mode: "local", commit: featureATip, baseRef: "HEAD", verified: "red-baseline", detail: "d", provenAt: Date.now() },
				"feature-b": { branch: "feature-b", repo: "repo-b", mode: "pr", commit: featureBTip, mergeCommit: squashCommitSha, baseRef: "origin/main", verified: "green", detail: "d", provenAt: Date.now(), prNumber: 42 },
				"feature-c": { branch: "feature-c", repo: "repo-c", mode: "local", commit: featureCTip, baseRef: "HEAD", verified: "unverified", detail: "d", provenAt: 1_700_000_000_000 },
			},
			byIssue: {},
		});
		await writeJson(path.join(stateDir, "land-failures.json"), { "feature-a": { fails: 2, lastDetail: "x", at: Date.now() } });
		await writeJson(path.join(stateDir, "land-forced.json"), [{ branch: "feature-b", actor: "op", detail: "d", at: Date.now() }]);
		await writeJson(path.join(stateDir, "land-validator-override.json"), [{ branch: "feature-c", actor: "op", reasonClass: "emergency", detail: "d", at: Date.now() }]);

		// ── source 1: merge-commit ──
		const src1 = await reconstructMergeCommitTriples(repo, "main", stateDir);
		expect(src1.coverage.attempted).toBe(1);
		expect(src1.coverage.recovered).toBe(1);
		expect(src1.coverage.gaps).toEqual([]);
		const t1 = src1.triples[0]!;
		expect(t1.source).toBe("merge-commit");
		expect(t1.mainCommit).toBe(mainBeforeMerge);
		expect(t1.candidateCommit).toBe(featureATip);
		expect(t1.baseCommit).toBe(root);
		expect(t1.branch).toBe("feature-a");
		expect(t1.outcome).toEqual({ verified: "red-baseline", forced: false, validatorOverridden: false, failureStreakAtOutcome: 2 });

		// ── source 2: pr-merge ──
		const rows: MergedPrRow[] = [{ number: 42, headRefOid: featureBTip, baseRefOid: mainAfterMerge, mergeCommit: { oid: squashCommitSha }, mergedAt: "2020-01-01T00:00:00.000Z" }];
		const src2 = await reconstructPrMergeTriples(repo, rows, stateDir);
		expect(src2.coverage.attempted).toBe(1);
		expect(src2.coverage.recovered).toBe(1);
		expect(src2.coverage.gaps).toEqual([]);
		const t2 = src2.triples[0]!;
		expect(t2.source).toBe("pr-merge");
		expect(t2.mainCommit).toBe(mainAfterMerge);
		expect(t2.candidateCommit).toBe(featureBTip);
		expect(t2.baseCommit).toBe(mainAfterMerge); // no main-side divergence in this fixture: B == M
		expect(t2.prNumber).toBe(42);
		expect(t2.branch).toBe("feature-b"); // resolved via the done-proof commit join
		expect(t2.landedAt).toBe("2020-01-01T00:00:00.000Z");
		expect(t2.outcome).toEqual({ verified: "green", forced: true, validatorOverridden: false, failureStreakAtOutcome: 0 });

		// ── source 3: ff-local-land ──
		const src3 = await reconstructFfLocalLandTriples(repo, "main", stateDir);
		expect(src3.coverage.attempted).toBe(2); // feature-a + feature-c are mode:"local" baseRef:"HEAD" (feature-b is mode:"pr", never attempted here)
		expect(src3.coverage.recovered).toBe(1); // only feature-c was genuinely FF'd
		expect(src3.coverage.gaps).toHaveLength(1); // feature-a landed via --no-ff, excluded (recovered by merge-commit source instead)
		const t3 = src3.triples[0]!;
		expect(t3.source).toBe("ff-local-land");
		expect(t3.branch).toBe("feature-c");
		expect(t3.candidateCommit).toBe(featureCTip);
		expect(t3.baseCommit).toBe(mainAfterSquash); // B == M by the FF invariant, recovered via reflog
		expect(t3.mainCommit).toBe(mainAfterSquash);
		expect(t3.landedAt).toBe(new Date(1_700_000_000_000).toISOString());
		expect(t3.outcome).toEqual({ verified: "unverified", forced: false, validatorOverridden: true, failureStreakAtOutcome: 0 });
		// feature-a's gap explicitly says it's recovered elsewhere, not silently dropped.
		expect(src3.coverage.gaps.some((g) => g.branch === "feature-a" && g.reason.includes("merge-commit source"))).toBe(true);

		// ── aggregate ──
		const corpus = await buildReplayCorpus({ repo, mainRef: "main", stateDir, mergedPrRows: rows });
		expect(corpus.triples).toHaveLength(3);
		expect(corpus.coverage).toHaveLength(3);
		expect(new Set(corpus.triples.map((t) => t.source))).toEqual(new Set(["merge-commit", "pr-merge", "ff-local-land"]));

		// ── temporal holdout ──
		const split = splitCorpusAt(corpus, "2021-01-01T00:00:00.000Z");
		expect(split.training.map((t) => t.source)).toEqual(["pr-merge"]); // 2020 mergedAt
		expect(split.holdout.map((t) => t.source).sort()).toEqual(["ff-local-land", "merge-commit"].sort()); // both effectively "now"
		expect(split.unknownTime).toEqual([]);
	});

	test("pr-merge source degrades a not-locally-fetched SHA to a coverage gap, never fabricates", async () => {
		const repo = await gitRepo("corpus-pr-gap-");
		const stateDir = await tmpDir("corpus-state-gap-");
		await commit(repo, "root.txt", "root\n", "root");
		const notFetched = "0000000000000000000000000000000000dead";
		const rows: MergedPrRow[] = [{ number: 7, headRefOid: notFetched, mergeCommit: { oid: notFetched }, mergedAt: "2020-01-01T00:00:00.000Z" }];
		const { triples, coverage } = await reconstructPrMergeTriples(repo, rows, stateDir);
		expect(triples).toEqual([]);
		expect(coverage.attempted).toBe(1);
		expect(coverage.recovered).toBe(0);
		expect(coverage.gaps).toHaveLength(1);
		expect(coverage.gaps[0]!.reason).toContain("not present locally");
		expect(coverage.gaps[0]!.prNumber).toBe(7);
	});

	test("pr-merge source gaps a row with no mergeCommit oid — never guesses the main tip", async () => {
		const repo = await gitRepo("corpus-pr-no-merge-commit-");
		const stateDir = await tmpDir("corpus-state-nmc-");
		const root = await commit(repo, "root.txt", "root\n", "root");
		const rows: MergedPrRow[] = [{ number: 9, headRefOid: root, mergeCommit: null, mergedAt: "2020-01-01T00:00:00.000Z" }];
		const { triples, coverage } = await reconstructPrMergeTriples(repo, rows, stateDir);
		expect(triples).toEqual([]);
		expect(coverage.gaps[0]!.reason).toContain("no mergeCommit oid");
	});

	test("ff-local-land source gaps when the ledger has entries but the reflog has no matching transition", async () => {
		const repo = await gitRepo("corpus-ff-no-reflog-");
		const stateDir = await tmpDir("corpus-state-nr-");
		const root = await commit(repo, "root.txt", "root\n", "root");
		// A commit that IS on main's first-parent history (it's the only commit) but was never a
		// distinct ref TRANSITION captured by the reflog under a DIFFERENT prior value — the very first
		// commit has no "before" entry to recover, so this must gap, not claim B==M=="" or similar.
		await writeJson(path.join(stateDir, "done-proofs.json"), {
			byBranch: { root: { branch: "root", repo: "r", mode: "local", commit: root, baseRef: "HEAD", verified: "green", detail: "d", provenAt: Date.now() } },
			byIssue: {},
		});
		const { triples, coverage } = await reconstructFfLocalLandTriples(repo, "main", stateDir);
		expect(triples).toEqual([]);
		expect(coverage.attempted).toBe(1);
		expect(coverage.recovered).toBe(0);
		expect(coverage.gaps).toHaveLength(1);
	});

	test("splitCorpusAt buckets a triple with no landedAt into unknownTime, never silently into training/holdout", () => {
		const triple: ReplayTriple = {
			id: "x",
			source: "merge-commit",
			repo: "/r",
			baseCommit: "b",
			mainCommit: "m",
			candidateCommit: "c",
			outcome: { verified: "unknown", forced: false, validatorOverridden: false, failureStreakAtOutcome: 0 },
		};
		const corpus: ReplayCorpus = { repositoryId: "/r", triples: [triple], coverage: [], generatedAt: new Date().toISOString() };
		const split = splitCorpusAt(corpus, "2021-01-01T00:00:00.000Z");
		expect(split.training).toEqual([]);
		expect(split.holdout).toEqual([]);
		expect(split.unknownTime).toEqual([triple]);
	});
});

// ── synthesize.ts: determinism + real analyzer round-trip ──────────────────────────────────────────

const FIXTURE_SOURCE = `import { helper } from "./helper.ts";

export function withParam(x: number, y: string) {
	return helper(x, y);
}

export function noParam() {
	return 1;
}

export class Base {}

export class Derived extends Base {}

export interface Shape {
	area(): number;
}
`;

describe("synthesize: determinism", () => {
	for (const kind of SYNTHETIC_MUTATION_KINDS) {
		test(`${kind}: same (sourcePath, sourceContent, seed) regenerates a byte-identical pair`, () => {
			const input = { sourcePath: "fixture.ts", sourceContent: FIXTURE_SOURCE, kind, seed: 3 };
			const r1 = synthesizeMutation(input);
			const r2 = synthesizeMutation(input);
			expect(r1.ok).toBe(true);
			expect(r2.ok).toBe(true);
			if (r1.ok && r2.ok) {
				expect(r1.pair).toEqual(r2.pair);
				expect(r1.pair.candidateContent).toBe(r2.pair.candidateContent);
			}
		});
	}

	test("SYNTHETIC_MUTATION_CLASS only uses classes typescript-structural-delta actually claims", () => {
		const claimed = new Set(CLAIMED_BY["typescript-structural-delta"]);
		for (const kind of SYNTHETIC_MUTATION_KINDS) {
			expect(claimed.has(SYNTHETIC_MUTATION_CLASS[kind])).toBe(true);
		}
	});

	test("different seeds may select different candidates when more than one exists", () => {
		const src = `export function fnA(a: number) { return a; }\nexport function fnB(b: number) { return b; }\n`;
		const r0 = synthesizeMutation({ sourcePath: "f.ts", sourceContent: src, kind: "signature-change", seed: 0 });
		const r1 = synthesizeMutation({ sourcePath: "f.ts", sourceContent: src, kind: "signature-change", seed: 1 });
		expect(r0.ok && r1.ok).toBe(true);
		if (r0.ok && r1.ok) expect(r0.pair.mutationDetail).not.toBe(r1.pair.mutationDetail);
	});

	test("signature-change handles a zero-parameter exported function", () => {
		const r = synthesizeMutation({ sourcePath: "f.ts", sourceContent: `export function noParam() {\n  return 1;\n}\n`, kind: "signature-change", seed: 0 });
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.pair.candidateContent).toContain("function noParam(__synthParam?: string)");
	});

	test("inapplicable mutations report a reason, never a fabricated no-op pair", () => {
		const noFns = `export const x = 1;\n`;
		const r = synthesizeMutation({ sourcePath: "f.ts", sourceContent: noFns, kind: "signature-change", seed: 0 });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("inapplicable");

		const noClasses = `export function f() { return 1; }\n`;
		const r2 = synthesizeMutation({ sourcePath: "f.ts", sourceContent: noClasses, kind: "inheritance-change", seed: 0 });
		expect(r2.ok).toBe(false);

		const noExports = `const x = 1;\n`;
		const r3 = synthesizeMutation({ sourcePath: "f.ts", sourceContent: noExports, kind: "export-removal", seed: 0 });
		expect(r3.ok).toBe(false);
	});

	test("a syntax error is reported as a parse-error, never silently mutated", () => {
		const r = synthesizeMutation({ sourcePath: "f.ts", sourceContent: `export function foo( {{{ ***garbage***`, kind: "adjacent-dependency-edit", seed: 0 });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("parse-error");
	});

	test("adjacent-dependency-edit is always applicable, even on an empty file", () => {
		const r = synthesizeMutation({ sourcePath: "f.ts", sourceContent: "", kind: "adjacent-dependency-edit", seed: 0 });
		expect(r.ok).toBe(true);
	});

	test("generateSyntheticCorpus reports per-kind coverage with gaps, never silently drops an inapplicable combination", () => {
		const files = [{ sourcePath: "a.ts", sourceContent: `export const onlyAConst = 1;\n` }];
		const { pairs, coverage } = generateSyntheticCorpus(files);
		expect(pairs.length).toBeLessThan(SYNTHETIC_MUTATION_KINDS.length); // signature-change + inheritance-change are inapplicable
		const byKind = new Map(coverage.map((c) => [c.kind, c]));
		expect(byKind.get("signature-change")!.gaps).toHaveLength(1);
		expect(byKind.get("inheritance-change")!.gaps).toHaveLength(1);
		expect(byKind.get("export-removal")!.recovered).toBe(1);
		expect(byKind.get("adjacent-dependency-edit")!.recovered).toBe(1);
	});
});

describe("synthesize: real analyzer round-trip (each mutation triggers the predicate its class claims)", () => {
	async function runOverPair(kind: SyntheticMutationKind, seed: number, source = FIXTURE_SOURCE) {
		const result = synthesizeMutation({ sourcePath: "fixture.ts", sourceContent: source, kind, seed });
		if (!result.ok) throw new Error(`fixture setup failed: ${result.reason}`);
		const repo = await gitRepo(`synth-${kind}-`);
		await fs.writeFile(path.join(repo, "fixture.ts"), result.pair.baseContent);
		await git(repo, "add", "-A");
		await git(repo, "commit", "-qm", "base");
		const base = await rev(repo, "HEAD");
		await fs.writeFile(path.join(repo, "fixture.ts"), result.pair.candidateContent);
		await git(repo, "add", "-A");
		await git(repo, "commit", "-qm", "candidate");
		const candidate = await rev(repo, "HEAD");
		const applicable = await structuralDeltaAnalyzer.applicable({ repo, baseCommit: base, mainCommit: base, candidateCommit: candidate });
		expect(applicable).toBe(true);
		const analysis = await runAnalyzers([structuralDeltaAnalyzer], { repo, baseCommit: base, mainCommit: base, candidateCommit: candidate });
		return { pair: result.pair, analysis };
	}

	test("signature-change ⇒ SIGNATURE_CHANGED", async () => {
		const { analysis } = await runOverPair("signature-change", 0);
		const hit = analysis.observations.find((o) => o.predicate === "SIGNATURE_CHANGED");
		expect(hit).toBeDefined();
	});

	test("export-removal ⇒ EXPORTS_REMOVED", async () => {
		const { analysis } = await runOverPair("export-removal", 0);
		const hit = analysis.observations.find((o) => o.predicate === "EXPORTS_REMOVED");
		expect(hit).toBeDefined();
	});

	test("inheritance-change ⇒ EXTENDS_CHANGED", async () => {
		const { analysis } = await runOverPair("inheritance-change", 0);
		const hit = analysis.observations.find((o) => o.predicate === "EXTENDS_CHANGED");
		expect(hit).toBeDefined();
	});

	test("adjacent-dependency-edit ⇒ IMPORTS_ADDED", async () => {
		const { analysis } = await runOverPair("adjacent-dependency-edit", 0);
		const hit = analysis.observations.find((o) => o.predicate === "IMPORTS_ADDED");
		expect(hit).toBeDefined();
	});
});
