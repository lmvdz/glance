/**
 * Offline replay driver (concern 06, `plans/land-assessment/06-replay-cli-and-report.md`) — the
 * "runs the analyzers over the corpus, scores against the manifest" half of `glance land-assessment
 * replay`. Every analyzer call here goes DIRECTLY through `AssessmentAnalyzer.applicable`/`.run`
 * (`plugin.ts`), never through the Phase-2 land hook (concern 08 doesn't exist yet on this branch, and
 * even once it does, replay must stay reproducible without a live daemon).
 *
 * Three independent evaluation passes, each optional except the first:
 *
 *   manifest scoring   the labeled-incident go/no-go evidence (ADR.md's Phase-1 gate). Each
 *                       `incident-manifest.json` entry pins a (base, main, candidate) triple directly —
 *                       NOT via `replay/corpus.ts`'s reconstruction, since these are hand-curated,
 *                       independently-verified historical incidents, not derived from live ledgers.
 *                       Scored per SCHEMA-V0.md's "unclaimed class never counts against any analyzer"
 *                       rule: an entry's taxonomy classes are grouped by `claimedByAnalyzer`, and ONLY
 *                       the claiming analyzer is run and judged for each group — a class with no v0
 *                       claimant is reported (`unclaimedClasses`) but never scored as a miss.
 *   synthetic scoring   `replay/synthesize.ts`'s class-tagged mutation pairs, materialized as real git
 *                       commits (structural-delta reads via `git show`, never raw strings — see
 *                       `materializeSyntheticPair` below) and run through `structuralDeltaAnalyzer` only.
 *                       This is the ONLY source of recall evidence for `structural-api`/`dependency`
 *                       (the manifest's real positive count for both is 0 — DESIGN.md's Risks section
 *                       names this as an expected, honest finding, not a failure) — `report.ts` is
 *                       responsible for labeling it with the circular-generation caveat, never presenting
 *                       it as real recall.
 *   corpus scoring      `replay/corpus.ts`'s reconstructed real land history (when supplied — this
 *                       module never calls `buildReplayCorpus` itself, the CLI wires that), run through
 *                       every analyzer for the BROADER stats the manifest's 11 incidents are too small a
 *                       sample for: runtime distribution, coverage, observation-predicate counts,
 *                       evidence inspectability, and the precision@budget alert rate.
 *
 * The store-reader pass (`store-reader.ts`) is orthogonal to all three: it enforces SCHEMA-V0.md's
 * strict-with-accounting discipline over whatever the live event store ALREADY holds for this repo (near
 * -empty until concern 08 ships) — its only contribution to this module is the `incomplete` flag a
 * malformed line trips.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { errText } from "../../err-text.ts";
import { git, type AnalysisResult, type AnalyzerContext, type AssessmentAnalyzer } from "../analyzers/plugin.ts";
import { topologyAnalyzer } from "../analyzers/topology.ts";
import { structuralDeltaAnalyzer } from "../analyzers/typescript-structural-delta.ts";
import { computeRepositoryId } from "../id.ts";
import type { AssessmentFinding, ExtractionCoverage, SnapshotFact } from "../schema.ts";
import { reconstructRepositoryStore, type MalformedLine } from "../store-reader.ts";
import type { ReplayCorpus, ReplaySource, ReplayTriple } from "./corpus.ts";
import { claimedByAnalyzer, type ExpectedOutcome, type IncidentManifest, type IncidentRefs, type ManifestEntry, type TaxonomyClass, type UnpinnableEntry, type V0AnalyzerName } from "./incident-taxonomy.ts";
import { generateSyntheticCorpus, type SyntheticCorpusFile, type SyntheticMutationKind, type SyntheticPair } from "./synthesize.ts";

// ── Analyzer registry ────────────────────────────────────────────────────────────────────────────────

export type AnalyzerRegistry = Readonly<Record<V0AnalyzerName, AssessmentAnalyzer>>;

/** The two v0 analyzers, exactly as `incident-taxonomy.ts#V0_ANALYZERS` names them.
 *  @substrate Only `runReplay` (same file, its own default when `opts.analyzers` is omitted) calls
 *  this today -- exported so a future caller (e.g. concern 08's hook) can request the exact same
 *  default registry without re-deriving it. */
export function defaultAnalyzerRegistry(): AnalyzerRegistry {
	return { topology: topologyAnalyzer, "typescript-structural-delta": structuralDeltaAnalyzer };
}

function crashGap(analyzerName: string, phase: "applicable" | "run", err: unknown): ExtractionCoverage {
	return { dimension: "syntax", covered: 0, total: 1, gaps: [{ reason: `${analyzerName} analyzer's ${phase}() crashed during replay: ${errText(err)}` }] };
}

/** One analyzer's isolated run against one context — a thrown `applicable()`/`run()` degrades to a
 *  coverage gap (mirrors `plugin.ts#runAnalyzers`'s crash isolation, applied per-analyzer here since the
 *  caller needs each analyzer's own findings/runtime kept SEPARATE, not merged, for per-class scoring). */
async function runOneAnalyzer(name: V0AnalyzerName, analyzer: AssessmentAnalyzer, ctx: AnalyzerContext): Promise<{ applicable: boolean; result: AnalysisResult; runtimeMs: number }> {
	const start = performance.now();
	let applicable: boolean;
	try {
		applicable = await analyzer.applicable(ctx);
	} catch (err) {
		return { applicable: false, result: { observations: [], findings: [], coverage: [crashGap(name, "applicable", err)] }, runtimeMs: performance.now() - start };
	}
	if (!applicable) return { applicable: false, result: { observations: [], findings: [], coverage: [] }, runtimeMs: performance.now() - start };
	try {
		const result = await analyzer.run(ctx);
		return { applicable: true, result, runtimeMs: performance.now() - start };
	} catch (err) {
		return { applicable: true, result: { observations: [], findings: [], coverage: [crashGap(name, "run", err)] }, runtimeMs: performance.now() - start };
	}
}

// ── Manifest scoring ─────────────────────────────────────────────────────────────────────────────────

export interface PerAnalyzerIncidentResult {
	analyzer: V0AnalyzerName;
	/** The subset of this entry's `taxonomyClasses` this analyzer is being judged against (its
	 *  `claimedClasses` intersected with the entry's own). */
	claimedClasses: TaxonomyClass[];
	applicable: boolean;
	fired: boolean;
	findings: AssessmentFinding[];
	observations: SnapshotFact[];
	coverage: ExtractionCoverage[];
	runtimeMs: number;
}

export interface IncidentReplayRow {
	entryId: string;
	taxonomyClasses: TaxonomyClass[];
	expectedOutcome: ExpectedOutcome;
	narrative: string;
	refs: IncidentRefs;
	/** The resolved (base, main, candidate) actually assessed — see `resolveManifestEntryContext`'s doc
	 *  for how missing `refs` fields are filled in. Absent when the entry couldn't be scored at all
	 *  (`gapReason` explains why). */
	context?: AnalyzerContext;
	gapReason?: string;
	perAnalyzer: PerAnalyzerIncidentResult[];
	/** Classes on this entry with no v0 claimant (`claimedByAnalyzer` returned `undefined`) — reported,
	 *  never scored (SCHEMA-V0.md / DESIGN.md's "never a false negative for the wrong analyzer" rule). */
	unclaimedClasses: TaxonomyClass[];
}

export type ContextResolution = { ok: true; context: AnalyzerContext } | { ok: false; reason: string };

/**
 * Fill in a manifest entry's (base, main, candidate) triple for replay. Manifest entries are pinned by
 * hand and deliberately incomplete for several incident shapes (an orphaned-merge entry has no
 * meaningful "declared base"; a stacked-base entry's whole point is that the CURRENT main state is what
 * exposes it, not a frozen historical one) — SCHEMA-V0.md gives no closed-form rule for this, so the
 * convention here is:
 *
 *   candidateCommit   REQUIRED — an entry with none is nothing to assess (a gap, not silently skipped).
 *   mainCommit        `refs.mainCommit` if pinned; else the CALLER's resolved current main tip
 *                      (`currentMainCommit`) — matches the manifest's own narratives, which check
 *                      ancestry against "origin/main" TODAY, not a frozen historical state. For a
 *                      `should-block-eventually` entry, `detectionAtMainCommit` (the specific later-main
 *                      commit ADR.md requires) is used instead of either, unconditionally — that field
 *                      exists exactly to make "eventually" a checkable date.
 *   baseCommit        `refs.baseCommit` if pinned; else DEFAULTS TO `mainCommit` — a deliberate no-op
 *                      default: `detectStackedBase`/`detectTransplantedLineage` compare against
 *                      `baseCommit`, and `base === main` makes both compare an interval against itself
 *                      (never a spurious finding), while `detectOrphanedMerge`/`detectStaleForkOverlap`
 *                      (which don't need `baseCommit` at all) run unaffected. Without this default, an
 *                      orphaned-merge entry lacking `refs.baseCommit` would make `topologyAnalyzer`
 *                      entirely non-applicable (`applicable()` requires all three commits truthy) and
 *                      silently drop out of scoring — exactly the false "unclaimed-looking" gap this
 *                      default exists to prevent.
  *  @substrate Only `scoreManifestEntry` (same file) calls this in production; `run.test.ts` pins
 *  its missing-ref resolution rules directly since they are easy to get subtly wrong and hard to
 *  observe through a full `runReplay` call.
*/
export function resolveManifestEntryContext(repo: string, currentMainCommit: string, entry: ManifestEntry): ContextResolution {
	const candidateCommit = entry.refs.candidateCommit;
	if (!candidateCommit) return { ok: false, reason: `manifest entry ${entry.id} has no refs.candidateCommit — nothing to assess` };
	const mainCommit = entry.expectedOutcome === "should-block-eventually" && entry.detectionAtMainCommit ? entry.detectionAtMainCommit : (entry.refs.mainCommit ?? currentMainCommit);
	const baseCommit = entry.refs.baseCommit ?? mainCommit;
	return { ok: true, context: { repo, baseCommit, mainCommit, candidateCommit } };
}

async function scoreManifestEntry(repo: string, currentMainCommit: string, entry: ManifestEntry, analyzers: AnalyzerRegistry): Promise<IncidentReplayRow> {
	const byAnalyzer = new Map<V0AnalyzerName, TaxonomyClass[]>();
	const unclaimedClasses: TaxonomyClass[] = [];
	for (const cls of entry.taxonomyClasses) {
		const owner = claimedByAnalyzer(cls);
		if (!owner) {
			unclaimedClasses.push(cls);
			continue;
		}
		const list = byAnalyzer.get(owner);
		if (list) list.push(cls);
		else byAnalyzer.set(owner, [cls]);
	}

	const resolved = resolveManifestEntryContext(repo, currentMainCommit, entry);
	if (!resolved.ok) {
		return { entryId: entry.id, taxonomyClasses: entry.taxonomyClasses, expectedOutcome: entry.expectedOutcome, narrative: entry.narrative, refs: entry.refs, gapReason: resolved.reason, perAnalyzer: [], unclaimedClasses };
	}

	const perAnalyzer: PerAnalyzerIncidentResult[] = [];
	for (const [name, claimedClasses] of byAnalyzer) {
		const outcome = await runOneAnalyzer(name, analyzers[name], resolved.context);
		perAnalyzer.push({
			analyzer: name,
			claimedClasses,
			applicable: outcome.applicable,
			fired: outcome.result.findings.length > 0,
			findings: outcome.result.findings,
			observations: outcome.result.observations,
			coverage: outcome.result.coverage,
			runtimeMs: outcome.runtimeMs,
		});
	}
	return { entryId: entry.id, taxonomyClasses: entry.taxonomyClasses, expectedOutcome: entry.expectedOutcome, narrative: entry.narrative, refs: entry.refs, context: resolved.context, perAnalyzer, unclaimedClasses };
}

/** One (class, analyzer, incident) sample — `report.ts` folds these into per-class recall/negative
 *  metrics. Flattened out of `IncidentReplayRow.perAnalyzer` so a class claimed by one analyzer but
 *  appearing on an entry alongside an unclaimed class never leaks the unclaimed class into a metric. */
export interface ClassRecallSample {
	taxonomyClass: TaxonomyClass;
	analyzer: V0AnalyzerName;
	entryId: string;
	expectedOutcome: ExpectedOutcome;
	fired: boolean;
}

function deriveClassRecallSamples(rows: readonly IncidentReplayRow[]): ClassRecallSample[] {
	const samples: ClassRecallSample[] = [];
	for (const row of rows) {
		for (const pa of row.perAnalyzer) {
			for (const cls of pa.claimedClasses) {
				samples.push({ taxonomyClass: cls, analyzer: pa.analyzer, entryId: row.entryId, expectedOutcome: row.expectedOutcome, fired: pa.fired });
			}
		}
	}
	return samples;
}

// ── Synthetic scoring ────────────────────────────────────────────────────────────────────────────────

/** `fired` is keyed on OBSERVATIONS, never findings: `structuralDeltaAnalyzer`'s two finding kinds
 *  (`concurrentEdits`, `adjacentDependencyChanges`) are both inherently TWO-SIDED/relational -- they
 *  require an independent main-side delta to intersect with, which a synthetic pair structurally can
 *  never have (`SyntheticPair.mainContent === baseContent` always, by its own doc). The mutation's own
 *  detectable signal lives entirely in the CANDIDATE-side delta observations (`EXPORTS_REMOVED`,
 *  `SIGNATURE_CHANGED`, ...) -- discovered empirically while writing this concern's own tests: scoring
 *  synthetic recall on `findings.length > 0` silently reads as "0% recall always", which is not what the
 *  analyzer actually does (it correctly OBSERVES the change; it just never FINDS a relational conclusion
 *  from a one-sided synthetic pair, by design). SCHEMA-V0.md's own observation/finding split makes this
 *  the correct signal, not a workaround. */
export interface SyntheticRecallSample {
	taxonomyClass: TaxonomyClass;
	kind: SyntheticMutationKind;
	pairId: string;
	fired: boolean;
	runtimeMs: number;
}

export interface SyntheticGap {
	pairId: string;
	kind: SyntheticMutationKind;
	reason: string;
}

/**
 * Materialize one `SyntheticPair`'s in-memory content triple as real git commits in a fresh throwaway
 * repo — `structuralDeltaAnalyzer` reads via `git show <commit>:<path>`, never raw strings, so there is
 * no way to run it over a `SyntheticPair` without this step. One repo per pair (not one shared repo
 * reused across pairs) trades a little `git init` overhead for zero risk of state bleeding between pairs
 * that reuse the same `sourcePath` under different seeds/kinds. `mainCommit === baseCommit` always,
 * matching `SyntheticPair.mainContent`'s own documented invariant (identical to `baseContent` by
 * construction — these pairs model a candidate-only mutation, never a concurrent main-side edit).
 */
async function materializeSyntheticPair(pair: SyntheticPair): Promise<{ ok: true; context: AnalyzerContext } | { ok: false; reason: string }> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "land-assessment-synth-"));
	try {
		const relPath = pair.sourcePath.replace(/^\.?\//, "");
		const filePath = path.join(repo, relPath);
		await fs.mkdir(path.dirname(filePath), { recursive: true });

		const init = await git(["init", "-q", "-b", "main"], repo);
		if (init.code !== 0) return { ok: false, reason: `git init failed: ${init.stderr || init.stdout}` };
		await git(["config", "user.email", "replay@land-assessment"], repo);
		await git(["config", "user.name", "land-assessment replay"], repo);
		await git(["config", "commit.gpgsign", "false"], repo);

		await fs.writeFile(filePath, pair.baseContent);
		await git(["add", "-A"], repo);
		const baseCommitRun = await git(["commit", "-q", "-m", "base"], repo);
		if (baseCommitRun.code !== 0) return { ok: false, reason: `base commit failed: ${baseCommitRun.stderr || baseCommitRun.stdout}` };
		const baseSha = (await git(["rev-parse", "HEAD"], repo)).stdout;

		await fs.writeFile(filePath, pair.candidateContent);
		await git(["add", "-A"], repo);
		const candidateCommitRun = await git(["commit", "-q", "-m", "candidate"], repo);
		if (candidateCommitRun.code !== 0) return { ok: false, reason: `candidate commit failed: ${candidateCommitRun.stderr || candidateCommitRun.stdout}` };
		const candidateSha = (await git(["rev-parse", "HEAD"], repo)).stdout;

		return { ok: true, context: { repo, baseCommit: baseSha, mainCommit: baseSha, candidateCommit: candidateSha } };
	} catch (err) {
		await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
		return { ok: false, reason: `materialization crashed: ${errText(err)}` };
	}
}

async function runSyntheticPair(pair: SyntheticPair): Promise<{ ok: true; result: AnalysisResult; runtimeMs: number; repo: string } | { ok: false; reason: string }> {
	const materialized = await materializeSyntheticPair(pair);
	if (!materialized.ok) return { ok: false, reason: materialized.reason };
	const outcome = await runOneAnalyzer("typescript-structural-delta", structuralDeltaAnalyzer, materialized.context);
	await fs.rm(materialized.context.repo, { recursive: true, force: true }).catch(() => {});
	if (!outcome.applicable) return { ok: false, reason: `structuralDeltaAnalyzer reported not-applicable to its own generated mutation (pair ${pair.id})` };
	return { ok: true, result: outcome.result, runtimeMs: outcome.runtimeMs, repo: materialized.context.repo };
}

async function runSyntheticScoring(files: readonly SyntheticCorpusFile[], seedBase: number): Promise<{ samples: SyntheticRecallSample[]; gaps: SyntheticGap[] }> {
	const samples: SyntheticRecallSample[] = [];
	const gaps: SyntheticGap[] = [];
	if (files.length === 0) return { samples, gaps };
	const synthetic = generateSyntheticCorpus(files, seedBase);
	for (const cov of synthetic.coverage) {
		for (const gap of cov.gaps) gaps.push({ pairId: `${gap.sourcePath}#${cov.kind}`, kind: cov.kind, reason: gap.reason });
	}
	for (const pair of synthetic.pairs) {
		const outcome = await runSyntheticPair(pair);
		if (!outcome.ok) {
			gaps.push({ pairId: pair.id, kind: pair.kind, reason: outcome.reason });
			continue;
		}
		samples.push({ taxonomyClass: pair.taxonomyClass, kind: pair.kind, pairId: pair.id, fired: outcome.result.observations.length > 0, runtimeMs: outcome.runtimeMs });
	}
	return { samples, gaps };
}

// ── Corpus scoring (broad real-history stats, no manifest labels) ──────────────────────────────────

export interface CorpusRunSample {
	tripleId: string;
	source: ReplaySource;
	alerted: boolean;
	observations: SnapshotFact[];
	findings: AssessmentFinding[];
	coverage: ExtractionCoverage[];
	runtimeMsByAnalyzer: Record<string, number>;
}

async function runCorpusTriple(triple: ReplayTriple, analyzers: AnalyzerRegistry): Promise<CorpusRunSample> {
	const ctx: AnalyzerContext = { repo: triple.repo, baseCommit: triple.baseCommit, mainCommit: triple.mainCommit, candidateCommit: triple.candidateCommit };
	const observations: SnapshotFact[] = [];
	const findings: AssessmentFinding[] = [];
	const coverage: ExtractionCoverage[] = [];
	const runtimeMsByAnalyzer: Record<string, number> = {};
	for (const [name, analyzer] of Object.entries(analyzers) as [V0AnalyzerName, AssessmentAnalyzer][]) {
		const outcome = await runOneAnalyzer(name, analyzer, ctx);
		runtimeMsByAnalyzer[name] = outcome.runtimeMs;
		observations.push(...outcome.result.observations);
		findings.push(...outcome.result.findings);
		coverage.push(...outcome.result.coverage);
	}
	return { tripleId: triple.id, source: triple.source, alerted: findings.length > 0, observations, findings, coverage, runtimeMsByAnalyzer };
}

// ── Top-level orchestration ──────────────────────────────────────────────────────────────────────────

export interface RunReplayOptions {
	repo: string;
	stateDir: string;
	manifest: IncidentManifest;
	/** The resolved current main tip — the caller (`cli.ts`) resolves this ONCE via `git rev-parse
	 *  <mainRef>` and passes it in, so every manifest entry missing `refs.mainCommit` shares the exact
	 *  same "current main" rather than each independently (and possibly inconsistently) resolving it. */
	mainCommitForUnpinnedEntries: string;
	analyzers?: AnalyzerRegistry;
	/** Real reconstructed land history (`replay/corpus.ts#buildReplayCorpus`) — optional; omitted means
	 *  no corpus-scoring pass (no runtime/coverage/precision-at-budget stats beyond the manifest's 11
	 *  incidents), never a silent partial run. */
	corpus?: ReplayCorpus;
	/** Real dogfood-repo TS files to synthesize mutations over — optional; omitted means no synthetic
	 *  recall evidence for `structural-api`/`dependency` at all (an honest zero, not a fabricated one). */
	syntheticFiles?: readonly SyntheticCorpusFile[];
	syntheticSeedBase?: number;
}

export interface StoreSummary {
	malformedCount: number;
	malformed: MalformedLine[];
	attemptCount: number;
	incompleteAttemptCount: number;
}

export interface ReplayRunResult {
	generatedAt: string;
	repositoryId: string;
	incidentRows: IncidentReplayRow[];
	classRecallSamples: ClassRecallSample[];
	syntheticSamples: SyntheticRecallSample[];
	syntheticGaps: SyntheticGap[];
	corpusSamples: CorpusRunSample[];
	unpinnable: UnpinnableEntry[];
	store: StoreSummary;
	/** `true` iff the event store's own strict-with-accounting read found any malformed line for this
	 *  repository — the ONE condition `cli.ts` maps to a non-zero exit (the concern's explicit "no flag
	 *  to silence in v0"). Never set by a gap/crash in analyzer scoring — those are reported, not fatal. */
	incomplete: boolean;
}

export async function runReplay(opts: RunReplayOptions): Promise<ReplayRunResult> {
	const repo = computeRepositoryId(opts.repo);
	const analyzers = opts.analyzers ?? defaultAnalyzerRegistry();

	const store = await reconstructRepositoryStore(opts.stateDir, repo);

	const incidentRows: IncidentReplayRow[] = [];
	for (const entry of opts.manifest.entries) {
		incidentRows.push(await scoreManifestEntry(repo, opts.mainCommitForUnpinnedEntries, entry, analyzers));
	}
	const classRecallSamples = deriveClassRecallSamples(incidentRows);

	const { samples: syntheticSamples, gaps: syntheticGaps } = await runSyntheticScoring(opts.syntheticFiles ?? [], opts.syntheticSeedBase ?? 0);

	const corpusSamples: CorpusRunSample[] = [];
	if (opts.corpus) {
		for (const triple of opts.corpus.triples) corpusSamples.push(await runCorpusTriple(triple, analyzers));
	}

	const incompleteAttemptCount = store.attempts.filter((a) => a.terminal === "incomplete").length;
	return {
		generatedAt: new Date().toISOString(),
		repositoryId: repo,
		incidentRows,
		classRecallSamples,
		syntheticSamples,
		syntheticGaps,
		corpusSamples,
		unpinnable: opts.manifest.unpinnable,
		store: { malformedCount: store.malformed.length, malformed: store.malformed, attemptCount: store.attempts.length, incompleteAttemptCount },
		incomplete: store.malformed.length > 0,
	};
}
