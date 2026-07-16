# Land-assessment schema and identity module
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/land-assessment/schema.ts, src/land-assessment/id.ts, src/land-assessment/schema.test.ts

## Goal
The frozen v0 shapes everything else builds on: `LandAssessmentEvent`, `AssessmentFinding`, per-analysis types, and the identity rules (attemptId, assessmentId, resultHash) — with the mandate's capture-now fields present from day one so they are never retrofitted.

## Approach
`schema.ts`:
- `LandAssessmentEvent` per BRIEF §10.1: `schemaVersion`, `assessmentId`, `attemptId`, `repositoryId` (sha1 of `path.resolve(repo)`, 16 chars — reuse `proof.ts`'s convention), `stage` (`attempt-started | pre-merge-assessed | assessment-invalidated | post-resolution-assessed | post-merge-verified | rejected | landed | incomplete`), `state {baseCommit, mainCommit, candidateCommit, candidateTree}`, `analyses { topology?, typescriptStructuralDelta?, proofFreshness?, regression?, criterionEvidence? }` (absent key = did-not-run; never empty-but-present), `extractionCoverage[]`, `findings[]`, `evidence[]`, `supersedes?`, `resultHash?`, refs (`taskRef?, featureRef?, planRef?, agentRunRef?, horizonRef?`), `criteria { declaredCriterionRefs: string[], impactStatus: "not-evaluated" }`, `createdAt` (human metadata ONLY — never used for ordering), plus a per-line `seq` (in-file monotonic) stamped by the store.
- `StructuralObservation` (BRIEF §11.2 — the durable product, kept SEPARATE from findings): `{subject: EntityRef, predicate, before?, after?, observedInCommit, authority: "deterministic", evidence: EvidencePointer[], producer {name, version}}`. Observations answer *what changed*; findings answer *what that might mean* and must derive from observations, never replace them.
- Bitemporal fields on durable records (BRIEF §11.3): valid time `validFromCommit`/`validUntilCommit?` distinct from observation time `observedAt`/`supersededAt?` — `createdAt` is human metadata, never the temporal model.
- Epistemic state category (BRIEF §11.4): `stateCategory: "observed" | "proposed" | "accepted" | "rejected"`. Assessments over C are `proposed`; the `landed` terminal marks promotion toward accepted state; `rejected`/invalidated stay episodic — the schema doc states plainly that rejected-attempt facts are never repository truth.
- `AssessmentFinding` per §10.3: `id, kind, statement, authority ("deterministic"|"derived"|"inferred"), status ("supported"|"disputed"|"unknown"), confidence?, coverage: CoverageDescriptor` (PER FINDING, not only record-level), `evidence: EvidencePointer[]`, `analyzer {name, version}`, `derivedFromObservations: string[]` (observation ids — a finding with no observation lineage is invalid unless authority is "inferred").
- `TypeScriptStructuralDelta` (perFile export adds/removes/changes + signatureKind, moduleDependencyGraphDelta, inheritanceDelta, concurrentEdits, adjacentDependencyChanges) and `TopologyAssessment` shapes.
- Type guards + validate-on-read helpers following `baseline-tracker.ts`'s validate-shape idiom (corrupt-but-present input throws; absent returns empty).
- A doc comment stating the two documented integrity assumptions: single-daemon ownership of the checkout, and "the assessed tree is C — never the merge/rebase result that lands."

`id.ts`:
- `attemptId = hash(resolvedRepo, branch, candidateCommit, counter)` where `counter` comes from a durable monotonic counter file (`<stateDir>/land-assessment/attempt-counter.json`, atomic temp+rename write) so restarts never reuse an id. Minted ONCE per `land()` invocation; `autoLandWorkflow` receives it, never mints.
- `assessmentId` = input hash per §10.2 (repo + baseCommit + mainCommit + candidateCommit + candidateTree + extractorVersion + extractorConfig).
- `resultHash` = hash of canonicalized (deterministically sorted) findings — the dedup key: a second write with identical `(assessmentId, resultHash)` is dropped.
- `EXTRACTOR_VERSION` constant exported here; bumped on any analyzer behavior change.

## Cross-Repo Side Effects
None — new files only.

## Verify
`bun test src/land-assessment/schema.test.ts`: round-trip validate/reject fixtures (well-formed event, missing-field event, corrupt JSON), attemptId uniqueness across counter restarts, assessmentId stability, resultHash invariance under findings-order permutation. Guardrail checks: a deterministic/derived finding without `derivedFromObservations` lineage is rejected; an observation without `observedInCommit` is rejected; `stateCategory` promotion rules validate (proposed→accepted only via a landed terminal; rejected never promotes).
