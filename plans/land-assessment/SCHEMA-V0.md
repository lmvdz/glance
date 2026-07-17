# Land Assessment / Temporal Substrate — Schema v0 (NORMATIVE)

This is the single normative source for record semantics. It supersedes every schema sketch in `plans/research-glance-architecture-mandate/BRIEF.md` (§1, §10.1, §11) — the BRIEF is decision history, not an implementation contract. Concern files reference these shapes; where a concern and this document disagree, this document wins.

All records are append-only. Nothing here is ever updated in place; later records supersede earlier ones.

## Identity model — three identities, not one

```text
attemptId      one landing operation (durable-counter minted once in land(); autoLandWorkflow threads it, never mints)
eventId        one occurrence within that operation (hash(attemptId, perAttemptSeq))
assessmentKey  one exact assessed repository state + analyzer environment (content hash)
```

An assessment participates in several lifecycle events; events need unique identity, assessments need content identity — one id cannot serve both.

## Exact-state addressing (Git is a DAG, not a timeline)

```ts
interface RepositoryStateRef { repositoryId: string; commit: string; tree: string }
```

Raw durable facts are addressed to exact states. `validFromCommit`/`validUntilCommit` intervals are NEVER stored as primitives — a fact can be true on main, false on a release branch, disappear and reappear; there is no globally meaningful single interval. Intervals are computed by a **lineage projector** over one selected branch lineage, at read time. Supersession is a later record flipping `support: "superseded"` via reference, never a mutation.

## Lifecycle events

```ts
interface LandAttemptEvent {
  schemaVersion: number;
  eventId: string;
  attemptId: string;
  repositoryId: string;
  seq: number;                       // per-attempt monotonic, stamped at mint; total order = (lexical shard filename, in-file line index)
  stage: "attempt-started" | "assessment-attached" | "assessment-invalidated"
       | "rejected" | "landed" | "post-merge-verified" | "incomplete";
  assessmentKey?: string;            // which snapshot this event refers to
  previousAssessmentKey?: string;    // on invalidation: what is superseded
  resultCommit?: string;             // R — on landed; R ≠ C (rebase/squash/resolution/merge composition)
  resultTree?: string;
  reason?: { code: string; detail: string };   // rejection/incomplete reason codes
  refs: { taskRef?: string; featureRef?: string; planRef?: string; agentRunRef?: string; horizonRef?: string };
  criteria: { declaredCriterionRefs: string[]; impactStatus: "not-evaluated" };
  observedAt: string;                // observation time; never an ordering key
  evidence: EvidencePointer[];
}
```

The `landed` event's `{candidate stateRef (via its snapshot), resultCommit/resultTree}` pair IS the transition edge: `C —PROPOSED_TRANSITION_TO→ R`, `R —ENTERED_CANONICAL_LINEAGE→ main`.

## Assessment snapshots (content-addressed)

```ts
interface LandAssessmentSnapshot {
  schemaVersion: number;
  assessmentKey: string;             // hash(base+target+candidate stateRefs + environment fingerprint)
  analysisRunId: string;             // unique per execution of the analyzers
  state: { base: RepositoryStateRef; target: RepositoryStateRef; candidate: RepositoryStateRef };
  environment: AnalysisEnvironmentFingerprint;
  observationBatchRefs: string[];    // → ChangeObservation / SnapshotFact batches
  findingRefs: string[];
  coverage: ExtractionCoverage[];
  outputHash: string;                // hash of canonicalized outputs. Same assessmentKey MUST yield same outputHash;
                                     // a mismatch exposes analyzer nondeterminism and is surfaced loudly, never absorbed.
  createdAt: string;
}
```

## Observations (the durable product)

```ts
interface SnapshotFact {             // what IS at one exact state
  factId: string;
  state: RepositoryStateRef;
  subject: EntityLocator;            // qualified name + file path + kind; rename evidence attaches, identity uncertainty represented
  predicate: string;                 // EXPORTS | IMPORTS | EXTENDS | IMPLEMENTS | HAS_SIGNATURE | ...
  object: FactValue;
  authority: "deterministic";
  observedAt: string;
  producer: ProducerRef;             // {name, version}
  evidence: EvidencePointer[];
}

interface ChangeObservation {        // what CHANGED between two exact states
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
```

Observation = what happened. Finding = what an analyzer thinks it means (re-derivable from observations under versioned rules, without re-extracting history). Recommendation = policy (v1: none — observe-only).

## Knowledge semantics — four orthogonal axes, never one enum

```ts
interface KnowledgeSemantics {
  authority: "deterministic" | "derived" | "inferred" | "operator";      // how produced
  support: "supported" | "disputed" | "unknown" | "superseded";           // how well supported NOW
  stateRole: "base" | "target" | "candidate" | "result" | "counterfactual"; // which state it describes
  attemptDisposition?: "pending" | "landed" | "rejected" | "invalidated" | "rolled-back"; // what happened to the transition
}
```

A fact about a proposed candidate can be observed deterministically; a fact about accepted main can be inferred; a rejected candidate carries both deterministic observations and uncertain findings. Collapsing these axes creates unanswerable queries later.

## Findings

```ts
interface AssessmentFinding {
  id: string;
  kind: string;
  statement: string;
  semantics: KnowledgeSemantics;
  confidence?: number;
  coverage: CoverageDescriptor;                 // per finding
  derivedFromObservations: string[];            // REQUIRED unless authority === "inferred"
  evidence: EvidencePointer[];
  producer: ProducerRef;
}
```

## Accepted truth vs attempted truth (C ≠ R)

`facts(C)` are NEVER relabeled as accepted facts. `R` (the landed result) differs from `C` under rebase, squash, conflict resolution, automated repair, merge composition, and generated files. Accepted state comes from independently observing `R` (or reconciling against it); rejected/invalidated candidate observations remain exactly what they were — deterministic observations about an unaccepted repository state, episodic history, never repository truth.

## Environment fingerprint and multidimensional coverage

```ts
interface AnalysisEnvironmentFingerprint {
  analyzerName: string;
  analyzerVersion: string;
  language: "typescript" | "git";
  typescriptVersion?: string;
  tsconfigHash?: string;
  lockfileHash?: string;
  mode: "syntax-only" | "module-resolved" | "type-checked";   // v0 ships syntax-only
  configurationHash: string;
}

interface ExtractionCoverage {
  dimension: "syntax" | "resolution" | "type";
  covered: number;
  total: number;
  gaps: Array<{ path?: string; reason: string }>;             // absence is a gap, never "safe"
}
```

One scalar coverage number is forbidden: a repo can be 100% syntax-covered and 55% resolution-covered — the distinction must survive into every report.

## Reconstruction anchor and continuity

Deltas alone cannot answer "what was module X's interface at commit A." The substrate requires:

```ts
interface RepositoryManifest {       // initial/periodic checkpoint of accepted state
  repositoryId: string;
  state: RepositoryStateRef;
  entities: EntityRecord[];
  facts: SnapshotFact[];
  extractionCoverage: ExtractionCoverage[];
  producer: ProducerRef;
}
```

Projection = manifest(A) + accepted transition deltas A→…→C, with periodic checkpoints to bound replay length, plus on-demand historical extraction as the fallback. Because not every main transition flows through glance (humans, bots, force pushes):

```ts
interface ContinuityRecord {
  repositoryId: string;
  lastIndexed: RepositoryStateRef;
  current: RepositoryStateRef;
  status: "continuous" | "unknown";
  reason?: string;                   // e.g. "unobserved external transition", "non-ancestor (force push)"
}
```

`unknown` continuity triggers reconcile-or-re-extract; the temporal model never silently assumes completeness.

## Second-producer contract requirement

These shapes must accommodate a non-landing producer without redesign — the designated second producer is **verification execution** (test command, environment, exact commit/tree, observed result, covered entities, proof record, failure evidence). If adding execution observations requires reshaping these records, this schema failed as a state-engine substrate. This is a phase gate (see ADR.md), tested by contract, not aspiration.
