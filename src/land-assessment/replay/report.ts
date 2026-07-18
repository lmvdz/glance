/**
 * Replay report -- JSON metrics + Markdown rendering (concern 06, `plans/land-assessment/06-replay-cli-and-report.md`).
 *
 * `computeMetrics` never collapses honesty into a single number: every recall figure carries its own
 * per-class `n` (never reported as a bare percentage -- BRIEF section 11.5 danger sign #1's
 * scalar-scores-only failure mode), synthetic recall is labeled `"synthetic (circular-generation
 * caveat)"` at the type level (not just in prose, so a consumer can't accidentally treat it as real),
 * coverage stays split by dimension (`syntax` | `resolution` | `type` -- SCHEMA-V0.md forbids one
 * scalar), and precision@budget is explicitly NOT decision-grade (ADR.md's Phase gates: a Phase-3
 * experiment, "not decision-grade without a criterion oracle"). The report carries observations, not
 * just conclusions: every `IncidentReplayRow` (passed through from `run.ts` untouched) still has its
 * full `findings` + `observations` arrays attached, so a reader can inspect the raw evidence a recall
 * number is built on.
 */

import { claimedByAnalyzer, TAXONOMY_CLASSES, type IncidentManifest, type TaxonomyClass, type V0AnalyzerName } from "./incident-taxonomy.ts";
import type { ClassRecallSample, CorpusRunSample, IncidentReplayRow, ReplayRunResult, StoreSummary, SyntheticGap, SyntheticRecallSample } from "./run.ts";
import type { AssessmentFinding, ExtractionCoverage } from "../schema.ts";
import type { UnpinnableEntry } from "./incident-taxonomy.ts";

// -- Metric shapes --------------------------------------------------------------------------------------

export interface ClassRecallMetric {
	taxonomyClass: TaxonomyClass;
	claimedBy?: V0AnalyzerName;
	n: number;
	hits: number;
	/** `null` (never `0`) when `n === 0` -- a class with zero real positives has no recall to report,
	 *  and printing `0` would read as "the analyzer failed every case" instead of "there were no cases". */
	recall: number | null;
}

export interface NegativeMetric {
	taxonomyClass: TaxonomyClass;
	analyzer: V0AnalyzerName;
	n: number;
	falsePositives: number;
	falsePositiveRate: number | null;
}

export const SYNTHETIC_CAVEAT = "synthetic (circular-generation caveat)" as const;

export interface SyntheticClassMetric {
	taxonomyClass: TaxonomyClass;
	n: number;
	hits: number;
	recall: number | null;
	caveat: typeof SYNTHETIC_CAVEAT;
}

export interface RuntimeMetric {
	analyzer: string;
	p50Ms: number;
	p95Ms: number;
	samples: number;
}

export interface PrecisionAtBudgetMetric {
	reviewBudgetK: number;
	reviewBudgetPerLands: number;
	landsSampled: number;
	alertingLands: number;
	alertRatePer100Lands: number | null;
	negativeSampleCollected: number;
	negativeSampleTarget: number;
	caveat: string;
}

export interface ObservationPredicateCount {
	predicate: string;
	count: number;
}

export interface EvidenceInspectabilityMetric {
	findingsTotal: number;
	findingsWithEvidence: number;
	pct: number | null;
}

export interface ReplayMetrics {
	generatedAt: string;
	repositoryId: string;
	incomplete: boolean;
	store: StoreSummary;
	classRecall: ClassRecallMetric[];
	negatives: NegativeMetric[];
	syntheticRecall: SyntheticClassMetric[];
	syntheticGaps: SyntheticGap[];
	runtimes: RuntimeMetric[];
	coverageByDimension: ExtractionCoverage[];
	observationsByPredicate: ObservationPredicateCount[];
	evidenceInspectability: EvidenceInspectabilityMetric;
	/** `null` when no corpus was supplied to `runReplay` -- never a fabricated zero. */
	precisionAtBudget: PrecisionAtBudgetMetric | null;
	unclaimedClassesPresent: TaxonomyClass[];
	unpinnable: UnpinnableEntry[];
	incidentRows: IncidentReplayRow[];
}

// -- Per-metric computation ------------------------------------------------------------------------------

function computeClassRecall(samples: readonly ClassRecallSample[]): ClassRecallMetric[] {
	const byClass = new Map<TaxonomyClass, ClassRecallSample[]>();
	for (const s of samples) {
		if (s.expectedOutcome === "should-not-flag") continue; // negatives, scored separately below
		const list = byClass.get(s.taxonomyClass);
		if (list) list.push(s);
		else byClass.set(s.taxonomyClass, [s]);
	}
	return TAXONOMY_CLASSES.map((cls) => {
		const list = byClass.get(cls) ?? [];
		const n = list.length;
		const hits = list.filter((s) => s.fired).length;
		return { taxonomyClass: cls, claimedBy: claimedByAnalyzer(cls), n, hits, recall: n > 0 ? hits / n : null };
	});
}

function computeNegatives(samples: readonly ClassRecallSample[]): NegativeMetric[] {
	const byKey = new Map<string, { taxonomyClass: TaxonomyClass; analyzer: V0AnalyzerName; list: ClassRecallSample[] }>();
	for (const s of samples) {
		if (s.expectedOutcome !== "should-not-flag") continue;
		const key = `${s.taxonomyClass} ${s.analyzer}`;
		const bucket = byKey.get(key);
		if (bucket) bucket.list.push(s);
		else byKey.set(key, { taxonomyClass: s.taxonomyClass, analyzer: s.analyzer, list: [s] });
	}
	return [...byKey.values()]
		.map(({ taxonomyClass, analyzer, list }) => {
			const n = list.length;
			const falsePositives = list.filter((s) => s.fired).length;
			return { taxonomyClass, analyzer, n, falsePositives, falsePositiveRate: n > 0 ? falsePositives / n : null };
		})
		.sort((a, b) => a.taxonomyClass.localeCompare(b.taxonomyClass) || a.analyzer.localeCompare(b.analyzer));
}

function computeSyntheticRecall(samples: readonly SyntheticRecallSample[]): SyntheticClassMetric[] {
	const byClass = new Map<TaxonomyClass, SyntheticRecallSample[]>();
	for (const s of samples) {
		const list = byClass.get(s.taxonomyClass);
		if (list) list.push(s);
		else byClass.set(s.taxonomyClass, [s]);
	}
	return [...byClass.entries()]
		.map(([taxonomyClass, list]) => {
			const n = list.length;
			const hits = list.filter((s) => s.fired).length;
			return { taxonomyClass, n, hits, recall: n > 0 ? hits / n : null, caveat: SYNTHETIC_CAVEAT };
		})
		.sort((a, b) => a.taxonomyClass.localeCompare(b.taxonomyClass));
}

function percentile(sortedAscending: readonly number[], p: number): number {
	if (sortedAscending.length === 0) return 0;
	const idx = Math.min(sortedAscending.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAscending.length) - 1));
	return sortedAscending[idx]!;
}

function computeRuntimes(run: ReplayRunResult): RuntimeMetric[] {
	const byAnalyzer = new Map<string, number[]>();
	const push = (name: string, ms: number): void => {
		const list = byAnalyzer.get(name);
		if (list) list.push(ms);
		else byAnalyzer.set(name, [ms]);
	};
	for (const row of run.incidentRows) for (const pa of row.perAnalyzer) push(pa.analyzer, pa.runtimeMs);
	for (const s of run.corpusSamples) for (const [name, ms] of Object.entries(s.runtimeMsByAnalyzer)) push(name, ms);
	for (const s of run.syntheticSamples) push("typescript-structural-delta", s.runtimeMs);
	return [...byAnalyzer.entries()]
		.map(([analyzer, msList]) => {
			const sorted = [...msList].sort((a, b) => a - b);
			return { analyzer, p50Ms: percentile(sorted, 50), p95Ms: percentile(sorted, 95), samples: sorted.length };
		})
		.sort((a, b) => a.analyzer.localeCompare(b.analyzer));
}

function mergeCoverage(coverageLists: readonly ExtractionCoverage[][]): ExtractionCoverage[] {
	const byDim = new Map<ExtractionCoverage["dimension"], { covered: number; total: number; gaps: ExtractionCoverage["gaps"] }>();
	for (const list of coverageLists) {
		for (const c of list) {
			const agg = byDim.get(c.dimension) ?? { covered: 0, total: 0, gaps: [] };
			agg.covered += c.covered;
			agg.total += c.total;
			agg.gaps.push(...c.gaps);
			byDim.set(c.dimension, agg);
		}
	}
	return [...byDim.entries()]
		.map(([dimension, agg]) => ({ dimension, covered: agg.covered, total: agg.total, gaps: agg.gaps }))
		.sort((a, b) => a.dimension.localeCompare(b.dimension));
}

function collectAllCoverage(run: ReplayRunResult): ExtractionCoverage[] {
	const lists: ExtractionCoverage[][] = [];
	for (const row of run.incidentRows) for (const pa of row.perAnalyzer) lists.push(pa.coverage);
	for (const s of run.corpusSamples) lists.push(s.coverage);
	return mergeCoverage(lists);
}

function collectAllFindings(run: ReplayRunResult): AssessmentFinding[] {
	const findings: AssessmentFinding[] = [];
	for (const row of run.incidentRows) for (const pa of row.perAnalyzer) findings.push(...pa.findings);
	for (const s of run.corpusSamples) findings.push(...s.findings);
	return findings;
}

function computeObservationsByPredicate(run: ReplayRunResult): ObservationPredicateCount[] {
	const counts = new Map<string, number>();
	const addAll = (predicate: string): void => {
		counts.set(predicate, (counts.get(predicate) ?? 0) + 1);
	};
	for (const row of run.incidentRows) for (const pa of row.perAnalyzer) for (const o of pa.observations) addAll(o.predicate);
	for (const s of run.corpusSamples) for (const o of s.observations) addAll(o.predicate);
	return [...counts.entries()].map(([predicate, count]) => ({ predicate, count })).sort((a, b) => b.count - a.count || a.predicate.localeCompare(b.predicate));
}

function computeEvidenceInspectability(findings: readonly AssessmentFinding[]): EvidenceInspectabilityMetric {
	const findingsTotal = findings.length;
	const findingsWithEvidence = findings.filter((f) => f.evidence.length > 0).length;
	return { findingsTotal, findingsWithEvidence, pct: findingsTotal > 0 ? (findingsWithEvidence / findingsTotal) * 100 : null };
}

const PRECISION_AT_BUDGET_CAVEAT = "alert rate over the sampled corpus vs. the manifest-pinned budget -- NOT decision-grade without a criterion oracle (ADR.md Phase gates, Phase 3)";

function computePrecisionAtBudget(run: ReplayRunResult, manifest: IncidentManifest): PrecisionAtBudgetMetric | null {
	if (run.corpusSamples.length === 0) return null;
	const landsSampled = run.corpusSamples.length;
	const alertingLands = run.corpusSamples.filter((s) => s.alerted).length;
	return {
		reviewBudgetK: manifest.benchmarkParameters.reviewBudgetK,
		reviewBudgetPerLands: manifest.benchmarkParameters.reviewBudgetPerLands,
		landsSampled,
		alertingLands,
		alertRatePer100Lands: landsSampled > 0 ? (alertingLands / landsSampled) * 100 : null,
		negativeSampleCollected: manifest.benchmarkParameters.negativeSampleCollected,
		negativeSampleTarget: manifest.benchmarkParameters.negativeSampleTarget,
		caveat: PRECISION_AT_BUDGET_CAVEAT,
	};
}

function computeUnclaimedClassesPresent(rows: readonly IncidentReplayRow[]): TaxonomyClass[] {
	return [...new Set(rows.flatMap((r) => r.unclaimedClasses))].sort();
}

export function computeMetrics(run: ReplayRunResult, manifest: IncidentManifest): ReplayMetrics {
	const findings = collectAllFindings(run);
	return {
		generatedAt: run.generatedAt,
		repositoryId: run.repositoryId,
		incomplete: run.incomplete,
		store: run.store,
		classRecall: computeClassRecall(run.classRecallSamples),
		negatives: computeNegatives(run.classRecallSamples),
		syntheticRecall: computeSyntheticRecall(run.syntheticSamples),
		syntheticGaps: run.syntheticGaps,
		runtimes: computeRuntimes(run),
		coverageByDimension: collectAllCoverage(run),
		observationsByPredicate: computeObservationsByPredicate(run),
		evidenceInspectability: computeEvidenceInspectability(findings),
		precisionAtBudget: computePrecisionAtBudget(run, manifest),
		unclaimedClassesPresent: computeUnclaimedClassesPresent(run.incidentRows),
		unpinnable: run.unpinnable,
		incidentRows: run.incidentRows,
	};
}

// -- JSON rendering ---------------------------------------------------------------------------------------

/** The JSON report IS `ReplayMetrics` -- no lossy projection between "what we computed" and "what a
 *  machine consumer sees" (BRIEF section 11.5's danger signs apply to the report format too: a
 *  scalar-only JSON export would silently drop the per-class `n` the Markdown table keeps visible). */
export function toJson(metrics: ReplayMetrics): string {
	return JSON.stringify(metrics, null, 2);
}

// -- Markdown rendering -------------------------------------------------------------------------------

function fmtPct(v: number | null): string {
	return v === null ? "n/a" : `${v.toFixed(1)}%`;
}

function fmtRecall(m: { n: number; hits: number; recall: number | null }): string {
	return m.recall === null ? `n/a (n=0)` : `${(m.recall * 100).toFixed(1)}% (${m.hits}/${m.n})`;
}

function renderClassRecallTable(rows: readonly ClassRecallMetric[]): string {
	const header = "| class | claimed by | recall | n |\n|---|---|---|---|";
	const body = rows.map((r) => `| ${r.taxonomyClass} | ${r.claimedBy ?? "(unclaimed)"} | ${fmtRecall(r)} | ${r.n} |`).join("\n");
	return `${header}\n${body}`;
}

function renderSyntheticTable(rows: readonly SyntheticClassMetric[]): string {
	if (rows.length === 0) return "_no synthetic pairs were run (no `syntheticFiles` supplied)._";
	const header = `| class | recall | n | caveat |\n|---|---|---|---|`;
	const body = rows.map((r) => `| ${r.taxonomyClass} | ${fmtRecall(r)} | ${r.n} | ${r.caveat} |`).join("\n");
	return `${header}\n${body}`;
}

function renderNegativesTable(rows: readonly NegativeMetric[]): string {
	if (rows.length === 0) return "_no should-not-flag entries were scored._";
	const header = "| class | analyzer | false positives | n |\n|---|---|---|---|";
	const body = rows.map((r) => `| ${r.taxonomyClass} | ${r.analyzer} | ${fmtPct(r.falsePositiveRate === null ? null : r.falsePositiveRate * 100)} (${r.falsePositives}/${r.n}) | ${r.n} |`).join("\n");
	return `${header}\n${body}`;
}

function renderRuntimeTable(rows: readonly RuntimeMetric[]): string {
	if (rows.length === 0) return "_no analyzer runs recorded._";
	const header = "| analyzer | p50 (ms) | p95 (ms) | samples |\n|---|---|---|---|";
	const body = rows.map((r) => `| ${r.analyzer} | ${r.p50Ms.toFixed(1)} | ${r.p95Ms.toFixed(1)} | ${r.samples} |`).join("\n");
	return `${header}\n${body}`;
}

function renderCoverageTable(rows: readonly ExtractionCoverage[]): string {
	if (rows.length === 0) return "_no coverage recorded._";
	const header = "| dimension | covered | total | gaps |\n|---|---|---|---|";
	const body = rows.map((r) => `| ${r.dimension} | ${r.covered} | ${r.total} | ${r.gaps.length} |`).join("\n");
	return `${header}\n${body}`;
}

function renderPredicateTable(rows: readonly ObservationPredicateCount[]): string {
	if (rows.length === 0) return "_no observations recorded._";
	const header = "| predicate | count |\n|---|---|";
	const body = rows.map((r) => `| ${r.predicate} | ${r.count} |`).join("\n");
	return `${header}\n${body}`;
}

function renderIncidentRow(row: IncidentReplayRow): string {
	const lines: string[] = [`### ${row.entryId} -- ${row.expectedOutcome}`, "", row.narrative, ""];
	lines.push(`taxonomy classes: ${row.taxonomyClasses.join(", ")}`);
	if (row.unclaimedClasses.length > 0) lines.push(`unclaimed classes (never scored): ${row.unclaimedClasses.join(", ")}`);
	if (row.gapReason) {
		lines.push(`GAP: ${row.gapReason}`);
		return lines.join("\n");
	}
	if (row.context) lines.push(`context: base=${row.context.baseCommit.slice(0, 12)} main=${row.context.mainCommit.slice(0, 12)} candidate=${row.context.candidateCommit.slice(0, 12)}`);
	for (const pa of row.perAnalyzer) {
		lines.push("");
		lines.push(`**${pa.analyzer}** (claims ${pa.claimedClasses.join(", ")}) -- ${pa.fired ? "FIRED" : "silent"} (${pa.findings.length} finding(s), ${pa.observations.length} observation(s), ${pa.runtimeMs.toFixed(1)}ms)`);
		for (const f of pa.findings) {
			lines.push(`  - \`${f.id}\` (${f.kind}): ${f.statement}`);
			lines.push(`    derived from: ${f.derivedFromObservations.join(", ") || "(none -- inferred)"}`);
		}
	}
	return lines.join("\n");
}

export function renderMarkdown(metrics: ReplayMetrics): string {
	const sections: string[] = [];
	sections.push(`# Land Assessment replay report`);
	sections.push("");
	sections.push(`generated: ${metrics.generatedAt}  \nrepository: \`${metrics.repositoryId}\``);
	if (metrics.incomplete) {
		sections.push("");
		sections.push(`## INCOMPLETE`);
		sections.push(`The event store had ${metrics.store.malformedCount} malformed line(s) -- this run's metrics are computed over an incomplete read. See \`store.malformed\` in the JSON report for exact locations.`);
	}
	sections.push("");
	sections.push(`## Real recall (per taxonomy class, manifest-labeled incidents)`);
	sections.push(renderClassRecallTable(metrics.classRecall));
	if (metrics.unclaimedClassesPresent.length > 0) {
		sections.push("");
		sections.push(`_classes present in the manifest with no v0 claimant (never scored as a miss): ${metrics.unclaimedClassesPresent.join(", ")}_`);
	}
	sections.push("");
	sections.push(`## Synthetic recall (structural-api / dependency -- ${SYNTHETIC_CAVEAT})`);
	sections.push(renderSyntheticTable(metrics.syntheticRecall));
	if (metrics.syntheticGaps.length > 0) {
		sections.push("");
		sections.push(`${metrics.syntheticGaps.length} synthetic generation gap(s) (inapplicable file/kind combinations) -- never silently dropped, see \`syntheticGaps\` in the JSON report.`);
	}
	sections.push("");
	sections.push(`## Negatives (should-not-flag)`);
	sections.push(renderNegativesTable(metrics.negatives));
	sections.push("");
	sections.push(`## Runtime (per analyzer, across every context replayed)`);
	sections.push(renderRuntimeTable(metrics.runtimes));
	sections.push("");
	sections.push(`## Extraction coverage (per dimension -- never one scalar)`);
	sections.push(renderCoverageTable(metrics.coverageByDimension));
	sections.push("");
	sections.push(`## Observations by predicate`);
	sections.push(renderPredicateTable(metrics.observationsByPredicate));
	sections.push("");
	sections.push(`## Evidence inspectability`);
	sections.push(`${fmtPct(metrics.evidenceInspectability.pct)} of findings (${metrics.evidenceInspectability.findingsWithEvidence}/${metrics.evidenceInspectability.findingsTotal}) carry at least one evidence pointer.`);
	sections.push("");
	sections.push(`## Precision@budget`);
	if (metrics.precisionAtBudget) {
		const p = metrics.precisionAtBudget;
		sections.push(
			`Budget: ${p.reviewBudgetK} alerts / ${p.reviewBudgetPerLands} lands. Sampled ${p.landsSampled} land(s), ${p.alertingLands} alerted (${fmtPct(p.alertRatePer100Lands)} of sampled lands, normalized per 100). ` +
				`Manually-reviewed negative sample: ${p.negativeSampleCollected}/${p.negativeSampleTarget} target. ${p.caveat}`,
		);
	} else {
		sections.push(`_no corpus was supplied to this run -- precision@budget requires a broader real-history sample beyond the manifest's labeled incidents._`);
	}
	if (metrics.unpinnable.length > 0) {
		sections.push("");
		sections.push(`## Unpinnable (archaeology found no commit to pin)`);
		for (const u of metrics.unpinnable) {
			sections.push(`- **${u.id}** (${u.taxonomyClasses.join(", ")}): ${u.reason}`);
		}
	}
	sections.push("");
	sections.push(`## Per-incident detail`);
	for (const row of metrics.incidentRows) {
		sections.push("");
		sections.push(renderIncidentRow(row));
	}
	return `${sections.join("\n")}\n`;
}
