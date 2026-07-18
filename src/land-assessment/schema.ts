/**
 * Land Assessment / Temporal Substrate — Schema v0 types + validate-on-read guards.
 *
 * This module is a direct TypeScript transcription of `plans/land-assessment/SCHEMA-V0.md` — the
 * single NORMATIVE source for record semantics. Where anything here and that doc disagree, the doc
 * wins; if you are changing a shape, change the doc first. See `plans/land-assessment/ADR.md` for
 * the decision this schema implements.
 *
 * Two integrity assumptions run through every shape below, and are restated at each site they bite:
 *   1. Single-daemon checkout ownership — one daemon process owns a given repo's worktree/state-dir
 *      at a time (mirrors `state-lock.ts`'s existing invariant); these records are not designed to
 *      survive two daemons writing the same repository concurrently.
 *   2. The assessed tree is C, the CANDIDATE — never the merge/rebase/squash result that actually
 *      lands. `RepositoryStateRef.candidate` in a snapshot is always C. Accepted state is derived only
 *      from an independent observation of R (the `landed` event's `resultCommit`/`resultTree`) — see
 *      the C≠R rule below `LandAttemptEvent`.
 *
 * Append-only, always: nothing here is ever updated in place. A later record supersedes an earlier
 * one by reference (`support: "superseded"`, `previousAssessmentKey`), never by mutation. Validity
 * INTERVALS (`validFromCommit`/`validUntilCommit` or similar) are deliberately absent from every shape
 * in this file — Git is a DAG, not a timeline, so an interval is a lineage PROJECTION computed at read
 * time (see concern 11's `projection.ts`), never a stored primitive. If you find yourself adding an
 * interval field here, stop — that is exactly the drift SCHEMA-V0.md rules out.
 */

// ── Exact-state addressing ──────────────────────────────────────────────────────────────────────────

/** Addresses one exact repository state — a commit and its tree, scoped to a repository identity.
 *  `repositoryId` is the caller's stable identity for the repo (concern 08 derives it via
 *  `id.ts#computeRepositoryId`, i.e. `path.resolve` of the local checkout — the land-lock key fix). */
export interface RepositoryStateRef {
	repositoryId: string;
	commit: string;
	tree: string;
}

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.length > 0;
}

function isRepositoryStateRef(v: unknown): v is RepositoryStateRef {
	if (!v || typeof v !== "object") return false;
	const r = v as Partial<RepositoryStateRef>;
	return isNonEmptyString(r.repositoryId) && isNonEmptyString(r.commit) && isNonEmptyString(r.tree);
}

/** THROWS when `v` is not a well-formed `RepositoryStateRef` — every observation/event below is
 *  addressed to an exact state; a ref missing repositoryId/commit/tree is not a legitimate state, it
 *  is a corrupt record (mirrors `baseline-tracker.ts`'s corrupt-vs-missing discipline: absent data is
 *  a different case, callers decide that before reaching in here).
 *  @substrate Phase-0 producer (concern 01) with no external caller yet -- land()/analyzers/replay projection wire it up in concerns 03-11 (plans/land-assessment); a co-located test consumer is not a real reference (dead-exports.ts's own carve-out). */
export function validateRepositoryStateRef(v: unknown, context: string): RepositoryStateRef {
	if (!isRepositoryStateRef(v)) throw new Error(`land-assessment schema: ${context} is not a valid RepositoryStateRef: ${JSON.stringify(v)}`);
	return v;
}

// ── Provenance, evidence, entities, values ──────────────────────────────────────────────────────────

/** Who/what produced a durable record — name + version, so a later re-run under a changed analyzer
 *  is distinguishable from the original without redesigning the record. */
export interface ProducerRef {
	name: string;
	version: string;
}

function isProducerRef(v: unknown): v is ProducerRef {
	if (!v || typeof v !== "object") return false;
	const p = v as Partial<ProducerRef>;
	return isNonEmptyString(p.name) && isNonEmptyString(p.version);
}

/**
 * A pointer INTO evidence for a fact/finding/event — never the evidence copied inline (that would
 * make records unbounded and stale the instant the pointed-at commit is gc'd, which is exactly what
 * temp-ref pinning in the hook (concern 08) exists to prevent). Three kinds:
 *   - `commit-file`: one file at one commit (optionally a line range within it).
 *   - `commit`: the commit object itself is the evidence (e.g. topology/ancestry claims).
 *   - `external-ref`: anything outside this repository's git history — a PR/ticket/ledger id, a URL.
 */
export type EvidencePointer =
	| { kind: "commit-file"; repositoryId: string; commit: string; path: string; startLine?: number; endLine?: number }
	| { kind: "commit"; repositoryId: string; commit: string }
	| { kind: "external-ref"; ref: string; detail?: string };

function isEvidencePointer(v: unknown): v is EvidencePointer {
	if (!v || typeof v !== "object") return false;
	const e = v as { kind?: unknown };
	if (e.kind === "commit-file") {
		const p = v as { repositoryId?: unknown; commit?: unknown; path?: unknown; startLine?: unknown; endLine?: unknown };
		return (
			isNonEmptyString(p.repositoryId) &&
			isNonEmptyString(p.commit) &&
			isNonEmptyString(p.path) &&
			(p.startLine === undefined || typeof p.startLine === "number") &&
			(p.endLine === undefined || typeof p.endLine === "number")
		);
	}
	if (e.kind === "commit") {
		const p = v as { repositoryId?: unknown; commit?: unknown };
		return isNonEmptyString(p.repositoryId) && isNonEmptyString(p.commit);
	}
	if (e.kind === "external-ref") {
		const p = v as { ref?: unknown; detail?: unknown };
		return isNonEmptyString(p.ref) && (p.detail === undefined || typeof p.detail === "string");
	}
	return false;
}

function isEvidencePointerArray(v: unknown): v is EvidencePointer[] {
	return Array.isArray(v) && v.every(isEvidencePointer);
}

/**
 * Locates one entity (symbol/module) a fact or observation is about — qualified name + file path +
 * kind. Identity is NOT a full stable-identity solver (that's an explicit non-goal — ADR.md/BRIEF §6):
 * `renameEvidence` carries the analyzer's best evidence for a rename rather than silently asserting
 * continuity, and `identityUncertain` represents the analyzer admitting it isn't sure this locator and
 * some other one are the same entity across states, rather than collapsing that uncertainty away.
 */
export interface EntityLocator {
	qualifiedName: string;
	path: string;
	kind: string;
	renameEvidence?: { fromQualifiedName: string; fromPath: string; confidence: number };
	identityUncertain?: boolean;
}

function isEntityLocator(v: unknown): v is EntityLocator {
	if (!v || typeof v !== "object") return false;
	const e = v as Partial<EntityLocator>;
	if (!isNonEmptyString(e.qualifiedName) || !isNonEmptyString(e.path) || !isNonEmptyString(e.kind)) return false;
	if (e.renameEvidence !== undefined) {
		const r = e.renameEvidence as Partial<NonNullable<EntityLocator["renameEvidence"]>>;
		if (!r || typeof r !== "object" || !isNonEmptyString(r.fromQualifiedName) || !isNonEmptyString(r.fromPath) || typeof r.confidence !== "number") return false;
	}
	if (e.identityUncertain !== undefined && typeof e.identityUncertain !== "boolean") return false;
	return true;
}

/** The `object`/`before`/`after` value carried by a fact or a change — a small closed set of shapes so
 *  canonicalization (for `outputHash`) never has to guess a value's structure. `json` is the deliberate
 *  escape hatch for anything not yet worth its own variant; prefer a typed variant when one fits. */
export type FactValue =
	| { kind: "string"; value: string }
	| { kind: "string-list"; value: string[] }
	| { kind: "signature"; value: string }
	| { kind: "entity-ref"; value: EntityLocator }
	| { kind: "boolean"; value: boolean }
	| { kind: "json"; value: unknown };

function isFactValue(v: unknown): v is FactValue {
	if (!v || typeof v !== "object") return false;
	const f = v as { kind?: unknown; value?: unknown };
	switch (f.kind) {
		case "string":
		case "signature":
			return typeof f.value === "string";
		case "string-list":
			return Array.isArray(f.value) && f.value.every((x) => typeof x === "string");
		case "entity-ref":
			return isEntityLocator(f.value);
		case "boolean":
			return typeof f.value === "boolean";
		case "json":
			return "value" in f;
		default:
			return false;
	}
}

// ── Knowledge semantics — four orthogonal axes, never one enum ─────────────────────────────────────

export type KnowledgeAuthority = "deterministic" | "derived" | "inferred" | "operator";
export type KnowledgeSupport = "supported" | "disputed" | "unknown" | "superseded";
export type KnowledgeStateRole = "base" | "target" | "candidate" | "result" | "counterfactual";
export type AttemptDisposition = "pending" | "landed" | "rejected" | "invalidated" | "rolled-back";

/** Four axes that MUST stay independent (SCHEMA-V0.md): collapsing them into one status enum makes
 *  "a deterministic fact about a rejected candidate" unrepresentable — see the round-trip test in
 *  `schema.test.ts` that pins exactly that combination. */
export interface KnowledgeSemantics {
	authority: KnowledgeAuthority;
	support: KnowledgeSupport;
	stateRole: KnowledgeStateRole;
	attemptDisposition?: AttemptDisposition;
}

const AUTHORITIES: ReadonlySet<KnowledgeAuthority> = new Set(["deterministic", "derived", "inferred", "operator"]);
const SUPPORTS: ReadonlySet<KnowledgeSupport> = new Set(["supported", "disputed", "unknown", "superseded"]);
const STATE_ROLES: ReadonlySet<KnowledgeStateRole> = new Set(["base", "target", "candidate", "result", "counterfactual"]);
const ATTEMPT_DISPOSITIONS: ReadonlySet<AttemptDisposition> = new Set(["pending", "landed", "rejected", "invalidated", "rolled-back"]);

function isKnowledgeSemantics(v: unknown): v is KnowledgeSemantics {
	if (!v || typeof v !== "object") return false;
	const k = v as Partial<KnowledgeSemantics>;
	if (!AUTHORITIES.has(k.authority as KnowledgeAuthority)) return false;
	if (!SUPPORTS.has(k.support as KnowledgeSupport)) return false;
	if (!STATE_ROLES.has(k.stateRole as KnowledgeStateRole)) return false;
	if (k.attemptDisposition !== undefined && !ATTEMPT_DISPOSITIONS.has(k.attemptDisposition)) return false;
	return true;
}

// ── Multidimensional coverage ────────────────────────────────────────────────────────────────────────

/** One dimension's coverage. `ExtractionCoverage[]` (an assessment-level array across dimensions) and
 *  `CoverageDescriptor` (a single finding's dimension) share this exact shape by design — SCHEMA-V0.md
 *  forbids collapsing multiple dimensions into one scalar, and a finding is scoped to ONE dimension at
 *  a time, so the singular/array distinction is the only difference. Absence is always a gap, never
 *  "safe": a file that failed to parse belongs in `gaps`, not silently dropped from `total`. */
export interface ExtractionCoverage {
	dimension: "syntax" | "resolution" | "type";
	covered: number;
	total: number;
	gaps: Array<{ path?: string; reason: string }>;
}
export type CoverageDescriptor = ExtractionCoverage;

const COVERAGE_DIMENSIONS: ReadonlySet<ExtractionCoverage["dimension"]> = new Set(["syntax", "resolution", "type"]);

function isExtractionCoverage(v: unknown): v is ExtractionCoverage {
	if (!v || typeof v !== "object") return false;
	const c = v as Partial<ExtractionCoverage>;
	if (!COVERAGE_DIMENSIONS.has(c.dimension as ExtractionCoverage["dimension"])) return false;
	if (typeof c.covered !== "number" || typeof c.total !== "number") return false;
	if (!Array.isArray(c.gaps)) return false;
	return c.gaps.every((g) => g && typeof g === "object" && typeof (g as { reason?: unknown }).reason === "string" && ((g as { path?: unknown }).path === undefined || typeof (g as { path?: unknown }).path === "string"));
}

function isExtractionCoverageArray(v: unknown): v is ExtractionCoverage[] {
	return Array.isArray(v) && v.every(isExtractionCoverage);
}

// ── Environment fingerprint ─────────────────────────────────────────────────────────────────────────

export type AnalysisMode = "syntax-only" | "module-resolved" | "type-checked";

/** Exactly what produced an assessment and under what environment — feeds `assessmentKey` (concern
 *  `id.ts`) so a config/dependency change invalidates the prior assessment rather than silently
 *  reusing stale output. */
export interface AnalysisEnvironmentFingerprint {
	analyzerName: string;
	analyzerVersion: string;
	language: "typescript" | "git";
	typescriptVersion?: string;
	tsconfigHash?: string;
	lockfileHash?: string;
	mode: AnalysisMode;
	configurationHash: string;
}

const ANALYSIS_MODES: ReadonlySet<AnalysisMode> = new Set(["syntax-only", "module-resolved", "type-checked"]);

function isAnalysisEnvironmentFingerprint(v: unknown): v is AnalysisEnvironmentFingerprint {
	if (!v || typeof v !== "object") return false;
	const e = v as Partial<AnalysisEnvironmentFingerprint>;
	if (!isNonEmptyString(e.analyzerName) || !isNonEmptyString(e.analyzerVersion)) return false;
	if (e.language !== "typescript" && e.language !== "git") return false;
	if (!ANALYSIS_MODES.has(e.mode as AnalysisMode)) return false;
	if (!isNonEmptyString(e.configurationHash)) return false;
	if (e.typescriptVersion !== undefined && typeof e.typescriptVersion !== "string") return false;
	if (e.tsconfigHash !== undefined && typeof e.tsconfigHash !== "string") return false;
	if (e.lockfileHash !== undefined && typeof e.lockfileHash !== "string") return false;
	return true;
}

// ── Lifecycle events ─────────────────────────────────────────────────────────────────────────────────

export type LandAttemptStage = "attempt-started" | "assessment-attached" | "assessment-invalidated" | "rejected" | "landed" | "post-merge-verified" | "incomplete";

const LAND_ATTEMPT_STAGES: ReadonlySet<LandAttemptStage> = new Set([
	"attempt-started",
	"assessment-attached",
	"assessment-invalidated",
	"rejected",
	"landed",
	"post-merge-verified",
	"incomplete",
]);

/**
 * One occurrence within one landing operation (`attemptId`). `seq` is stamped once at mint time and is
 * monotonic PER ATTEMPT ONLY — cross-event total order is `(lexical shard filename, in-file line
 * index)` (the store's append order), never `seq` alone and never `observedAt`, which is observation
 * time, not an ordering key (SCHEMA-V0.md is explicit on this point).
 *
 * The `landed` event's `{candidate stateRef (via its assessmentKey's snapshot), resultCommit,
 * resultTree}` triple IS the transition edge: C —PROPOSED_TRANSITION_TO→ R, R —ENTERED_CANONICAL_LINEAGE→
 * main. `resultCommit`/`resultTree` are R, which is NOT C under rebase/squash/conflict-resolution/merge
 * composition — `facts(C)` are never relabeled as accepted facts on the strength of this event alone;
 * accepted state comes only from independently observing R (concern 11).
 */
export interface LandAttemptEvent {
	schemaVersion: number;
	eventId: string;
	attemptId: string;
	repositoryId: string;
	seq: number;
	stage: LandAttemptStage;
	assessmentKey?: string;
	previousAssessmentKey?: string;
	resultCommit?: string;
	resultTree?: string;
	reason?: { code: string; detail: string };
	refs: { taskRef?: string; featureRef?: string; planRef?: string; agentRunRef?: string; horizonRef?: string };
	criteria: { declaredCriterionRefs: string[]; impactStatus: "not-evaluated" };
	observedAt: string;
	evidence: EvidencePointer[];
}

function isRefsBag(v: unknown): v is LandAttemptEvent["refs"] {
	if (!v || typeof v !== "object") return false;
	const r = v as Record<string, unknown>;
	for (const key of ["taskRef", "featureRef", "planRef", "agentRunRef", "horizonRef"]) {
		if (r[key] !== undefined && typeof r[key] !== "string") return false;
	}
	return true;
}

function isCriteriaBag(v: unknown): v is LandAttemptEvent["criteria"] {
	if (!v || typeof v !== "object") return false;
	const c = v as Partial<LandAttemptEvent["criteria"]>;
	return Array.isArray(c.declaredCriterionRefs) && c.declaredCriterionRefs.every((x) => typeof x === "string") && c.impactStatus === "not-evaluated";
}

/** THROWS on any structurally invalid event — corrupt-but-present per `baseline-tracker.ts`'s
 *  discipline (a torn/malformed line is the STORE reader's concern to skip-and-count, concern 07/06;
 *  this function only says whether one already-parsed record is well-formed).
 *  @substrate Phase-0 producer (concern 01) with no external caller yet -- land()/analyzers/replay projection wire it up in concerns 03-11 (plans/land-assessment); a co-located test consumer is not a real reference (dead-exports.ts's own carve-out). */
export function validateLandAttemptEvent(v: unknown): LandAttemptEvent {
	if (!v || typeof v !== "object") throw new Error(`land-assessment schema: LandAttemptEvent is not an object: ${JSON.stringify(v)}`);
	const e = v as Partial<LandAttemptEvent>;
	if (typeof e.schemaVersion !== "number") throw new Error("land-assessment schema: LandAttemptEvent.schemaVersion must be a number");
	if (!isNonEmptyString(e.eventId)) throw new Error("land-assessment schema: LandAttemptEvent.eventId must be a non-empty string");
	if (!isNonEmptyString(e.attemptId)) throw new Error("land-assessment schema: LandAttemptEvent.attemptId must be a non-empty string");
	if (!isNonEmptyString(e.repositoryId)) throw new Error("land-assessment schema: LandAttemptEvent.repositoryId must be a non-empty string");
	if (typeof e.seq !== "number" || !Number.isInteger(e.seq) || e.seq < 0) throw new Error("land-assessment schema: LandAttemptEvent.seq must be a non-negative integer");
	if (!LAND_ATTEMPT_STAGES.has(e.stage as LandAttemptStage)) throw new Error(`land-assessment schema: LandAttemptEvent.stage is invalid: ${JSON.stringify(e.stage)}`);
	if (e.assessmentKey !== undefined && !isNonEmptyString(e.assessmentKey)) throw new Error("land-assessment schema: LandAttemptEvent.assessmentKey must be a non-empty string when present");
	if (e.previousAssessmentKey !== undefined && !isNonEmptyString(e.previousAssessmentKey)) throw new Error("land-assessment schema: LandAttemptEvent.previousAssessmentKey must be a non-empty string when present");
	if (e.resultCommit !== undefined && !isNonEmptyString(e.resultCommit)) throw new Error("land-assessment schema: LandAttemptEvent.resultCommit must be a non-empty string when present");
	if (e.resultTree !== undefined && !isNonEmptyString(e.resultTree)) throw new Error("land-assessment schema: LandAttemptEvent.resultTree must be a non-empty string when present");
	if (e.reason !== undefined) {
		const r = e.reason as Partial<NonNullable<LandAttemptEvent["reason"]>>;
		if (!r || typeof r !== "object" || !isNonEmptyString(r.code) || typeof r.detail !== "string") throw new Error("land-assessment schema: LandAttemptEvent.reason must be {code: non-empty string, detail: string} when present");
	}
	if (!isRefsBag(e.refs)) throw new Error("land-assessment schema: LandAttemptEvent.refs is invalid");
	if (!isCriteriaBag(e.criteria)) throw new Error("land-assessment schema: LandAttemptEvent.criteria is invalid");
	if (!isNonEmptyString(e.observedAt)) throw new Error("land-assessment schema: LandAttemptEvent.observedAt must be a non-empty string");
	if (!isEvidencePointerArray(e.evidence)) throw new Error("land-assessment schema: LandAttemptEvent.evidence must be an EvidencePointer[]");
	return e as LandAttemptEvent;
}

// ── Assessment snapshots (content-addressed) ────────────────────────────────────────────────────────

/**
 * One exact assessed repository state + analyzer environment, content-addressed by `assessmentKey`.
 * `outputHash` is a hash of the canonicalized findings/observations this run produced — SAME
 * `assessmentKey` MUST yield the SAME `outputHash`; a mismatch is analyzer nondeterminism and is
 * surfaced loudly (see `id.ts#checkOutputHash`), never silently absorbed as "the newer one wins".
 */
export interface LandAssessmentSnapshot {
	schemaVersion: number;
	assessmentKey: string;
	analysisRunId: string;
	state: { base: RepositoryStateRef; target: RepositoryStateRef; candidate: RepositoryStateRef };
	environment: AnalysisEnvironmentFingerprint;
	observationBatchRefs: string[];
	findingRefs: string[];
	coverage: ExtractionCoverage[];
	outputHash: string;
	createdAt: string;
}

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** THROWS on any structurally invalid snapshot.
 *  @substrate Phase-0 producer (concern 01) with no external caller yet -- land()/analyzers/replay projection wire it up in concerns 03-11 (plans/land-assessment); a co-located test consumer is not a real reference (dead-exports.ts's own carve-out). */
export function validateLandAssessmentSnapshot(v: unknown): LandAssessmentSnapshot {
	if (!v || typeof v !== "object") throw new Error(`land-assessment schema: LandAssessmentSnapshot is not an object: ${JSON.stringify(v)}`);
	const s = v as Partial<LandAssessmentSnapshot>;
	if (typeof s.schemaVersion !== "number") throw new Error("land-assessment schema: LandAssessmentSnapshot.schemaVersion must be a number");
	if (!isNonEmptyString(s.assessmentKey)) throw new Error("land-assessment schema: LandAssessmentSnapshot.assessmentKey must be a non-empty string");
	if (!isNonEmptyString(s.analysisRunId)) throw new Error("land-assessment schema: LandAssessmentSnapshot.analysisRunId must be a non-empty string");
	if (!s.state || typeof s.state !== "object") throw new Error("land-assessment schema: LandAssessmentSnapshot.state must be an object");
	validateRepositoryStateRef(s.state.base, "LandAssessmentSnapshot.state.base");
	validateRepositoryStateRef(s.state.target, "LandAssessmentSnapshot.state.target");
	validateRepositoryStateRef(s.state.candidate, "LandAssessmentSnapshot.state.candidate");
	if (!isAnalysisEnvironmentFingerprint(s.environment)) throw new Error("land-assessment schema: LandAssessmentSnapshot.environment is invalid");
	if (!isStringArray(s.observationBatchRefs)) throw new Error("land-assessment schema: LandAssessmentSnapshot.observationBatchRefs must be a string[]");
	if (!isStringArray(s.findingRefs)) throw new Error("land-assessment schema: LandAssessmentSnapshot.findingRefs must be a string[]");
	if (!isExtractionCoverageArray(s.coverage)) throw new Error("land-assessment schema: LandAssessmentSnapshot.coverage must be an ExtractionCoverage[]");
	if (!isNonEmptyString(s.outputHash)) throw new Error("land-assessment schema: LandAssessmentSnapshot.outputHash must be a non-empty string");
	if (!isNonEmptyString(s.createdAt)) throw new Error("land-assessment schema: LandAssessmentSnapshot.createdAt must be a non-empty string");
	return s as LandAssessmentSnapshot;
}

// ── Observations (the durable product) ──────────────────────────────────────────────────────────────

/** What IS true at one exact state. Always `authority: "deterministic"` — a fact is something the
 *  extractor directly observed in the source text, never an inference (inferences are `AssessmentFinding`s). */
export interface SnapshotFact {
	factId: string;
	state: RepositoryStateRef;
	subject: EntityLocator;
	predicate: string;
	object: FactValue;
	authority: "deterministic";
	observedAt: string;
	producer: ProducerRef;
	evidence: EvidencePointer[];
}

/** THROWS on any structurally invalid fact — including a fact addressed to no exact state, which is
 *  meaningless for a record whose entire identity model is exact-state addressing.
 *  @substrate Phase-0 producer (concern 01) with no external caller yet -- land()/analyzers/replay projection wire it up in concerns 03-11 (plans/land-assessment); a co-located test consumer is not a real reference (dead-exports.ts's own carve-out). */
export function validateSnapshotFact(v: unknown): SnapshotFact {
	if (!v || typeof v !== "object") throw new Error(`land-assessment schema: SnapshotFact is not an object: ${JSON.stringify(v)}`);
	const f = v as Partial<SnapshotFact>;
	if (!isNonEmptyString(f.factId)) throw new Error("land-assessment schema: SnapshotFact.factId must be a non-empty string");
	validateRepositoryStateRef(f.state, "SnapshotFact.state");
	if (!isEntityLocator(f.subject)) throw new Error("land-assessment schema: SnapshotFact.subject is not a valid EntityLocator");
	if (!isNonEmptyString(f.predicate)) throw new Error("land-assessment schema: SnapshotFact.predicate must be a non-empty string");
	if (!isFactValue(f.object)) throw new Error("land-assessment schema: SnapshotFact.object is not a valid FactValue");
	if (f.authority !== "deterministic") throw new Error('land-assessment schema: SnapshotFact.authority must be "deterministic"');
	if (!isNonEmptyString(f.observedAt)) throw new Error("land-assessment schema: SnapshotFact.observedAt must be a non-empty string");
	if (!isProducerRef(f.producer)) throw new Error("land-assessment schema: SnapshotFact.producer is not a valid ProducerRef");
	if (!isEvidencePointerArray(f.evidence)) throw new Error("land-assessment schema: SnapshotFact.evidence must be an EvidencePointer[]");
	return f as SnapshotFact;
}

/** What CHANGED between two exact states. */
export interface ChangeObservation {
	observationId: string;
	fromState: RepositoryStateRef;
	toState: RepositoryStateRef;
	subject: EntityLocator;
	operation: "added" | "removed" | "modified" | "renamed";
	before?: FactValue;
	after?: FactValue;
	observedAt: string;
	producer: ProducerRef;
	evidence: EvidencePointer[];
}

const CHANGE_OPERATIONS: ReadonlySet<ChangeObservation["operation"]> = new Set(["added", "removed", "modified", "renamed"]);

/** THROWS on any structurally invalid observation — including one missing either exact-state ref
 *  ("changed between two states" is meaningless with only one, or no, state addressed).
 *  @substrate Phase-0 producer (concern 01) with no external caller yet -- land()/analyzers/replay projection wire it up in concerns 03-11 (plans/land-assessment); a co-located test consumer is not a real reference (dead-exports.ts's own carve-out). */
export function validateChangeObservation(v: unknown): ChangeObservation {
	if (!v || typeof v !== "object") throw new Error(`land-assessment schema: ChangeObservation is not an object: ${JSON.stringify(v)}`);
	const c = v as Partial<ChangeObservation>;
	if (!isNonEmptyString(c.observationId)) throw new Error("land-assessment schema: ChangeObservation.observationId must be a non-empty string");
	validateRepositoryStateRef(c.fromState, "ChangeObservation.fromState");
	validateRepositoryStateRef(c.toState, "ChangeObservation.toState");
	if (!isEntityLocator(c.subject)) throw new Error("land-assessment schema: ChangeObservation.subject is not a valid EntityLocator");
	if (!CHANGE_OPERATIONS.has(c.operation as ChangeObservation["operation"])) throw new Error(`land-assessment schema: ChangeObservation.operation is invalid: ${JSON.stringify(c.operation)}`);
	if (c.before !== undefined && !isFactValue(c.before)) throw new Error("land-assessment schema: ChangeObservation.before is not a valid FactValue");
	if (c.after !== undefined && !isFactValue(c.after)) throw new Error("land-assessment schema: ChangeObservation.after is not a valid FactValue");
	if (!isNonEmptyString(c.observedAt)) throw new Error("land-assessment schema: ChangeObservation.observedAt must be a non-empty string");
	if (!isProducerRef(c.producer)) throw new Error("land-assessment schema: ChangeObservation.producer is not a valid ProducerRef");
	if (!isEvidencePointerArray(c.evidence)) throw new Error("land-assessment schema: ChangeObservation.evidence must be an EvidencePointer[]");
	return c as ChangeObservation;
}

// ── Findings ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * What an analyzer THINKS an observation means — re-derivable from observations under versioned
 * rules, without re-extracting history. `derivedFromObservations` is REQUIRED (non-empty) unless
 * `semantics.authority === "inferred"`: a deterministic or derived finding must point at the raw
 * observations that produced it, or it is laundering an inference into a stronger authority than it
 * earned (SCHEMA-V0.md's exact phrase). An `inferred` finding may legitimately have none — that's what
 * makes it inferred rather than derived.
 */
export interface AssessmentFinding {
	id: string;
	kind: string;
	statement: string;
	semantics: KnowledgeSemantics;
	confidence?: number;
	coverage: CoverageDescriptor;
	derivedFromObservations: string[];
	evidence: EvidencePointer[];
	producer: ProducerRef;
}

/** THROWS on any structurally invalid finding, INCLUDING the guardrail rule above:
 *  `derivedFromObservations` empty while `authority !== "inferred"`.
 *  @substrate Phase-0 producer (concern 01) with no external caller yet -- land()/analyzers/replay projection wire it up in concerns 03-11 (plans/land-assessment); a co-located test consumer is not a real reference (dead-exports.ts's own carve-out). */
export function validateAssessmentFinding(v: unknown): AssessmentFinding {
	if (!v || typeof v !== "object") throw new Error(`land-assessment schema: AssessmentFinding is not an object: ${JSON.stringify(v)}`);
	const f = v as Partial<AssessmentFinding>;
	if (!isNonEmptyString(f.id)) throw new Error("land-assessment schema: AssessmentFinding.id must be a non-empty string");
	if (!isNonEmptyString(f.kind)) throw new Error("land-assessment schema: AssessmentFinding.kind must be a non-empty string");
	if (!isNonEmptyString(f.statement)) throw new Error("land-assessment schema: AssessmentFinding.statement must be a non-empty string");
	if (!isKnowledgeSemantics(f.semantics)) throw new Error("land-assessment schema: AssessmentFinding.semantics is invalid");
	if (f.confidence !== undefined && typeof f.confidence !== "number") throw new Error("land-assessment schema: AssessmentFinding.confidence must be a number when present");
	if (!isExtractionCoverage(f.coverage)) throw new Error("land-assessment schema: AssessmentFinding.coverage is not a valid CoverageDescriptor");
	if (!isStringArray(f.derivedFromObservations)) throw new Error("land-assessment schema: AssessmentFinding.derivedFromObservations must be a string[]");
	if (f.semantics!.authority !== "inferred" && f.derivedFromObservations!.length === 0) {
		throw new Error('land-assessment schema: AssessmentFinding.derivedFromObservations is required (non-empty) unless semantics.authority === "inferred" — a deterministic/derived finding must cite the observations it came from');
	}
	if (!isEvidencePointerArray(f.evidence)) throw new Error("land-assessment schema: AssessmentFinding.evidence must be an EvidencePointer[]");
	if (!isProducerRef(f.producer)) throw new Error("land-assessment schema: AssessmentFinding.producer is not a valid ProducerRef");
	return f as AssessmentFinding;
}

// ── Reconstruction anchor and continuity (shapes frozen here; owned by concern 11) ─────────────────

/** One entity's accepted shape at a manifest's state, indexed into that same manifest's `facts` array
 *  by id rather than duplicating fact bodies — concern 11 populates this from the structural-delta
 *  extractor's full-state run (concern 04). */
export interface EntityRecord {
	locator: EntityLocator;
	factIds: string[];
}

/** Initial/periodic checkpoint of ACCEPTED repository state — the anchor `projection.ts` (concern 11)
 *  replays accepted deltas forward from, so reconstructing "module X's interface at commit A" never
 *  requires replaying the entire history from repository genesis. */
export interface RepositoryManifest {
	repositoryId: string;
	state: RepositoryStateRef;
	entities: EntityRecord[];
	facts: SnapshotFact[];
	extractionCoverage: ExtractionCoverage[];
	producer: ProducerRef;
}

/** Whether the indexed history is a continuous accepted-state lineage from `lastIndexed` to `current`.
 *  `unknown` (never assumed `continuous`) fires on any transition glance did not itself observe — a
 *  human push, a force push, a bot merge — and is the trigger for concern 11's reconcile-or-re-extract
 *  repair path. The temporal model must never silently assume completeness. */
export interface ContinuityRecord {
	repositoryId: string;
	lastIndexed: RepositoryStateRef;
	current: RepositoryStateRef;
	status: "continuous" | "unknown";
	reason?: string;
}

// ── Current schema version ──────────────────────────────────────────────────────────────────────────

/** Stamped onto every `LandAttemptEvent`/`LandAssessmentSnapshot` this codebase writes. Bump on any
 *  breaking shape change to the records above (never silently — a version bump is how a future reader
 *  knows to branch its parsing, since these shapes are append-only and never migrated in place). */
export const SCHEMA_VERSION = 0;
