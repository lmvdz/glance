/**
 * Synthetic scripted-timeline fixture (concern 10, `plans/land-assessment/10-projection-contract-tests.md`)
 * — the state-projection litmus test's fixture builder. `buildSyntheticTimeline()` produces REAL git
 * history in a throwaway repo exercising every epistemic seam ADR.md's Phase-1 gate names:
 *
 * ```text
 * A: module exports Foo
 * B: Foo signature changes (accepted landing)
 * C: candidate removes Foo — REJECTED
 * D: candidate renames Foo → Bar — LANDED (R differs from C: squash)
 * E: main gains a new consumer of Bar (external transition — not through glance)
 * F: an earlier inferred belief is superseded by a deterministic observation
 * ```
 *
 * Every durable record this module writes goes through the REAL production machinery, never
 * hand-rolled bytes: `LandAttemptEvent`/`LandAssessmentSnapshot` through `store.ts`'s
 * `appendLandAttemptEvent`/`appendLandAssessmentSnapshot` (concern 07); `RepositoryManifest`/
 * `ContinuityRecord` through `manifest.ts`/`continuity.ts` (concern 11); every shape validated
 * through `schema.ts`'s `validate*` guards (concern 01) before it ever touches disk; `SnapshotFact`s
 * for A/B/C/D/R are genuinely produced by `extractStateFacts` (concern 04) over the fixture's own git
 * blobs, never hand-typed — this fixture's git history is the ONLY thing scripted, everything derived
 * from it goes through the real analyzer.
 *
 * `ChangeObservation`/`AssessmentFinding` have no store of their own in this codebase yet — 07's store
 * only knows `LandAttemptEvent`/`LandAssessmentSnapshot`, and `LandAssessmentSnapshot.observationBatchRefs`/
 * `findingRefs` are (by SCHEMA-V0.md's own design) opaque `string[]` pointers with no producer wired up
 * anywhere before this concern. `writeObservationBatch`/`readObservationBatch` below are this module's
 * own minimal, honest answer: one atomic JSON file per content-addressed batch (same
 * `getStorageBackend().writeDurable` atomic-temp-rename primitive `manifest.ts`/`continuity.ts` already
 * use, same per-repo shard directory convention as `store.ts`'s `repoHash16`), keyed by `id.ts`'s own
 * `computeOutputHash` — the SAME canonicalized-content hash `LandAssessmentSnapshot.outputHash` already
 * uses, reused rather than re-derived. Every element is validated on write AND on read
 * (validate-on-read, this subsystem's standing discipline). This is scoped to this concern's fixture
 * needs; it is not a claim that Phase 2 will persist observation batches this way.
 *
 * The litmus queries in `tests/land-assessment-projection-contract.test.ts` read ONLY through this
 * durable trail (`reconstructRepositoryStore`, `readObservationBatch`, `readManifest`/`projectState`,
 * `readContinuityRecord`) — never by calling `extractStateFacts` a second time on the fixture repo. This
 * module performs every extraction exactly ONCE, at fixture-build time; the queries then prove the
 * accumulated data answers the litmus questions from storage alone.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getStorageBackend } from "../../dal/storage.ts";
import { errText } from "../../err-text.ts";
import { git } from "../analyzers/plugin.ts";
import { extractStateFacts, structuralDeltaEnvironmentFingerprint } from "../analyzers/typescript-structural-delta.ts";
import { checkContinuity, writeContinuityRecord } from "../continuity.ts";
import { computeAssessmentKey, computeEventId, computeOutputHash, computeRepositoryId, mintAttemptId } from "../id.ts";
import { extractManifest, writeManifest } from "../manifest.ts";
import {
	SCHEMA_VERSION,
	validateAssessmentFinding,
	validateChangeObservation,
	validateLandAssessmentSnapshot,
	validateLandAttemptEvent,
	validateSnapshotFact,
} from "../schema.ts";
import type {
	AnalysisEnvironmentFingerprint,
	AssessmentFinding,
	ChangeObservation,
	ContinuityRecord,
	EvidencePointer,
	FactValue,
	LandAssessmentSnapshot,
	LandAttemptEvent,
	ProducerRef,
	RepositoryStateRef,
	SnapshotFact,
} from "../schema.ts";
import { appendLandAssessmentSnapshot, appendLandAttemptEvent, repoHash16 } from "../store.ts";

/** Distinct from the real analyzer's own `PRODUCER` (`typescript-structural-delta.ts`, not exported):
 *  every record THIS module derives (diffs, findings, the mock verification fact) is honestly
 *  attributed to the fixture, never laundered as real-analyzer output. Facts pulled straight from
 *  `extractStateFacts` keep THEIR OWN producer unchanged. */
export const FIXTURE_PRODUCER: ProducerRef = { name: "land-assessment-synthetic-timeline-fixture", version: "0.1.0" };

// ── git fixture builders (real git, hardened — same `git()` boundary every analyzer routes through) ───

async function initRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "land-assessment-synthetic-timeline-"));
	await git(["init", "-q", "-b", "main"], repo);
	await git(["config", "user.email", "fixture@land-assessment.test"], repo);
	await git(["config", "user.name", "land-assessment-synthetic-timeline"], repo);
	await git(["config", "commit.gpgsign", "false"], repo);
	return repo;
}

async function writeFiles(repo: string, files: Record<string, string>): Promise<void> {
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(repo, rel);
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, content);
	}
}

async function commitFiles(repo: string, files: Record<string, string>, message: string): Promise<string> {
	await writeFiles(repo, files);
	await git(["add", "-A"], repo);
	await git(["commit", "-q", "-m", message], repo);
	return (await git(["rev-parse", "HEAD"], repo)).stdout;
}

async function removeAndCommit(repo: string, relPaths: string[], message: string): Promise<string> {
	await git(["rm", "-q", ...relPaths], repo);
	await git(["commit", "-q", "-m", message], repo);
	return (await git(["rev-parse", "HEAD"], repo)).stdout;
}

async function stateRefFor(repo: string, commit: string): Promise<RepositoryStateRef> {
	const repositoryId = computeRepositoryId(repo);
	const tree = await git(["rev-parse", `${commit}^{tree}`], repo);
	return { repositoryId, commit, tree: tree.stdout };
}

// ── ChangeObservation derivation (this fixture's own diff layer — see module doc) ──────────────────────

/**
 * `ChangeObservation` (SCHEMA-V0.md) carries no `predicate` field — it is scoped to ONE entity's
 * before/after shape, not a per-predicate delta. This fixture derives observations from the `HAS_SIGNATURE`
 * facts only (the entity's shape, the most semantically meaningful single value to carry as before/after);
 * `EXPORTS`'s signature-hash is redundant with it. Keyed by `(path, qualifiedName)` — an entry present on
 * only one side is `added`/`removed`; present on both with a different signature is `modified`.
 * @substrate `buildSyntheticTimeline` (same file) is the one production caller — same-file calls don't
 * count as a reference (dead-exports.ts's own scan excludes them); a co-located test consumer is not a
 * real reference either (dead-exports.ts's own carve-out). Exported so a future replay/analyzer consumer
 * that needs a generic signature-diff doesn't have to re-derive one.
 */
export function diffSignatureChanges(fromState: RepositoryStateRef, toState: RepositoryStateRef, factsFrom: readonly SnapshotFact[], factsTo: readonly SnapshotFact[], producer: ProducerRef): ChangeObservation[] {
	const keyOf = (f: SnapshotFact) => `${f.subject.path}\0${f.subject.qualifiedName}`;
	const from = new Map(factsFrom.filter((f) => f.predicate === "HAS_SIGNATURE").map((f) => [keyOf(f), f]));
	const to = new Map(factsTo.filter((f) => f.predicate === "HAS_SIGNATURE").map((f) => [keyOf(f), f]));
	const observedAt = new Date().toISOString();
	const stableId = (operation: string, key: string) => createHash("sha1").update(`change\0${operation}\0${fromState.commit}\0${toState.commit}\0${key}`).digest("hex").slice(0, 20);
	const out: ChangeObservation[] = [];
	for (const [key, f] of from) {
		const t = to.get(key);
		if (!t) {
			out.push(
				validateChangeObservation({
					observationId: stableId("removed", key),
					fromState,
					toState,
					subject: f.subject,
					operation: "removed",
					before: f.object,
					observedAt,
					producer,
					evidence: f.evidence,
				}),
			);
		} else if (JSON.stringify(f.object) !== JSON.stringify(t.object)) {
			out.push(
				validateChangeObservation({
					observationId: stableId("modified", key),
					fromState,
					toState,
					subject: t.subject,
					operation: "modified",
					before: f.object,
					after: t.object,
					observedAt,
					producer,
					evidence: t.evidence,
				}),
			);
		}
	}
	for (const [key, t] of to) {
		if (from.has(key)) continue;
		out.push(
			validateChangeObservation({
				observationId: stableId("added", key),
				fromState,
				toState,
				subject: t.subject,
				operation: "added",
				after: t.object,
				observedAt,
				producer,
				evidence: t.evidence,
			}),
		);
	}
	return out;
}

/**
 * Folds a `removed`+`added` pair at the SAME path with an IDENTICAL signature value into one `renamed`
 * observation, carrying `EntityLocator.renameEvidence` (SCHEMA-V0.md: identity is not a full stable-id
 * solver — rename evidence attaches, it is never silently asserted). An unequal-signature pair (a
 * genuine unrelated remove+add) is left as two separate observations.
 * @substrate `buildSyntheticTimeline` (same file) is the one production caller — same-file calls don't
 * count as a reference (dead-exports.ts's own scan excludes them); a co-located test consumer is not a
 * real reference either (dead-exports.ts's own carve-out).
 */
export function foldRenames(observations: readonly ChangeObservation[], confidence = 0.9): ChangeObservation[] {
	const removed = observations.filter((o) => o.operation === "removed");
	const added = observations.filter((o) => o.operation === "added");
	const rest = observations.filter((o) => o.operation !== "removed" && o.operation !== "added");
	const usedAdded = new Set<ChangeObservation>();
	const folded: ChangeObservation[] = [];
	const leftoverRemoved: ChangeObservation[] = [];
	for (const r of removed) {
		const match = added.find((a) => !usedAdded.has(a) && a.subject.path === r.subject.path && JSON.stringify(a.after) === JSON.stringify(r.before));
		if (!match) {
			leftoverRemoved.push(r);
			continue;
		}
		usedAdded.add(match);
		folded.push(
			validateChangeObservation({
				observationId: createHash("sha1").update(`change\0renamed\0${r.fromState.commit}\0${r.toState.commit}\0${r.subject.path}\0${r.subject.qualifiedName}->${match.subject.qualifiedName}`).digest("hex").slice(0, 20),
				fromState: r.fromState,
				toState: r.toState,
				subject: { ...match.subject, renameEvidence: { fromQualifiedName: r.subject.qualifiedName, fromPath: r.subject.path, confidence } },
				operation: "renamed",
				before: r.before,
				after: match.after,
				observedAt: match.observedAt,
				producer: match.producer,
				evidence: match.evidence,
			}),
		);
	}
	const leftoverAdded = added.filter((a) => !usedAdded.has(a));
	return [...rest, ...leftoverRemoved, ...leftoverAdded, ...folded];
}

// ── observation-batch persistence (this fixture's own store — see module doc) ──────────────────────────

export interface ObservationBatch {
	batchRef: string;
	facts: SnapshotFact[];
	changes: ChangeObservation[];
	findings: AssessmentFinding[];
}

function observationBatchFilePath(stateDir: string, repositoryId: string, batchRef: string): string {
	return path.join(stateDir, "land-assessment", repoHash16(repositoryId), "observation-batches", `batch-${batchRef}.json`);
}

function validateObservationBatch(v: unknown): ObservationBatch {
	if (!v || typeof v !== "object") throw new Error(`land-assessment synthetic-timeline: ObservationBatch is not an object: ${JSON.stringify(v)}`);
	const b = v as Partial<ObservationBatch>;
	if (typeof b.batchRef !== "string" || b.batchRef.length === 0) throw new Error("land-assessment synthetic-timeline: ObservationBatch.batchRef must be a non-empty string");
	if (!Array.isArray(b.facts)) throw new Error("land-assessment synthetic-timeline: ObservationBatch.facts must be an array");
	for (const f of b.facts) validateSnapshotFact(f);
	if (!Array.isArray(b.changes)) throw new Error("land-assessment synthetic-timeline: ObservationBatch.changes must be an array");
	for (const c of b.changes) validateChangeObservation(c);
	if (!Array.isArray(b.findings)) throw new Error("land-assessment synthetic-timeline: ObservationBatch.findings must be an array");
	for (const finding of b.findings) validateAssessmentFinding(finding);
	return b as ObservationBatch;
}

/** Validates every element, computes the batch's content-addressed ref via `id.ts#computeOutputHash`
 *  (the SAME canonicalization `LandAssessmentSnapshot.outputHash` uses), and writes it atomically.
 *  Returns the `batchRef` a `LandAssessmentSnapshot.observationBatchRefs` entry points at.
 *  @substrate `buildSyntheticTimeline` (same file) is the one production caller — same-file calls don't
 *  count as a reference (dead-exports.ts's own scan excludes them); a co-located test consumer is not a
 *  real reference either (dead-exports.ts's own carve-out). */
export async function writeObservationBatch(stateDir: string, repositoryId: string, batch: { facts: SnapshotFact[]; changes: ChangeObservation[]; findings: AssessmentFinding[] }): Promise<string> {
	for (const f of batch.facts) validateSnapshotFact(f);
	for (const c of batch.changes) validateChangeObservation(c);
	for (const finding of batch.findings) validateAssessmentFinding(finding);
	const batchRef = computeOutputHash([...batch.facts, ...batch.changes], batch.findings);
	const full: ObservationBatch = { batchRef, facts: batch.facts, changes: batch.changes, findings: batch.findings };
	await getStorageBackend().writeDurable(observationBatchFilePath(stateDir, repositoryId, batchRef), JSON.stringify(full));
	return batchRef;
}

/** `undefined` when no batch was ever written at this ref — the legitimate never-written case. THROWS
 *  (validate-on-read) on a corrupt/torn file, mirroring `manifest.ts#readManifest`.
 *  @substrate exported for tests only — `readObservationBatch` is `writeObservationBatch`'s read-side
 *  counterpart with no production caller yet; a co-located test consumer is not a real reference
 *  (dead-exports.ts's own carve-out). */
export async function readObservationBatch(stateDir: string, repositoryId: string, batchRef: string): Promise<ObservationBatch | undefined> {
	const file = observationBatchFilePath(stateDir, repositoryId, batchRef);
	const text = await getStorageBackend().readText(file);
	if (!text) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw new Error(`land-assessment synthetic-timeline: ${file} unparseable (possibly torn): ${errText(err)}`);
	}
	return validateObservationBatch(parsed);
}

// ── the second-producer contract check (ADR.md's Phase-3 gate, testable now) ───────────────────────────

/**
 * A mock verification-execution observation — test command, exact commit/tree (via `state`), observed
 * result, covered entities — through the SAME `SnapshotFact` shape every structural-delta fact uses,
 * per SCHEMA-V0.md's "Second-producer contract requirement". `state` supplies the exact commit/tree
 * addressing; `object.kind: "json"` is the deliberate escape hatch (schema.ts's own doc on `FactValue`)
 * carrying the command/result/coveredEntities payload — no new field, no schema change.
 * @substrate `buildSyntheticTimeline` (same file) is the one production caller — same-file calls don't
 * count as a reference (dead-exports.ts's own scan excludes them); a co-located test consumer is not a
 * real reference either (dead-exports.ts's own carve-out). A real verification-execution producer
 * (ADR.md's Phase-3 second-producer gate) is a future caller of this exact pattern, not this function
 * itself.
 */
export function buildVerificationExecutionFact(state: RepositoryStateRef, coveredFactId: string, command: string, producer: ProducerRef): SnapshotFact {
	const value: FactValue = { kind: "json", value: { command, result: "pass", coveredEntities: [coveredFactId] } };
	return validateSnapshotFact({
		factId: createHash("sha1").update(`verification-execution\0${state.commit}\0${command}`).digest("hex").slice(0, 20),
		state,
		subject: { qualifiedName: "verification:bun-test", path: "tests/synthetic-fixture-marker.test.ts", kind: "verification-run" },
		predicate: "VERIFIED_BY",
		object: value,
		authority: "deterministic",
		observedAt: new Date().toISOString(),
		producer,
		evidence: [
			{ kind: "commit", repositoryId: state.repositoryId, commit: state.commit },
			{ kind: "external-ref", ref: coveredFactId, detail: "SnapshotFact covered by this verification-execution run — second-producer contract check (SCHEMA-V0.md)" },
		],
	});
}

// ── attempt recording (through the REAL store writer, concern 07) ──────────────────────────────────────

function mkEvent(args: {
	attemptId: string;
	repositoryId: string;
	seq: number;
	stage: LandAttemptEvent["stage"];
	assessmentKey?: string;
	resultCommit?: string;
	resultTree?: string;
	reason?: { code: string; detail: string };
	evidence: EvidencePointer[];
}): LandAttemptEvent {
	return validateLandAttemptEvent({
		schemaVersion: SCHEMA_VERSION,
		eventId: computeEventId(args.attemptId, args.seq),
		attemptId: args.attemptId,
		repositoryId: args.repositoryId,
		seq: args.seq,
		stage: args.stage,
		assessmentKey: args.assessmentKey,
		resultCommit: args.resultCommit,
		resultTree: args.resultTree,
		reason: args.reason,
		refs: {},
		criteria: { declaredCriterionRefs: [], impactStatus: "not-evaluated" },
		observedAt: new Date().toISOString(),
		evidence: args.evidence,
	});
}

async function requireWritten(outcome: string, ctx: string): Promise<void> {
	if (outcome !== "written") throw new Error(`land-assessment synthetic-timeline: append returned "${outcome}" for ${ctx} — fixture requires a clean write`);
}

interface AttemptRecipe {
	attemptId: string;
	repositoryId: string;
	base: RepositoryStateRef;
	target: RepositoryStateRef;
	candidate: RepositoryStateRef;
	environment: AnalysisEnvironmentFingerprint;
	facts: SnapshotFact[];
	changes: ChangeObservation[];
	findings: AssessmentFinding[];
	coverage: LandAssessmentSnapshot["coverage"];
	terminal: { stage: "landed"; resultCommit: string; resultTree: string } | { stage: "rejected"; reason: { code: string; detail: string } };
}

interface AttemptOutcome {
	assessmentKey: string;
	batchRef: string;
	/** Next free per-attempt `seq` — a caller that needs to append MORE events for the same attempt
	 *  (e.g. this fixture's own `post-merge-verified` event for attemptD) continues from here. */
	nextSeq: number;
}

/** Writes one attempt's full lifecycle — `attempt-started` → `assessment-attached` → terminal — through
 *  `store.ts`'s real `appendLandAttemptEvent`/`appendLandAssessmentSnapshot` (concern 07), with its
 *  observations/findings persisted via `writeObservationBatch` above. Every record validated before
 *  append (schema.ts, concern 01). */
async function recordAttempt(stateDir: string, recipe: AttemptRecipe): Promise<AttemptOutcome> {
	const assessmentKey = computeAssessmentKey({ base: recipe.base, target: recipe.target, candidate: recipe.candidate }, recipe.environment);
	const batchRef = await writeObservationBatch(stateDir, recipe.repositoryId, { facts: recipe.facts, changes: recipe.changes, findings: recipe.findings });
	const outputHash = computeOutputHash([...recipe.facts, ...recipe.changes], recipe.findings);
	const analysisRunId = createHash("sha1").update(`${assessmentKey}\0run`).digest("hex").slice(0, 20);

	const snapshot = validateLandAssessmentSnapshot({
		schemaVersion: SCHEMA_VERSION,
		assessmentKey,
		analysisRunId,
		state: { base: recipe.base, target: recipe.target, candidate: recipe.candidate },
		environment: recipe.environment,
		observationBatchRefs: [batchRef],
		findingRefs: recipe.findings.map((f) => f.id),
		coverage: recipe.coverage,
		outputHash,
		createdAt: new Date().toISOString(),
	});
	await requireWritten(await appendLandAssessmentSnapshot(stateDir, snapshot), `snapshot ${assessmentKey}`);

	const evidence: EvidencePointer[] = [{ kind: "commit", repositoryId: recipe.repositoryId, commit: recipe.candidate.commit }];
	let seq = 0;
	await requireWritten(
		await appendLandAttemptEvent(stateDir, mkEvent({ attemptId: recipe.attemptId, repositoryId: recipe.repositoryId, seq: seq++, stage: "attempt-started", evidence })),
		`attempt-started ${recipe.attemptId}`,
	);
	await requireWritten(
		await appendLandAttemptEvent(stateDir, mkEvent({ attemptId: recipe.attemptId, repositoryId: recipe.repositoryId, seq: seq++, stage: "assessment-attached", assessmentKey, evidence })),
		`assessment-attached ${recipe.attemptId}`,
	);
	const terminalEvent =
		recipe.terminal.stage === "landed"
			? mkEvent({ attemptId: recipe.attemptId, repositoryId: recipe.repositoryId, seq: seq++, stage: "landed", assessmentKey, resultCommit: recipe.terminal.resultCommit, resultTree: recipe.terminal.resultTree, evidence })
			: mkEvent({ attemptId: recipe.attemptId, repositoryId: recipe.repositoryId, seq: seq++, stage: "rejected", assessmentKey, reason: recipe.terminal.reason, evidence });
	await requireWritten(await appendLandAttemptEvent(stateDir, terminalEvent), `terminal ${recipe.terminal.stage} ${recipe.attemptId}`);

	return { assessmentKey, batchRef, nextSeq: seq };
}

// ── the scripted timeline itself ────────────────────────────────────────────────────────────────────

export interface SyntheticTimelineFixture {
	repo: string;
	repositoryId: string;
	commits: { A: string; B: string; C: string; D: string; R: string; E: string };
	states: { A: RepositoryStateRef; B: RepositoryStateRef; C: RepositoryStateRef; D: RepositoryStateRef; R: RepositoryStateRef; E: RepositoryStateRef };
	/** attemptId per landing operation — B and D landed (D's resultCommit is R, NOT D itself); C was rejected. */
	attempts: { attemptB: string; attemptC: string; attemptD: string };
	assessmentKeys: { forB: string; forC: string; forD: string };
	batchRefs: { forB: string; forC: string; forD: string; verification: string };
	/** F: the inferred belief written for candidate D, and the later record that supersedes it — both
	 *  live in `batchRefs.forD`'s `findings`. */
	beliefFindingIds: { inferred: string; superseded: string };
	/** The mock verification-execution `SnapshotFact.factId`, stored in `batchRefs.verification`. */
	verificationFactId: string;
	/** E's continuity break, ALREADY written to disk (`readContinuityRecord` reads it back) — a test
	 *  that wants to prove reconciliation calls `repairContinuity` itself against `states.E`. */
	continuityBroken: ContinuityRecord;
	producer: ProducerRef;
}

/**
 * Build the full scripted timeline (A–F) as real git history plus every corresponding durable record,
 * exactly once. `stateDir` is a fresh, caller-owned state directory (mirrors every other concern's own
 * `freshStateDir()` test convention) — this function performs ALL extraction/hashing/persistence; no
 * litmus query in the test file needs to touch the fixture's git repo again.
 * @substrate exported for tests only — `tests/land-assessment-projection-contract.test.ts` is the one
 * caller today; a co-located test consumer is not a real reference (dead-exports.ts's own carve-out).
 */
export async function buildSyntheticTimeline(stateDir: string): Promise<SyntheticTimelineFixture> {
	const repo = await initRepo();
	const repositoryId = computeRepositoryId(repo);
	const environment = structuralDeltaEnvironmentFingerprint();

	// A: module exports Foo — the accepted-state checkpoint anchor (concern 11).
	const commitA = await commitFiles(repo, { "a.ts": "export function foo(): number { return 1; }\n" }, "A: module exports Foo");
	const stateA = await stateRefFor(repo, commitA);
	const extractionA = await extractStateFacts(stateA);
	await writeManifest(stateDir, await extractManifest(stateA, FIXTURE_PRODUCER));

	// B: Foo signature changes — accepted landing, fast-forward (R == candidate, no squash).
	const commitB = await commitFiles(repo, { "a.ts": "export function foo(): string { return '1'; }\n" }, "B: Foo signature changes (accepted landing)");
	const stateB = await stateRefFor(repo, commitB);
	const extractionB = await extractStateFacts(stateB);
	const attemptB = mintAttemptId(stateDir, repo, "main", commitB);
	const changesAB = diffSignatureChanges(stateA, stateB, extractionA.facts, extractionB.facts, FIXTURE_PRODUCER);
	const outcomeB = await recordAttempt(stateDir, {
		attemptId: attemptB,
		repositoryId,
		base: stateA,
		target: stateA,
		candidate: stateB,
		environment,
		facts: extractionB.facts,
		changes: changesAB,
		findings: [],
		coverage: extractionB.coverage,
		terminal: { stage: "landed", resultCommit: commitB, resultTree: stateB.tree },
	});

	// C: candidate removes Foo — proposed against B, REJECTED, never merged.
	await git(["checkout", "-q", "-b", "candidate-c"], repo);
	const commitC = await removeAndCommit(repo, ["a.ts"], "C: candidate removes Foo (rejected)");
	const stateC = await stateRefFor(repo, commitC);
	const extractionC = await extractStateFacts(stateC);
	await git(["checkout", "-q", "main"], repo);
	const attemptC = mintAttemptId(stateDir, repo, "candidate-c", commitC);
	const changesBC = diffSignatureChanges(stateB, stateC, extractionB.facts, extractionC.facts, FIXTURE_PRODUCER);
	const removedFoo = changesBC.find((c) => c.operation === "removed" && c.subject.qualifiedName === "a.foo");
	if (!removedFoo) throw new Error("land-assessment synthetic-timeline: expected candidate C's diff to remove a.foo");
	const dispositionFinding = validateAssessmentFinding({
		id: "c-rejected-disposition",
		kind: "attempt-disposition",
		statement: "candidate C (removing a.ts's sole export foo) was rejected — its deterministic removal observation remains queryable as counterfactual history, never promoted to accepted state",
		semantics: { authority: "derived", support: "supported", stateRole: "candidate", attemptDisposition: "rejected" },
		coverage: { dimension: "syntax", covered: 1, total: 1, gaps: [] },
		derivedFromObservations: [removedFoo.observationId],
		evidence: [{ kind: "commit", repositoryId, commit: commitC }],
		producer: FIXTURE_PRODUCER,
	});
	const outcomeC = await recordAttempt(stateDir, {
		attemptId: attemptC,
		repositoryId,
		base: stateB,
		target: stateB,
		candidate: stateC,
		environment,
		facts: extractionC.facts,
		changes: changesBC,
		findings: [dispositionFinding],
		coverage: extractionC.coverage,
		terminal: { stage: "rejected", reason: { code: "REMOVES_ACCEPTED_EXPORT", detail: "candidate removes a.ts's sole export foo, which accepted main still exposes" } },
	});

	// D: candidate renames Foo -> Bar, proposed against B.
	await git(["checkout", "-q", "-b", "candidate-d"], repo);
	const commitD = await commitFiles(repo, { "a.ts": "export function bar(): string { return '1'; }\n" }, "D: candidate renames Foo to Bar");
	const stateD = await stateRefFor(repo, commitD);
	const extractionD = await extractStateFacts(stateD);
	await git(["checkout", "-q", "main"], repo);

	// R: the actually-landed squash result of D — differs from D (an extra `bonus` export from
	// conflict-resolution/squash), per SCHEMA-V0.md's C != R rule. Committed directly on main.
	const commitR = await commitFiles(
		repo,
		{ "a.ts": "export function bar(): string { return '1'; }\nexport function bonus(): boolean { return true; }\n" },
		"R: squash-landed result of D (differs from D — adds bonus)",
	);
	const stateR = await stateRefFor(repo, commitR);
	const manifestR = await extractManifest(stateR, FIXTURE_PRODUCER);
	await writeManifest(stateDir, manifestR);
	const barExportFact = manifestR.facts.find((f) => f.predicate === "EXPORTS" && f.subject.qualifiedName === "a.bar");
	if (!barExportFact) throw new Error("land-assessment synthetic-timeline: expected R's manifest to contain an EXPORTS fact for a.bar");

	// F: an earlier inferred belief (written for candidate D, before landing) superseded by a
	// deterministic observation (R's independently-observed EXPORTS fact for a.bar).
	const inferredBelief = validateAssessmentFinding({
		id: "belief-bar-relationship-to-foo",
		kind: "rename-heuristic",
		statement: "candidate D's diff renames a.ts's sole export; a same-file/same-signature heuristic suggests bar is a rename of foo, unconfirmed pending independent verification of the landed result",
		semantics: { authority: "inferred", support: "supported", stateRole: "candidate" },
		coverage: { dimension: "syntax", covered: 1, total: 1, gaps: [] },
		derivedFromObservations: [],
		evidence: [{ kind: "commit-file", repositoryId, commit: commitD, path: "a.ts" }],
		producer: FIXTURE_PRODUCER,
	});
	const supersededBelief = validateAssessmentFinding({
		id: "belief-bar-relationship-to-foo-superseded",
		kind: "rename-heuristic",
		statement: "candidate D's diff renames a.ts's sole export; the earlier heuristic belief is now superseded by a deterministic EXPORTS observation of a.bar at the independently-observed landed result R",
		semantics: { authority: "inferred", support: "superseded", stateRole: "candidate" },
		coverage: { dimension: "syntax", covered: 1, total: 1, gaps: [] },
		derivedFromObservations: [],
		evidence: [
			{ kind: "external-ref", ref: inferredBelief.id, detail: "supersedes the earlier inferred belief" },
			{ kind: "external-ref", ref: barExportFact.factId, detail: "superseded by this deterministic EXPORTS observation of a.bar at R" },
		],
		producer: FIXTURE_PRODUCER,
	});
	const changesBD = foldRenames(diffSignatureChanges(stateB, stateD, extractionB.facts, extractionD.facts, FIXTURE_PRODUCER));
	const attemptD = mintAttemptId(stateDir, repo, "candidate-d", commitD);
	const outcomeD = await recordAttempt(stateDir, {
		attemptId: attemptD,
		repositoryId,
		base: stateB,
		target: stateB,
		candidate: stateD,
		environment,
		facts: extractionD.facts,
		changes: changesBD,
		findings: [inferredBelief, supersededBelief],
		coverage: extractionD.coverage,
		terminal: { stage: "landed", resultCommit: commitR, resultTree: stateR.tree },
	});

	// Second-producer contract check (ADR.md's Phase-3 gate, testable now): a mock verification-execution
	// observation through the SAME SnapshotFact type, recorded as attemptD's post-merge-verified event.
	const verificationFact = buildVerificationExecutionFact(stateR, barExportFact.factId, "bun test tests/synthetic-fixture-marker.test.ts", FIXTURE_PRODUCER);
	const verificationBatchRef = await writeObservationBatch(stateDir, repositoryId, { facts: [verificationFact], changes: [], findings: [] });
	await requireWritten(
		await appendLandAttemptEvent(
			stateDir,
			mkEvent({
				attemptId: attemptD,
				repositoryId,
				seq: outcomeD.nextSeq,
				stage: "post-merge-verified",
				evidence: [
					{ kind: "commit", repositoryId, commit: commitR },
					{ kind: "external-ref", ref: verificationBatchRef, detail: `ObservationBatch containing SnapshotFact ${verificationFact.factId} — second-producer (verification-execution) contract check, same schema types, no redesign` },
				],
			}),
		),
		`post-merge-verified ${attemptD}`,
	);

	// E: main gains a new consumer of Bar — landed DIRECTLY on main, never through any LandAttemptEvent.
	const commitE = await commitFiles(repo, { "consumer.ts": "import { bar } from './a';\nexport function useBar(): string { return bar(); }\n" }, "E: main gains a new consumer of Bar (external, not through glance)");
	const stateE = await stateRefFor(repo, commitE);
	const continuityBroken = await checkContinuity(repo, stateR, stateE, new Set());
	await writeContinuityRecord(stateDir, continuityBroken);

	return {
		repo,
		repositoryId,
		commits: { A: commitA, B: commitB, C: commitC, D: commitD, R: commitR, E: commitE },
		states: { A: stateA, B: stateB, C: stateC, D: stateD, R: stateR, E: stateE },
		attempts: { attemptB, attemptC, attemptD },
		assessmentKeys: { forB: outcomeB.assessmentKey, forC: outcomeC.assessmentKey, forD: outcomeD.assessmentKey },
		batchRefs: { forB: outcomeB.batchRef, forC: outcomeC.batchRef, forD: outcomeD.batchRef, verification: verificationBatchRef },
		beliefFindingIds: { inferred: inferredBelief.id, superseded: supersededBelief.id },
		verificationFactId: verificationFact.factId,
		continuityBroken,
		producer: FIXTURE_PRODUCER,
	};
}
