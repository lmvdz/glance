/**
 * Concern 10 (projection-contract-tests) verification, per its Verify section: the state-projection
 * litmus test as executable contract tests — the ADR.md Phase-1 gate ("executable state-projection
 * contract tests pass on a synthetic timeline ... BEFORE any live integration") — proven here, not
 * deferred to "after several hundred assessments".
 *
 * `synthetic-timeline.ts`'s `buildSyntheticTimeline()` (real git history + every corresponding
 * event/snapshot/observation/manifest record, written through the REAL store writer (concern 07) and
 * schema (concern 01)) runs exactly ONCE in `beforeAll`, below. Every litmus query in this file then
 * answers purely from what that build already persisted — `reconstructRepositoryStore`,
 * `readObservationBatch`, `readManifest`/`projectState`, `readContinuityRecord` — this file never calls
 * `extractStateFacts` on the fixture repo itself. That is the letter of the concern's Verify clause:
 * "no re-extraction of the fixture repo permitted inside the queries".
 *
 * Lives in `tests/`, not co-located under `src/land-assessment/` (the concern doc's literal TOUCHES
 * path for the `*.test.ts` file) — `bunfig.toml`'s `[test] root = "tests"`, the same deviation every
 * other land-assessment concern's test file follows (see `land-assessment-accepted-state.test.ts`'s own
 * doc comment for the precedent). `synthetic-timeline.ts` itself DOES live at its literal TOUCHES path
 * (`src/land-assessment/replay/synthetic-timeline.ts`) since it is real, reusable source, not a test.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { REASON_UNOBSERVED_TRANSITION, readContinuityRecord, repairContinuity } from "../src/land-assessment/continuity.ts";
import { readManifest } from "../src/land-assessment/manifest.ts";
import { projectState } from "../src/land-assessment/projection.ts";
import { buildSyntheticTimeline, diffSignatureChanges, foldRenames, readObservationBatch, type SyntheticTimelineFixture } from "../src/land-assessment/replay/synthetic-timeline.ts";
import type { SnapshotFact } from "../src/land-assessment/schema.ts";
import { reconstructRepositoryStore } from "../src/land-assessment/store-reader.ts";
import { __resetShardStateForTests } from "../src/land-assessment/store.ts";

// ── fixture: built ONCE, real git history + real store writes, exactly as the concern's Approach names ──

let stateDir: string;
let fixture: SyntheticTimelineFixture;

beforeAll(async () => {
	__resetShardStateForTests();
	stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "land-assessment-projection-contract-state-"));
	fixture = await buildSyntheticTimeline(stateDir);
});

afterAll(async () => {
	await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
	await fs.rm(fixture.repo, { recursive: true, force: true }).catch(() => {});
});

// ── litmus query 1: "What did A export?" (manifest + projection, zero re-extraction — exact hit) ──────

describe("litmus: What did A export?", () => {
	test("A's checkpoint manifest answers directly — a.foo, HAS_SIGNATURE '(): number'", async () => {
		const manifestA = await readManifest(stateDir, fixture.repositoryId, fixture.commits.A);
		expect(manifestA).toBeDefined();
		const fooEntity = manifestA!.entities.find((e) => e.locator.qualifiedName === "a.foo");
		expect(fooEntity).toBeDefined();
		const sig = manifestA!.facts.find((f) => f.factId === fooEntity!.factIds.find((id) => manifestA!.facts.some((ff) => ff.factId === id && ff.predicate === "HAS_SIGNATURE")));
		expect(sig?.object).toEqual({ kind: "signature", value: "(): number" });
	});

	test("projectState at exactly A is an exact hit — zero re-extraction (fallback undefined)", async () => {
		const projected = await projectState(stateDir, fixture.repo, fixture.repositoryId, fixture.states.A);
		expect(projected.fallback).toBeUndefined();
		expect(projected.entities.some((e) => e.locator.qualifiedName === "a.foo")).toBe(true);
	});
});

// ── litmus query 2: "What changed A→B?" (ChangeObservations, from the stored batch) ────────────────────

describe("litmus: What changed A -> B?", () => {
	test("attemptB's stored observation batch carries a 'modified' ChangeObservation for a.foo", async () => {
		const reconstructed = await reconstructRepositoryStore(stateDir, fixture.repositoryId);
		const attemptB = reconstructed.attempts.find((a) => a.attemptId === fixture.attempts.attemptB);
		expect(attemptB).toBeDefined();
		expect(attemptB!.terminal).toBe("landed");
		const snapshot = reconstructed.snapshotsByAssessmentKey.get(attemptB!.finalAssessmentKey!);
		expect(snapshot).toBeDefined();
		const batch = await readObservationBatch(stateDir, fixture.repositoryId, snapshot!.observationBatchRefs[0]!);
		expect(batch).toBeDefined();
		const change = batch!.changes.find((c) => c.subject.qualifiedName === "a.foo" && c.operation === "modified");
		expect(change).toBeDefined();
		expect(change!.before).toEqual({ kind: "signature", value: "(): number" });
		expect(change!.after).toEqual({ kind: "signature", value: "(): string" });
	});
});

// ── litmus query 3: "Was C ever accepted?" + "Which rejected attempt removed Foo?" ─────────────────────

describe("litmus: Was C ever accepted? Which rejected attempt removed Foo?", () => {
	test("C's attempt terminal is 'rejected' — NEVER landed", async () => {
		const reconstructed = await reconstructRepositoryStore(stateDir, fixture.repositoryId);
		const attemptC = reconstructed.attempts.find((a) => a.attemptId === fixture.attempts.attemptC);
		expect(attemptC).toBeDefined();
		expect(attemptC!.terminal).toBe("rejected");
		expect(attemptC!.terminal).not.toBe("landed");
	});

	test("the episodic query: which rejected attempt's observations show a.foo removed", async () => {
		const reconstructed = await reconstructRepositoryStore(stateDir, fixture.repositoryId);
		const rejected = reconstructed.attempts.filter((a) => a.terminal === "rejected");
		expect(rejected.length).toBeGreaterThan(0);
		let found: string | undefined;
		for (const attempt of rejected) {
			const snapshot = reconstructed.snapshotsByAssessmentKey.get(attempt.finalAssessmentKey!);
			if (!snapshot) continue;
			const batch = await readObservationBatch(stateDir, fixture.repositoryId, snapshot.observationBatchRefs[0]!);
			if (batch?.changes.some((c) => c.operation === "removed" && c.subject.qualifiedName === "a.foo")) {
				found = attempt.attemptId;
				break;
			}
		}
		expect(found).toBe(fixture.attempts.attemptC);

		// C's deterministic removal observation, plus its disposition finding (KnowledgeSemantics'
		// attemptDisposition axis), both remain queryable as counterfactual history — never discarded.
		const cSnapshot = reconstructed.snapshotsByAssessmentKey.get(reconstructed.attempts.find((a) => a.attemptId === fixture.attempts.attemptC)!.finalAssessmentKey!)!;
		const cBatch = await readObservationBatch(stateDir, fixture.repositoryId, cSnapshot.observationBatchRefs[0]!);
		expect(cBatch!.findings.some((f) => f.semantics.attemptDisposition === "rejected")).toBe(true);
	});
});

// ── litmus query 4: "Which landed result introduced Bar?" (C≠R transition edge) ────────────────────────

describe("litmus: Which landed result introduced Bar?", () => {
	test("attemptD's landed event resultCommit is R, not candidate D itself", async () => {
		const reconstructed = await reconstructRepositoryStore(stateDir, fixture.repositoryId);
		const attemptD = reconstructed.attempts.find((a) => a.attemptId === fixture.attempts.attemptD);
		expect(attemptD).toBeDefined();
		// attemptD's LAST terminal-stage event is "post-merge-verified" (it landed, then was verified) —
		// store-reader.ts's reconstruction takes the final terminal-stage event in store order, so this is
		// MORE informative than "landed", not a contradiction of it; the "landed" event is still present.
		expect(attemptD!.terminal).toBe("post-merge-verified");
		const landedEvent = attemptD!.events.find((e) => e.stage === "landed");
		expect(landedEvent?.resultCommit).toBe(fixture.commits.R);
		expect(landedEvent?.resultCommit).not.toBe(fixture.commits.D);
	});

	test("R's manifest (independently observed, stored) contains Bar; A's does not — B's landed result never introduces it either", async () => {
		const manifestA = await readManifest(stateDir, fixture.repositoryId, fixture.commits.A);
		const manifestR = await readManifest(stateDir, fixture.repositoryId, fixture.commits.R);
		expect(manifestA!.entities.some((e) => e.locator.qualifiedName === "a.bar")).toBe(false);
		expect(manifestR!.entities.some((e) => e.locator.qualifiedName === "a.bar")).toBe(true);

		// B's own landed result (fast-forward, R === candidate) never carries Bar — projected via the
		// stored checkpoint+delta path, still zero raw re-extraction inside this query.
		const projectedAtB = await projectState(stateDir, fixture.repo, fixture.repositoryId, fixture.states.B);
		expect(projectedAtB.entities.some((e) => e.locator.qualifiedName === "a.bar")).toBe(false);
	});
});

// ── litmus query 5 (F): "What did glance believe before D, and which observation superseded it?" ───────

describe("litmus: What did glance believe before D, and which observation superseded that belief?", () => {
	test("the inferred belief and its supersession are both stored on attemptD's observation batch", async () => {
		const reconstructed = await reconstructRepositoryStore(stateDir, fixture.repositoryId);
		const attemptD = reconstructed.attempts.find((a) => a.attemptId === fixture.attempts.attemptD);
		const snapshot = reconstructed.snapshotsByAssessmentKey.get(attemptD!.finalAssessmentKey!);
		const batch = await readObservationBatch(stateDir, fixture.repositoryId, snapshot!.observationBatchRefs[0]!);
		expect(batch).toBeDefined();

		const belief = batch!.findings.find((f) => f.semantics.authority === "inferred" && f.semantics.support === "supported");
		expect(belief).toBeDefined();
		expect(belief!.id).toBe(fixture.beliefFindingIds.inferred);

		const superseded = batch!.findings.find((f) => f.semantics.support === "superseded");
		expect(superseded).toBeDefined();
		expect(superseded!.id).toBe(fixture.beliefFindingIds.superseded);

		// The supersession is BY REFERENCE (SCHEMA-V0.md), never a mutation of the original record — both
		// findings coexist in the same append-only batch.
		const backRef = superseded!.evidence.find((e) => e.kind === "external-ref" && e.ref === belief!.id);
		expect(backRef).toBeDefined();

		// ...and it names WHICH observation superseded it: a deterministic EXPORTS fact for a.bar at R,
		// independently observed and stored in R's checkpoint manifest.
		const observationRef = superseded!.evidence.find((e) => e.kind === "external-ref" && e.ref !== belief!.id);
		expect(observationRef).toBeDefined();
		const manifestR = await readManifest(stateDir, fixture.repositoryId, fixture.commits.R);
		const supersedingFact = manifestR!.facts.find((f) => f.factId === (observationRef as { ref: string }).ref);
		expect(supersedingFact).toBeDefined();
		expect(supersedingFact!.predicate).toBe("EXPORTS");
		expect(supersedingFact!.subject.qualifiedName).toBe("a.bar");
		expect(supersedingFact!.authority).toBe("deterministic");
	});

	test("the landed rename observation itself carries rename evidence (identity is not silently asserted)", async () => {
		const reconstructed = await reconstructRepositoryStore(stateDir, fixture.repositoryId);
		const attemptD = reconstructed.attempts.find((a) => a.attemptId === fixture.attempts.attemptD);
		const snapshot = reconstructed.snapshotsByAssessmentKey.get(attemptD!.finalAssessmentKey!);
		const batch = await readObservationBatch(stateDir, fixture.repositoryId, snapshot!.observationBatchRefs[0]!);
		const renamed = batch!.changes.find((c) => c.operation === "renamed");
		expect(renamed).toBeDefined();
		expect(renamed!.subject.qualifiedName).toBe("a.bar");
		expect(renamed!.subject.renameEvidence).toEqual({ fromQualifiedName: "a.foo", fromPath: "a.ts", confidence: 0.9 });
	});
});

// ── litmus query 6 (E): "Does E flip continuity to unknown until reconciled?" ───────────────────────────

describe("litmus: Does E flip continuity to unknown until reconciled?", () => {
	test("the broken record is already durably stored — reading it back needs no recomputation", async () => {
		const stored = await readContinuityRecord(stateDir, fixture.repositoryId);
		expect(stored).toBeDefined();
		expect(stored!.status).toBe("unknown");
		expect(stored!.reason).toBe(REASON_UNOBSERVED_TRANSITION);
		expect(stored).toEqual(fixture.continuityBroken);
	});

	test("repairContinuity reconciles: re-checkpoints at E and flips status back to continuous", async () => {
		const before = await readManifest(stateDir, fixture.repositoryId, fixture.commits.E);
		expect(before).toBeUndefined(); // never checkpointed until repaired

		const { manifest, continuity } = await repairContinuity(stateDir, fixture.repo, fixture.states.E, fixture.producer);
		expect(manifest.state.commit).toBe(fixture.commits.E);
		expect(continuity.status).toBe("continuous");

		const after = await readManifest(stateDir, fixture.repositoryId, fixture.commits.E);
		expect(after).toEqual(manifest);
		// E's new consumer of Bar is now part of the accepted-state record.
		expect(after!.entities.some((e) => e.locator.qualifiedName === "consumer.useBar")).toBe(true);
	});
});

// ── the second-producer contract check (ADR.md's Phase-3 gate, testable now) ────────────────────────────

describe("second-producer contract check: verification-execution through the SAME schema types", () => {
	test("the mock verification-execution SnapshotFact round-trips through the SAME store, unmodified schema", async () => {
		const batch = await readObservationBatch(stateDir, fixture.repositoryId, fixture.batchRefs.verification);
		expect(batch).toBeDefined();
		expect(batch!.facts).toHaveLength(1);
		const fact = batch!.facts[0]!;
		expect(fact.factId).toBe(fixture.verificationFactId);
		expect(fact.predicate).toBe("VERIFIED_BY");
		expect(fact.authority).toBe("deterministic");
		expect(fact.state.commit).toBe(fixture.commits.R);
		expect(fact.object.kind).toBe("json");
		expect((fact.object as { kind: "json"; value: { command: string; result: string; coveredEntities: string[] } }).value.result).toBe("pass");
	});

	test("attemptD's post-merge-verified event references the verification batch — same LandAttemptEvent stage, no redesign", async () => {
		const reconstructed = await reconstructRepositoryStore(stateDir, fixture.repositoryId);
		const attemptD = reconstructed.attempts.find((a) => a.attemptId === fixture.attempts.attemptD);
		const verifiedEvent = attemptD!.events.find((e) => e.stage === "post-merge-verified");
		expect(verifiedEvent).toBeDefined();
		expect(verifiedEvent!.evidence.some((e) => e.kind === "external-ref" && e.ref === fixture.batchRefs.verification)).toBe(true);
	});
});

// ── unit coverage for synthetic-timeline.ts's own pure helpers ──────────────────────────────────────────

describe("diffSignatureChanges / foldRenames (synthetic-timeline.ts's diff layer)", () => {
	const producer = { name: "unit-test", version: "0.1.0" };
	function sigFact(state: SnapshotFact["state"], qualifiedName: string, path: string, signature: string): SnapshotFact {
		return {
			factId: `${path}:${qualifiedName}:${signature}`,
			state,
			subject: { qualifiedName, path, kind: "function" },
			predicate: "HAS_SIGNATURE",
			object: { kind: "signature", value: signature },
			authority: "deterministic",
			observedAt: new Date().toISOString(),
			producer,
			evidence: [],
		};
	}
	const s1 = { repositoryId: "repo", commit: "c1", tree: "t1" };
	const s2 = { repositoryId: "repo", commit: "c2", tree: "t2" };

	test("detects added/removed/modified independently", () => {
		const from = [sigFact(s1, "a.foo", "a.ts", "(): number"), sigFact(s1, "a.stable", "a.ts", "(): void")];
		const to = [sigFact(s2, "a.foo", "a.ts", "(): string"), sigFact(s2, "a.stable", "a.ts", "(): void"), sigFact(s2, "a.newOne", "a.ts", "(): boolean")];
		const changes = diffSignatureChanges(s1, s2, from, to, producer);
		expect(changes).toHaveLength(2); // stable is unchanged, never emitted
		expect(changes.find((c) => c.subject.qualifiedName === "a.foo")?.operation).toBe("modified");
		expect(changes.find((c) => c.subject.qualifiedName === "a.newOne")?.operation).toBe("added");
	});

	test("folds a same-signature remove+add pair at the same path into 'renamed'", () => {
		const from = [sigFact(s1, "a.foo", "a.ts", "(): string")];
		const to = [sigFact(s2, "a.bar", "a.ts", "(): string")];
		const changes = diffSignatureChanges(s1, s2, from, to, producer);
		expect(changes).toHaveLength(2); // pre-fold: one removed, one added

		const folded = foldRenames(changes);
		expect(folded).toHaveLength(1);
		expect(folded[0]!.operation).toBe("renamed");
		expect(folded[0]!.subject.qualifiedName).toBe("a.bar");
		expect(folded[0]!.subject.renameEvidence?.fromQualifiedName).toBe("a.foo");
	});

	test("does NOT fold a remove+add pair with different signatures — genuinely unrelated", () => {
		const from = [sigFact(s1, "a.foo", "a.ts", "(): string")];
		const to = [sigFact(s2, "a.unrelated", "a.ts", "(): boolean")];
		const changes = diffSignatureChanges(s1, s2, from, to, producer);
		const folded = foldRenames(changes);
		expect(folded).toHaveLength(2);
		expect(folded.every((c) => c.operation !== "renamed")).toBe(true);
	});
});

