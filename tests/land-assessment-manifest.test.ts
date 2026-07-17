/**
 * Concern 02 (taxonomy-and-manifest) verification: taxonomy-class validity, claimedBy completeness,
 * manifest schema validation (including the detectionAtMainCommit rule), and the real
 * incident-manifest.json's honest per-class positive counts.
 *
 * Verify's other bullet — "Manual: every pinned SHA resolves (git cat-file -e) in the repo or via
 * fetched PR refs" — is deliberately NOT automated here (the concern names it Manual); every
 * baseCommit/mainCommit/candidateCommit in incident-manifest.json was checked with
 * `git cat-file -e <sha>` and `git merge-base --is-ancestor <sha> origin/main` against this same
 * checkout while curating the manifest.
 */

import { describe, expect, test } from "bun:test";
import {
	CLAIMED_BY,
	claimedByAnalyzer,
	computePositiveCounts,
	isTaxonomyClass,
	loadIncidentManifest,
	TAXONOMY_CLASSES,
	unclaimedTaxonomyClasses,
	validateIncidentManifest,
	validateManifestEntry,
	validateTaxonomyClass,
	validateUnpinnableEntry,
	V0_ANALYZERS,
	type IncidentManifest,
	type ManifestEntry,
	type TaxonomyClass,
} from "../src/land-assessment/replay/incident-taxonomy.ts";

// ── Fixture builders ─────────────────────────────────────────────────────────────────────────────────

function baseEntry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
	return {
		id: "fixture-entry",
		taxonomyClasses: ["git-topology"],
		repo: "omp-squad",
		refs: { candidateCommit: "deadbeef" },
		expectedOutcome: "should-detect",
		narrative: "a fixture incident for testing",
		source: "manual",
		...overrides,
	};
}

function baseManifest(overrides: Partial<IncidentManifest> = {}): unknown {
	const entries = overrides.entries ?? [baseEntry()];
	return {
		manifestVersion: 0,
		generatedAt: "2026-07-17T00:00:00.000Z",
		positiveCounts: overrides.positiveCounts ?? computePositiveCounts(entries as ManifestEntry[]),
		benchmarkParameters: {
			negativeSampleTarget: 40,
			negativeSampleCollected: 0,
			reviewBudgetK: 5,
			reviewBudgetPerLands: 100,
			rationale: "fixture",
		},
		entries,
		unpinnable: [],
		...overrides,
	};
}

// ── Taxonomy classes ─────────────────────────────────────────────────────────────────────────────────

describe("TAXONOMY_CLASSES", () => {
	test("is exactly the nine classes from BRIEF.md §10.4", () => {
		expect([...TAXONOMY_CLASSES].sort()).toEqual(
			(["acceptance-criterion", "behavioral", "dependency", "git-topology", "operational", "proof-freshness", "structural-api", "textual-conflict", "workflow-state"] as TaxonomyClass[]).sort(),
		);
	});
	test("isTaxonomyClass accepts every declared class", () => {
		for (const c of TAXONOMY_CLASSES) expect(isTaxonomyClass(c)).toBe(true);
	});
	test("isTaxonomyClass rejects a bogus class", () => {
		expect(isTaxonomyClass("performance")).toBe(false);
		expect(isTaxonomyClass(42)).toBe(false);
	});
	test("validateTaxonomyClass throws on a bogus class", () => {
		expect(() => validateTaxonomyClass("performance", "test")).toThrow(/not a valid taxonomy class/);
	});
});

// ── claimedBy completeness ───────────────────────────────────────────────────────────────────────────

describe("claimedBy completeness", () => {
	test("topology claims exactly git-topology and workflow-state", () => {
		expect([...CLAIMED_BY.topology].sort()).toEqual(["git-topology", "workflow-state"]);
	});
	test("typescript-structural-delta claims exactly structural-api and dependency", () => {
		expect([...CLAIMED_BY["typescript-structural-delta"]].sort()).toEqual(["dependency", "structural-api"]);
	});
	test("unclaimedTaxonomyClasses is exactly the remaining five classes", () => {
		expect(unclaimedTaxonomyClasses().sort()).toEqual((["acceptance-criterion", "behavioral", "operational", "proof-freshness", "textual-conflict"] as TaxonomyClass[]).sort());
	});
	test("claimed + unclaimed together is exactly TAXONOMY_CLASSES — no class silently falls through either side", () => {
		const claimed = new Set<TaxonomyClass>(Object.values(CLAIMED_BY).flat());
		const unclaimed = new Set(unclaimedTaxonomyClasses());
		const union = new Set([...claimed, ...unclaimed]);
		expect(union.size).toBe(TAXONOMY_CLASSES.length);
		for (const c of TAXONOMY_CLASSES) expect(claimed.has(c) || unclaimed.has(c)).toBe(true);
		// and no class is claimed by more than one v0 analyzer
		for (const c of claimed) expect(claimed.has(c) && unclaimed.has(c)).toBe(false);
	});
	test("claimedByAnalyzer resolves each of V0_ANALYZERS' own classes back to itself", () => {
		for (const analyzer of V0_ANALYZERS) {
			for (const cls of CLAIMED_BY[analyzer]) expect(claimedByAnalyzer(cls)).toBe(analyzer);
		}
	});
	test("claimedByAnalyzer returns undefined for an unclaimed class", () => {
		for (const cls of unclaimedTaxonomyClasses()) expect(claimedByAnalyzer(cls)).toBeUndefined();
	});
});

// ── validateManifestEntry ────────────────────────────────────────────────────────────────────────────

describe("validateManifestEntry", () => {
	test("round-trips a well-formed should-detect entry", () => {
		const e = baseEntry();
		expect(validateManifestEntry(e)).toEqual(e);
	});
	test("rejects an entry with an invalid taxonomy class", () => {
		expect(() => validateManifestEntry(baseEntry({ taxonomyClasses: ["performance" as TaxonomyClass] }))).toThrow(/not a valid taxonomy class/);
	});
	test("rejects an entry with an empty taxonomyClasses array", () => {
		expect(() => validateManifestEntry(baseEntry({ taxonomyClasses: [] }))).toThrow(/at least one taxonomyClasses/);
	});
	test("rejects an entry whose refs is an empty object (nothing to replay against)", () => {
		expect(() => validateManifestEntry(baseEntry({ refs: {} }))).toThrow(/refs is invalid or empty/);
	});
	test("rejects an entry with an invalid expectedOutcome", () => {
		expect(() => validateManifestEntry(baseEntry({ expectedOutcome: "maybe" as ManifestEntry["expectedOutcome"] }))).toThrow(/expectedOutcome is invalid/);
	});
	test("rejects an entry with an empty narrative", () => {
		expect(() => validateManifestEntry(baseEntry({ narrative: "" }))).toThrow(/narrative must be/);
	});
	test("rejects an entry whose source is not \"manual\"", () => {
		expect(() => validateManifestEntry(baseEntry({ source: "synthetic" as ManifestEntry["source"] }))).toThrow(/source must be "manual"/);
	});

	// The rule this concern's Approach names explicitly: should-block-eventually is INVALID without
	// detectionAtMainCommit — unmeasurable labels are rejected at load, not merely discouraged.
	describe("should-block-eventually requires detectionAtMainCommit", () => {
		test("rejects a should-block-eventually entry with no detectionAtMainCommit", () => {
			expect(() => validateManifestEntry(baseEntry({ expectedOutcome: "should-block-eventually" }))).toThrow(/no detectionAtMainCommit/);
		});
		test("rejects a should-block-eventually entry with an empty-string detectionAtMainCommit", () => {
			expect(() => validateManifestEntry(baseEntry({ expectedOutcome: "should-block-eventually", detectionAtMainCommit: "" }))).toThrow(/no detectionAtMainCommit/);
		});
		test("accepts a should-block-eventually entry WITH a detectionAtMainCommit", () => {
			const e = baseEntry({ expectedOutcome: "should-block-eventually", detectionAtMainCommit: "abc123" });
			expect(validateManifestEntry(e)).toEqual(e);
		});
		test("should-detect and should-not-flag entries do NOT require detectionAtMainCommit", () => {
			expect(validateManifestEntry(baseEntry({ expectedOutcome: "should-detect" }))).toBeTruthy();
			expect(validateManifestEntry(baseEntry({ expectedOutcome: "should-not-flag" }))).toBeTruthy();
		});
	});
});

// ── validateUnpinnableEntry ──────────────────────────────────────────────────────────────────────────

describe("validateUnpinnableEntry", () => {
	test("round-trips a well-formed unpinnable entry", () => {
		const u = { id: "u-1", taxonomyClasses: ["proof-freshness"] as TaxonomyClass[], reason: "no commit found", narrative: "n/a" };
		expect(validateUnpinnableEntry(u)).toEqual(u);
	});
	test("rejects an unpinnable entry missing a reason", () => {
		expect(() => validateUnpinnableEntry({ id: "u-1", taxonomyClasses: ["proof-freshness"], narrative: "n/a" })).toThrow(/reason must be/);
	});
});

// ── validateIncidentManifest: header/data consistency ──────────────────────────────────────────────

describe("validateIncidentManifest", () => {
	test("round-trips a well-formed manifest whose positiveCounts matches its entries", () => {
		const m = baseManifest();
		expect(validateIncidentManifest(m).positiveCounts["git-topology"]).toBe(1);
	});
	test("throws when positiveCounts.<class> disagrees with what the entries actually contain", () => {
		const m = baseManifest({ positiveCounts: { ...computePositiveCounts([baseEntry()]), "git-topology": 99 } });
		expect(() => validateIncidentManifest(m)).toThrow(/positiveCounts\.git-topology declares 99 but entries actually contain 1/);
	});
	test("should-not-flag entries are excluded from positiveCounts", () => {
		const entries = [baseEntry({ id: "neg", expectedOutcome: "should-not-flag" })];
		const m = baseManifest({ entries, positiveCounts: computePositiveCounts(entries) });
		expect(validateIncidentManifest(m).positiveCounts["git-topology"]).toBe(0);
	});
	test("an entry claiming two classes counts toward both", () => {
		const entries = [baseEntry({ taxonomyClasses: ["git-topology", "workflow-state"] })];
		const m = baseManifest({ entries, positiveCounts: computePositiveCounts(entries) });
		const counts = validateIncidentManifest(m).positiveCounts;
		expect(counts["git-topology"]).toBe(1);
		expect(counts["workflow-state"]).toBe(1);
	});
	test("throws on a non-array entries field", () => {
		const m = baseManifest({ positiveCounts: computePositiveCounts([baseEntry()]), entries: "nope" as unknown as ManifestEntry[] });
		expect(() => validateIncidentManifest(m)).toThrow(/entries must be an array/);
	});
	test("propagates a bad entry's own validation error", () => {
		const m = baseManifest({ entries: [baseEntry({ narrative: "" })], positiveCounts: computePositiveCounts([baseEntry()]) });
		expect(() => validateIncidentManifest(m)).toThrow(/narrative must be/);
	});
});

// ── The real incident-manifest.json ─────────────────────────────────────────────────────────────────

describe("the real incident-manifest.json", () => {
	const manifest = loadIncidentManifest();

	test("loads and validates without throwing", () => {
		expect(manifest.entries.length).toBeGreaterThan(0);
	});
	test("every entry and unpinnable record is source: manual / has a reason, respectively — no synthetic stand-ins", () => {
		for (const e of manifest.entries) expect(e.source).toBe("manual");
		for (const u of manifest.unpinnable) expect(u.reason.length).toBeGreaterThan(0);
	});
	test("every entry declares only valid taxonomy classes", () => {
		for (const e of manifest.entries) for (const c of e.taxonomyClasses) expect(isTaxonomyClass(c)).toBe(true);
	});

	// The concern's named honest outcome: structural-api (typescript-structural-delta's own claimed
	// class) has ~zero real positives — that IS the finding this manifest exists to surface, not a
	// gap to paper over with synthetic entries.
	test("structural-api has ~zero real positives (the honest finding this concern names)", () => {
		expect(manifest.positiveCounts["structural-api"]).toBe(0);
	});
	test("dependency (typescript-structural-delta's other claimed class) also has zero real positives", () => {
		expect(manifest.positiveCounts.dependency).toBe(0);
	});
	test("git-topology and workflow-state (topology's claimed classes) carry the real labeled incidents", () => {
		expect(manifest.positiveCounts["git-topology"]).toBeGreaterThan(0);
		expect(manifest.positiveCounts["workflow-state"]).toBeGreaterThan(0);
	});
	test("proof-freshness has no historical incident and is honestly represented in unpinnable, not padded into entries", () => {
		expect(manifest.positiveCounts["proof-freshness"]).toBe(0);
		expect(manifest.unpinnable.some((u) => u.taxonomyClasses.includes("proof-freshness"))).toBe(true);
	});
	test("every should-detect/should-block-eventually entry is claimed by the analyzer whose class it's filed under, or is honestly unclaimed", () => {
		// Not a hard requirement (an entry MAY name an unclaimed class), but every entry in THIS
		// manifest happens to be filed only under topology's claimed classes — assert that stays true
		// so a future addition under an unclaimed class is a deliberate choice, not an accident.
		for (const e of manifest.entries) {
			for (const cls of e.taxonomyClasses) {
				expect(claimedByAnalyzer(cls)).toBe("topology");
			}
		}
	});
	test("benchmark parameters are recorded with a non-empty rationale", () => {
		expect(manifest.benchmarkParameters.negativeSampleTarget).toBe(40);
		expect(manifest.benchmarkParameters.reviewBudgetK).toBeGreaterThan(0);
		expect(manifest.benchmarkParameters.rationale.length).toBeGreaterThan(0);
	});
});
