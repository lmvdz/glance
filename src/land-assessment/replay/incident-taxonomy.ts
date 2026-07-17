/**
 * Incident taxonomy + labeled replay manifest loader (concern 02, `plans/land-assessment/02-taxonomy-and-manifest.md`).
 *
 * The written incident→claim mapping the scope red-team demanded (DESIGN.md's "Red Team Concerns
 * Addressed" table): a fixed nine-class taxonomy (BRIEF.md §10.4), a `claimedBy` map declaring which
 * v0 analyzer is judged against which classes ("a stacked-base miss is a topology-analyzer matter,
 * NEVER a structural-delta false negative" — BRIEF §10.4), and a hand-curated manifest of REAL, pinned
 * historical incidents produced BEFORE either analyzer is built — so nobody discovers after the fact
 * that the built analyzer has zero real positives (the structural-api finding below IS exactly that,
 * on purpose: DESIGN.md's Risks section calls this out as the honest result, not a failure).
 *
 * This module owns validation for both the taxonomy itself and the manifest that references it;
 * `incident-manifest.json` is inert data, `manifest.test.ts` only asserts against what this module
 * reports.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";

// ── The nine incident classes (BRIEF.md §10.4, verbatim) ────────────────────────────────────────────

export const TAXONOMY_CLASSES = [
	"git-topology",
	"textual-conflict",
	"structural-api",
	"dependency",
	"behavioral",
	"acceptance-criterion",
	"proof-freshness",
	"workflow-state",
	"operational",
] as const;

export type TaxonomyClass = (typeof TAXONOMY_CLASSES)[number];

const TAXONOMY_CLASS_SET: ReadonlySet<string> = new Set(TAXONOMY_CLASSES);

export function isTaxonomyClass(v: unknown): v is TaxonomyClass {
	return typeof v === "string" && TAXONOMY_CLASS_SET.has(v);
}

/** THROWS when `v` is not one of the nine fixed classes above — a typo'd class name in a manifest
 *  entry must fail loudly, not silently pass through as an unclassified incident. */
export function validateTaxonomyClass(v: unknown, context: string): TaxonomyClass {
	if (!isTaxonomyClass(v)) throw new Error(`incident-taxonomy: ${context} is not a valid taxonomy class: ${JSON.stringify(v)}`);
	return v;
}

// ── claimedBy: which v0 analyzer is judged against which classes ───────────────────────────────────

/** The two analyzers this slice actually ships (DESIGN.md's Approach + Key Decisions table). This is
 *  deliberately NOT "every analyzer that could ever exist" — proof-freshness/regression become
 *  record-time wrappers in Phase 2 and are `unclaimedTaxonomyClasses()` below until then. */
export const V0_ANALYZERS = ["topology", "typescript-structural-delta"] as const;
export type V0AnalyzerName = (typeof V0_ANALYZERS)[number];

/**
 * Each analyzer is judged ONLY against the classes it claims (BRIEF §10.4: "a stacked-base miss is a
 * topology-analyzer matter, never a structural-delta false negative"). `topology` claims the ancestry/
 * lineage class AND the gate/baseline-staleness class its incidents actually manifest as (composition
 * drift IS a topology-lineage problem: siblings whose base moved underneath them, surfaced as a stale
 * gate); `typescript-structural-delta` claims the two classes its syntactic per-file AST diff can
 * actually detect. The other five classes are unclaimed in v0 — see `unclaimedTaxonomyClasses`.
 */
export const CLAIMED_BY: Readonly<Record<V0AnalyzerName, readonly TaxonomyClass[]>> = {
	topology: ["git-topology", "workflow-state"],
	"typescript-structural-delta": ["structural-api", "dependency"],
};

/** The five classes no v0 analyzer claims (`textual-conflict`, `behavioral`, `acceptance-criterion`,
 *  `proof-freshness`, `operational`) — computed from `CLAIMED_BY` rather than hand-listed a second time,
 *  so the two can never silently drift apart. */
export function unclaimedTaxonomyClasses(): TaxonomyClass[] {
	const claimed = new Set<TaxonomyClass>(Object.values(CLAIMED_BY).flat());
	return TAXONOMY_CLASSES.filter((c) => !claimed.has(c));
}

/** Which v0 analyzer (if any) claims `cls` — `undefined` for one of the five unclaimed classes. */
export function claimedByAnalyzer(cls: TaxonomyClass): V0AnalyzerName | undefined {
	for (const name of V0_ANALYZERS) {
		if (CLAIMED_BY[name].includes(cls)) return name;
	}
	return undefined;
}

// ── Manifest entry shape ────────────────────────────────────────────────────────────────────────────

export type ExpectedOutcome = "should-detect" | "should-not-flag" | "should-block-eventually";

const EXPECTED_OUTCOMES: ReadonlySet<string> = new Set(["should-detect", "should-not-flag", "should-block-eventually"]);

/** Pinned git/GitHub coordinates for one manifest entry. All optional individually (a stacked-base
 *  incident may only have a `candidateCommit` + `prNumber`+`branch`; a clean-relanding negative may
 *  have all three commit fields) — but `validateManifestEntry` requires at least one to be present, so
 *  an entry can never be purely narrative with nothing to replay against. */
export interface IncidentRefs {
	baseCommit?: string;
	mainCommit?: string;
	candidateCommit?: string;
	prNumber?: number;
	branch?: string;
}

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.length > 0;
}

function isIncidentRefs(v: unknown): v is IncidentRefs {
	if (!v || typeof v !== "object") return false;
	const r = v as Partial<IncidentRefs>;
	if (r.baseCommit !== undefined && !isNonEmptyString(r.baseCommit)) return false;
	if (r.mainCommit !== undefined && !isNonEmptyString(r.mainCommit)) return false;
	if (r.candidateCommit !== undefined && !isNonEmptyString(r.candidateCommit)) return false;
	if (r.prNumber !== undefined && (typeof r.prNumber !== "number" || !Number.isInteger(r.prNumber))) return false;
	if (r.branch !== undefined && !isNonEmptyString(r.branch)) return false;
	return r.baseCommit !== undefined || r.mainCommit !== undefined || r.candidateCommit !== undefined || r.prNumber !== undefined || r.branch !== undefined;
}

export interface ManifestEntry {
	id: string;
	taxonomyClasses: TaxonomyClass[];
	repo: string;
	refs: IncidentRefs;
	expectedOutcome: ExpectedOutcome;
	/** REQUIRED when `expectedOutcome === "should-block-eventually"` — the specific later-main commit
	 *  at which detection is expected. Without it a "should-block-eventually" label is an unmeasurable
	 *  promise ("eventually" never resolves to a checkable date) — DESIGN.md's Risks section names this
	 *  exact failure mode ("Metrics not computable as framed... 'eventually'") and this field is its fix. */
	detectionAtMainCommit?: string;
	narrative: string;
	source: "manual";
}

/** THROWS on any structurally invalid entry, including the `should-block-eventually` ⇒
 *  `detectionAtMainCommit` rule (rejected at load, not merely documented). */
export function validateManifestEntry(v: unknown): ManifestEntry {
	if (!v || typeof v !== "object") throw new Error(`incident-taxonomy: manifest entry is not an object: ${JSON.stringify(v)}`);
	const e = v as Partial<ManifestEntry>;
	if (!isNonEmptyString(e.id)) throw new Error("incident-taxonomy: manifest entry.id must be a non-empty string");
	if (!Array.isArray(e.taxonomyClasses) || e.taxonomyClasses.length === 0) {
		throw new Error(`incident-taxonomy: manifest entry ${e.id} must declare at least one taxonomyClasses entry`);
	}
	for (const c of e.taxonomyClasses) validateTaxonomyClass(c, `manifest entry ${e.id}'s taxonomyClasses`);
	if (!isNonEmptyString(e.repo)) throw new Error(`incident-taxonomy: manifest entry ${e.id}.repo must be a non-empty string`);
	if (!isIncidentRefs(e.refs)) throw new Error(`incident-taxonomy: manifest entry ${e.id}.refs is invalid or empty — an incident must pin at least one of baseCommit/mainCommit/candidateCommit/prNumber/branch`);
	if (!EXPECTED_OUTCOMES.has(e.expectedOutcome as string)) throw new Error(`incident-taxonomy: manifest entry ${e.id}.expectedOutcome is invalid: ${JSON.stringify(e.expectedOutcome)}`);
	if (e.expectedOutcome === "should-block-eventually" && !isNonEmptyString(e.detectionAtMainCommit)) {
		throw new Error(`incident-taxonomy: manifest entry ${e.id} is "should-block-eventually" but has no detectionAtMainCommit — an unmeasurable label, rejected at load`);
	}
	if (e.detectionAtMainCommit !== undefined && !isNonEmptyString(e.detectionAtMainCommit)) {
		throw new Error(`incident-taxonomy: manifest entry ${e.id}.detectionAtMainCommit must be a non-empty string when present`);
	}
	if (!isNonEmptyString(e.narrative)) throw new Error(`incident-taxonomy: manifest entry ${e.id}.narrative must be a non-empty string`);
	if (e.source !== "manual") throw new Error(`incident-taxonomy: manifest entry ${e.id}.source must be "manual"`);
	return e as ManifestEntry;
}

/** An incident the archaeology surfaced but could not pin exact commits for — listed here with the
 *  reason rather than silently dropped (the concern's explicit instruction). */
export interface UnpinnableEntry {
	id: string;
	taxonomyClasses: TaxonomyClass[];
	reason: string;
	narrative: string;
}

export function validateUnpinnableEntry(v: unknown): UnpinnableEntry {
	if (!v || typeof v !== "object") throw new Error(`incident-taxonomy: unpinnable entry is not an object: ${JSON.stringify(v)}`);
	const e = v as Partial<UnpinnableEntry>;
	if (!isNonEmptyString(e.id)) throw new Error("incident-taxonomy: unpinnable entry.id must be a non-empty string");
	if (!Array.isArray(e.taxonomyClasses) || e.taxonomyClasses.length === 0) {
		throw new Error(`incident-taxonomy: unpinnable entry ${e.id} must declare at least one taxonomyClasses entry`);
	}
	for (const c of e.taxonomyClasses) validateTaxonomyClass(c, `unpinnable entry ${e.id}'s taxonomyClasses`);
	if (!isNonEmptyString(e.reason)) throw new Error(`incident-taxonomy: unpinnable entry ${e.id}.reason must be a non-empty string`);
	if (!isNonEmptyString(e.narrative)) throw new Error(`incident-taxonomy: unpinnable entry ${e.id}.narrative must be a non-empty string`);
	return e as UnpinnableEntry;
}

// ── Manifest header + full document ─────────────────────────────────────────────────────────────────

/** Benchmark parameters pinned as DATA (not code) so they're inspectable/tunable without a redeploy —
 *  the concern's explicit instruction: negative-sample size target and review-budget K, "recorded with
 *  rationale, tunable later". `negativeSampleCollected` is honest about how many of the target have
 *  actually been curated so far (this concern seeds a handful; reaching the target-40 is Phase-1 replay
 *  CLI work, not this concern's scope). */
export interface BenchmarkParameters {
	negativeSampleTarget: number;
	negativeSampleCollected: number;
	reviewBudgetK: number;
	reviewBudgetPerLands: number;
	rationale: string;
}

function isBenchmarkParameters(v: unknown): v is BenchmarkParameters {
	if (!v || typeof v !== "object") return false;
	const b = v as Partial<BenchmarkParameters>;
	return (
		typeof b.negativeSampleTarget === "number" &&
		typeof b.negativeSampleCollected === "number" &&
		typeof b.reviewBudgetK === "number" &&
		typeof b.reviewBudgetPerLands === "number" &&
		isNonEmptyString(b.rationale)
	);
}

export interface IncidentManifest {
	manifestVersion: number;
	generatedAt: string;
	/** Per-class count of REAL (`source: "manual"`, `expectedOutcome: "should-detect"` or
	 *  `"should-block-eventually"`) positives in `entries` — computed from the entries themselves by
	 *  `computePositiveCounts` and cross-checked against this declared value at load time, so the header
	 *  can never silently drift from what the entries actually contain. An entry claiming multiple
	 *  classes counts toward each. */
	positiveCounts: Record<TaxonomyClass, number>;
	benchmarkParameters: BenchmarkParameters;
	entries: ManifestEntry[];
	unpinnable: UnpinnableEntry[];
}

/** Counts real positives (`should-detect` + `should-block-eventually`) per taxonomy class across
 *  `entries` — `should-not-flag` negatives are deliberately excluded (they are not incidents an
 *  analyzer is expected to catch; counting them as "positives" would hide the honest n≈0 finding this
 *  concern exists to surface). */
export function computePositiveCounts(entries: readonly ManifestEntry[]): Record<TaxonomyClass, number> {
	const counts = Object.fromEntries(TAXONOMY_CLASSES.map((c) => [c, 0])) as Record<TaxonomyClass, number>;
	for (const entry of entries) {
		if (entry.expectedOutcome === "should-not-flag") continue;
		for (const cls of entry.taxonomyClasses) counts[cls] += 1;
	}
	return counts;
}

/** THROWS on any structurally invalid manifest, INCLUDING a `positiveCounts` header that doesn't match
 *  what `computePositiveCounts` derives from `entries` — the header is asserted data, not decoration. */
export function validateIncidentManifest(v: unknown): IncidentManifest {
	if (!v || typeof v !== "object") throw new Error(`incident-taxonomy: manifest is not an object: ${JSON.stringify(v)}`);
	const m = v as Partial<IncidentManifest>;
	if (typeof m.manifestVersion !== "number") throw new Error("incident-taxonomy: manifest.manifestVersion must be a number");
	if (!isNonEmptyString(m.generatedAt)) throw new Error("incident-taxonomy: manifest.generatedAt must be a non-empty string");
	if (!Array.isArray(m.entries)) throw new Error("incident-taxonomy: manifest.entries must be an array");
	const entries = m.entries.map((e) => validateManifestEntry(e));
	if (!Array.isArray(m.unpinnable)) throw new Error("incident-taxonomy: manifest.unpinnable must be an array");
	const unpinnable = m.unpinnable.map((e) => validateUnpinnableEntry(e));
	if (!isBenchmarkParameters(m.benchmarkParameters)) throw new Error("incident-taxonomy: manifest.benchmarkParameters is invalid");
	if (!m.positiveCounts || typeof m.positiveCounts !== "object") throw new Error("incident-taxonomy: manifest.positiveCounts must be an object");
	const declaredCounts = m.positiveCounts as Record<string, unknown>;
	for (const cls of TAXONOMY_CLASSES) {
		if (typeof declaredCounts[cls] !== "number") throw new Error(`incident-taxonomy: manifest.positiveCounts.${cls} must be a number`);
	}
	const computed = computePositiveCounts(entries);
	for (const cls of TAXONOMY_CLASSES) {
		if (declaredCounts[cls] !== computed[cls]) {
			throw new Error(
				`incident-taxonomy: manifest.positiveCounts.${cls} declares ${declaredCounts[cls]} but entries actually contain ${computed[cls]} — the header must match the data, never eyeballed`,
			);
		}
	}
	return { manifestVersion: m.manifestVersion, generatedAt: m.generatedAt, positiveCounts: computed, benchmarkParameters: m.benchmarkParameters, entries, unpinnable };
}

/** Reads + validates `incident-manifest.json` (defaults to the sibling file in this directory).
 *  THROWS on any I/O error, parse error, or validation failure — a manifest this replay methodology
 *  depends on being silently half-loaded would be worse than it failing loudly. */
export function loadIncidentManifest(filePath: string = path.join(import.meta.dir, "incident-manifest.json")): IncidentManifest {
	const raw = readFileSync(filePath, "utf8");
	const parsed = JSON.parse(raw) as unknown;
	return validateIncidentManifest(parsed);
}
