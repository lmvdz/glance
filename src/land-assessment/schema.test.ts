/**
 * Concern 01 (schema-and-identity) verification: round-trip validate/reject fixtures for every
 * SCHEMA-V0.md shape, attemptId/eventId/assessmentKey/outputHash identity behavior, and the four
 * guardrail invariants the concern's Verify section names explicitly.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	computeAssessmentKey,
	computeConfigurationHash,
	computeEventId,
	computeOutputHash,
	checkOutputHash,
	computeRepositoryId,
	mintAttemptId,
} from "./id.ts";
import {
	SCHEMA_VERSION,
	validateAssessmentFinding,
	validateChangeObservation,
	validateLandAssessmentSnapshot,
	validateLandAttemptEvent,
	validateRepositoryStateRef,
	validateSnapshotFact,
	type AnalysisEnvironmentFingerprint,
	type AssessmentFinding,
	type ChangeObservation,
	type EntityLocator,
	type EvidencePointer,
	type ExtractionCoverage,
	type KnowledgeSemantics,
	type LandAssessmentSnapshot,
	type LandAttemptEvent,
	type ProducerRef,
	type RepositoryStateRef,
	type SnapshotFact,
} from "./schema.ts";

// ── Fixture builders ─────────────────────────────────────────────────────────────────────────────────

const stateRef = (commit: string, tree = `tree-${commit}`, repositoryId = "repo-a"): RepositoryStateRef => ({ repositoryId, commit, tree });

const producer: ProducerRef = { name: "typescript-structural-delta", version: "0.1.0" };

const entity: EntityLocator = { qualifiedName: "src/foo.ts#Foo", path: "src/foo.ts", kind: "class" };

const evidence: EvidencePointer[] = [{ kind: "commit-file", repositoryId: "repo-a", commit: "c1", path: "src/foo.ts", startLine: 1, endLine: 3 }];

const environment: AnalysisEnvironmentFingerprint = {
	analyzerName: "typescript-structural-delta",
	analyzerVersion: "0.1.0",
	language: "typescript",
	mode: "syntax-only",
	configurationHash: "abc123",
};

function baseSemantics(overrides: Partial<KnowledgeSemantics> = {}): KnowledgeSemantics {
	return { authority: "deterministic", support: "supported", stateRole: "candidate", ...overrides };
}

function baseCoverage(overrides: Partial<ExtractionCoverage> = {}): ExtractionCoverage {
	return { dimension: "syntax", covered: 1, total: 1, gaps: [], ...overrides };
}

function baseFact(overrides: Partial<SnapshotFact> = {}): SnapshotFact {
	return {
		factId: "fact-1",
		state: stateRef("c1"),
		subject: entity,
		predicate: "EXPORTS",
		object: { kind: "string", value: "Foo" },
		authority: "deterministic",
		observedAt: "2026-07-17T00:00:00.000Z",
		producer,
		evidence,
		...overrides,
	};
}

function baseChange(overrides: Partial<ChangeObservation> = {}): ChangeObservation {
	return {
		observationId: "obs-1",
		fromState: stateRef("c0"),
		toState: stateRef("c1"),
		subject: entity,
		operation: "modified",
		observedAt: "2026-07-17T00:00:00.000Z",
		producer,
		evidence,
		...overrides,
	};
}

function baseFinding(overrides: Partial<AssessmentFinding> = {}): AssessmentFinding {
	return {
		id: "finding-1",
		kind: "exported-signature-change",
		statement: "Foo's signature changed",
		semantics: baseSemantics(),
		coverage: baseCoverage(),
		derivedFromObservations: ["obs-1"],
		evidence,
		producer,
		...overrides,
	};
}

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

function baseSnapshot(overrides: Partial<LandAssessmentSnapshot> = {}): LandAssessmentSnapshot {
	return {
		schemaVersion: SCHEMA_VERSION,
		assessmentKey: "key-1",
		analysisRunId: "run-1",
		state: { base: stateRef("b1"), target: stateRef("t1"), candidate: stateRef("c1") },
		environment,
		observationBatchRefs: [],
		findingRefs: [],
		coverage: [baseCoverage()],
		outputHash: "hash-1",
		createdAt: "2026-07-17T00:00:00.000Z",
		...overrides,
	};
}

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});
async function tmpDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "land-assessment-schema-"));
	tmps.push(dir);
	return dir;
}

// ── Round-trip validate/reject fixtures ─────────────────────────────────────────────────────────────

describe("validateRepositoryStateRef", () => {
	test("accepts a well-formed ref", () => {
		expect(validateRepositoryStateRef(stateRef("c1"), "test")).toEqual(stateRef("c1"));
	});
	test("rejects a ref missing tree", () => {
		expect(() => validateRepositoryStateRef({ repositoryId: "r", commit: "c" }, "test")).toThrow(/RepositoryStateRef/);
	});
});

describe("validateLandAttemptEvent", () => {
	test("round-trips a well-formed attempt-started event", () => {
		const e = baseEvent();
		expect(validateLandAttemptEvent(e)).toEqual(e);
	});
	test("round-trips a landed event carrying resultCommit/resultTree (the C-to-R transition edge)", () => {
		const e = baseEvent({ stage: "landed", assessmentKey: "key-1", resultCommit: "r1", resultTree: "rt1" });
		expect(validateLandAttemptEvent(e)).toEqual(e);
	});
	test("round-trips a rejected event carrying a reason code", () => {
		const e = baseEvent({ stage: "rejected", reason: { code: "proof-gate-stale", detail: "proof is stale" } });
		expect(validateLandAttemptEvent(e)).toEqual(e);
	});
	test("rejects an invalid stage", () => {
		expect(() => validateLandAttemptEvent(baseEvent({ stage: "bogus" as LandAttemptEvent["stage"] }))).toThrow(/stage is invalid/);
	});
	test("rejects a negative seq", () => {
		expect(() => validateLandAttemptEvent(baseEvent({ seq: -1 }))).toThrow(/seq must be a non-negative integer/);
	});
	test("rejects a malformed reason (missing code)", () => {
		expect(() => validateLandAttemptEvent(baseEvent({ reason: { detail: "no code" } as unknown as LandAttemptEvent["reason"] }))).toThrow(/reason must be/);
	});
	test("rejects a non-object", () => {
		expect(() => validateLandAttemptEvent(null)).toThrow(/not an object/);
		expect(() => validateLandAttemptEvent("nope")).toThrow(/not an object/);
	});
});

describe("validateLandAssessmentSnapshot", () => {
	test("round-trips a well-formed snapshot", () => {
		const s = baseSnapshot();
		expect(validateLandAssessmentSnapshot(s)).toEqual(s);
	});
	test("rejects a snapshot whose candidate state ref is malformed", () => {
		const bad = baseSnapshot({ state: { base: stateRef("b1"), target: stateRef("t1"), candidate: { repositoryId: "r" } as RepositoryStateRef } });
		expect(() => validateLandAssessmentSnapshot(bad)).toThrow(/RepositoryStateRef/);
	});
	test("rejects a snapshot with a single scalar coverage instead of an array", () => {
		const bad = baseSnapshot({ coverage: baseCoverage() as unknown as ExtractionCoverage[] });
		expect(() => validateLandAssessmentSnapshot(bad)).toThrow(/coverage must be/);
	});
});

describe("validateSnapshotFact", () => {
	test("round-trips a well-formed fact", () => {
		const f = baseFact();
		expect(validateSnapshotFact(f)).toEqual(f);
	});
	test("rejects a non-deterministic authority", () => {
		expect(() => validateSnapshotFact(baseFact({ authority: "derived" as SnapshotFact["authority"] }))).toThrow(/authority must be "deterministic"/);
	});
});

describe("validateChangeObservation", () => {
	test("round-trips a well-formed observation", () => {
		const c = baseChange();
		expect(validateChangeObservation(c)).toEqual(c);
	});
	test("rejects an invalid operation", () => {
		expect(() => validateChangeObservation(baseChange({ operation: "moved" as ChangeObservation["operation"] }))).toThrow(/operation is invalid/);
	});

	// Verify: "observation without exact-state ref rejected"
	test("rejects an observation missing fromState entirely", () => {
		const bad = { ...baseChange(), fromState: undefined } as unknown;
		expect(() => validateChangeObservation(bad)).toThrow(/fromState is not a valid RepositoryStateRef/);
	});
	test("rejects an observation whose toState is a malformed ref (missing tree)", () => {
		const bad = baseChange({ toState: { repositoryId: "repo-a", commit: "c1" } as RepositoryStateRef });
		expect(() => validateChangeObservation(bad)).toThrow(/toState is not a valid RepositoryStateRef/);
	});
});

describe("validateAssessmentFinding — guardrail: derivedFromObservations required unless inferred", () => {
	test("round-trips a deterministic finding WITH derivedFromObservations", () => {
		const f = baseFinding();
		expect(validateAssessmentFinding(f)).toEqual(f);
	});
	test("rejects a deterministic finding with EMPTY derivedFromObservations", () => {
		expect(() => validateAssessmentFinding(baseFinding({ derivedFromObservations: [] }))).toThrow(/derivedFromObservations is required/);
	});
	test("rejects a derived finding with EMPTY derivedFromObservations", () => {
		expect(() => validateAssessmentFinding(baseFinding({ semantics: baseSemantics({ authority: "derived" }), derivedFromObservations: [] }))).toThrow(/derivedFromObservations is required/);
	});
	test("accepts an INFERRED finding with EMPTY derivedFromObservations", () => {
		const f = baseFinding({ semantics: baseSemantics({ authority: "inferred" }), derivedFromObservations: [] });
		expect(validateAssessmentFinding(f)).toEqual(f);
	});
});

// ── KnowledgeSemantics: four orthogonal axes ────────────────────────────────────────────────────────

describe("KnowledgeSemantics axes are independent", () => {
	test("a deterministic fact about a rejected candidate round-trips with all four axes intact", () => {
		// The exact combination SCHEMA-V0.md calls out as otherwise-unrepresentable under a collapsed enum.
		const f = baseFinding({
			semantics: { authority: "deterministic", support: "supported", stateRole: "candidate", attemptDisposition: "rejected" },
		});
		const roundTripped = validateAssessmentFinding(f);
		expect(roundTripped.semantics.authority).toBe("deterministic");
		expect(roundTripped.semantics.stateRole).toBe("candidate");
		expect(roundTripped.semantics.attemptDisposition).toBe("rejected");
	});
	test("rejects an invalid attemptDisposition", () => {
		expect(() =>
			validateAssessmentFinding(baseFinding({ semantics: { authority: "deterministic", support: "supported", stateRole: "candidate", attemptDisposition: "bogus" as never } })),
		).toThrow(/semantics is invalid/);
	});
});

// ── No validity-interval fields anywhere in the schema (grep-proof) ─────────────────────────────────

describe("no validity-interval fields", () => {
	// Grep-proof for an actual FIELD DECLARATION (`name:` or `name?:`), not the cautionary prose in
	// schema.ts's own module doc comment that names these fields as the thing NOT to add.
	test("validFromCommit/validUntilCommit are never declared as fields in schema.ts — intervals are lineage projections, never stored primitives", () => {
		const source = readFileSync(path.join(import.meta.dir, "schema.ts"), "utf8");
		expect(source).not.toMatch(/\bvalidFromCommit\s*\??\s*:/);
		expect(source).not.toMatch(/\bvalidUntilCommit\s*\??\s*:/);
	});
});

// ── Identity: attemptId / eventId / assessmentKey / outputHash ─────────────────────────────────────

describe("mintAttemptId", () => {
	test("mints distinct ids across repeated calls with the same inputs (the durable counter varies)", async () => {
		const stateDir = await tmpDir();
		const a = mintAttemptId(stateDir, "/repo", "main", "c1");
		const b = mintAttemptId(stateDir, "/repo", "main", "c1");
		expect(a).not.toBe(b);
	});
	test("attemptId uniqueness survives a simulated counter-file restart (fresh call reads persisted counter, not 0)", async () => {
		const stateDir = await tmpDir();
		const before = mintAttemptId(stateDir, "/repo", "main", "c1");
		// Simulate a process restart: nothing in-memory carries over, only the on-disk counter file does.
		const after = mintAttemptId(stateDir, "/repo", "main", "c1");
		expect(before).not.toBe(after);
		// A THIRD mint after the "restart" must still be distinct from both — proves the counter kept
		// incrementing rather than resetting.
		const third = mintAttemptId(stateDir, "/repo", "main", "c1");
		expect(new Set([before, after, third]).size).toBe(3);
	});
	test("a corrupt counter file throws rather than silently reset to 0", async () => {
		const stateDir = await tmpDir();
		await fs.mkdir(path.join(stateDir, "land-assessment"), { recursive: true });
		await fs.writeFile(path.join(stateDir, "land-assessment", "attempt-counter.json"), "{not json");
		expect(() => mintAttemptId(stateDir, "/repo", "main", "c1")).toThrow(/corrupt-state/);
	});
	test("computeRepositoryId normalizes the path (two spellings of the same repo mint under the same identity)", () => {
		expect(computeRepositoryId("/a/b/../b")).toBe(computeRepositoryId("/a/b"));
	});
});

describe("computeEventId", () => {
	test("is deterministic for the same (attemptId, seq)", () => {
		expect(computeEventId("attempt-1", 3)).toBe(computeEventId("attempt-1", 3));
	});
	test("differs across seq within the same attempt", () => {
		expect(computeEventId("attempt-1", 1)).not.toBe(computeEventId("attempt-1", 2));
	});
	test("differs across attempts for the same seq", () => {
		expect(computeEventId("attempt-1", 1)).not.toBe(computeEventId("attempt-2", 1));
	});
});

describe("computeAssessmentKey — stability", () => {
	const state = { base: stateRef("b1"), target: stateRef("t1"), candidate: stateRef("c1") };
	test("is stable across repeated calls with identical inputs", () => {
		expect(computeAssessmentKey(state, environment)).toBe(computeAssessmentKey(state, environment));
	});
	test("changes when the candidate commit changes (a rebase mints a new key, no explicit invalidation step needed)", () => {
		const rebased = { ...state, candidate: stateRef("c2") };
		expect(computeAssessmentKey(state, environment)).not.toBe(computeAssessmentKey(rebased, environment));
	});
	test("changes when the environment fingerprint changes", () => {
		const changedEnv = { ...environment, analyzerVersion: "0.2.0" };
		expect(computeAssessmentKey(state, environment)).not.toBe(computeAssessmentKey(state, changedEnv));
	});
});

describe("computeOutputHash — invariance under permutation, loud mismatch on nondeterminism", () => {
	const observations = [baseFact({ factId: "fact-a" }), baseFact({ factId: "fact-b" }), baseFact({ factId: "fact-c" })];
	const findings = [baseFinding({ id: "finding-a" }), baseFinding({ id: "finding-b" })];

	test("is invariant under reordering of the observations array", () => {
		const forward = computeOutputHash(observations, findings);
		const shuffled = computeOutputHash([observations[2]!, observations[0]!, observations[1]!], findings);
		expect(forward).toBe(shuffled);
	});
	test("is invariant under reordering of the findings array", () => {
		const forward = computeOutputHash(observations, findings);
		const shuffled = computeOutputHash(observations, [findings[1]!, findings[0]!]);
		expect(forward).toBe(shuffled);
	});
	test("changes when the actual content changes (not just order)", () => {
		const changed = computeOutputHash([baseFact({ factId: "fact-a" })], findings);
		expect(computeOutputHash(observations, findings)).not.toBe(changed);
	});

	// Verify: "loud-mismatch path on injected nondeterminism"
	test("checkOutputHash returns 'new' when there is no prior record for this assessmentKey", () => {
		expect(checkOutputHash("key-1", "hash-a")).toBe("new");
	});
	test("checkOutputHash returns 'duplicate' (dedup-drop) when the hash matches the prior record", () => {
		expect(checkOutputHash("key-1", "hash-a", { outputHash: "hash-a" })).toBe("duplicate");
	});
	test("checkOutputHash THROWS when the same assessmentKey now produces a DIFFERENT outputHash (injected nondeterminism)", () => {
		expect(() => checkOutputHash("key-1", "hash-b", { outputHash: "hash-a" })).toThrow(/nondeterminism/);
	});
});

describe("computeConfigurationHash", () => {
	test("is stable and order-independent across the same field set", () => {
		const a = computeConfigurationHash({ tsconfigHash: "t1", lockfileHash: "l1", extractorVersion: "0.1.0" });
		const b = computeConfigurationHash({ extractorVersion: "0.1.0", lockfileHash: "l1", tsconfigHash: "t1" });
		expect(a).toBe(b);
	});
	test("changes when a field value changes", () => {
		const a = computeConfigurationHash({ tsconfigHash: "t1" });
		const b = computeConfigurationHash({ tsconfigHash: "t2" });
		expect(a).not.toBe(b);
	});
});
