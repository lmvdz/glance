# Land-assessment schema and identity module
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/land-assessment/schema.ts, src/land-assessment/id.ts, src/land-assessment/schema.test.ts

## Goal
Implement `SCHEMA-V0.md` (the normative record semantics — read it first; where this concern and that doc disagree, the doc wins) as TypeScript types, identity functions, and validate-on-read guards. Everything else in this plan builds on these shapes.

## Approach
`schema.ts` — the SCHEMA-V0.md shapes verbatim:
- `RepositoryStateRef` (exact-state addressing; validity intervals are lineage projections computed at read time, never stored).
- `LandAttemptEvent` (lifecycle: `attempt-started | assessment-attached | assessment-invalidated | rejected | landed | post-merge-verified | incomplete`; carries `assessmentKey?/previousAssessmentKey?`, `resultCommit/resultTree` on landed (the C→R transition edge), rejection `reason` codes, refs, refs-only criteria, per-attempt `seq`).
- `LandAssessmentSnapshot` (content-addressed by `assessmentKey`; `analysisRunId` per execution; `observationBatchRefs`/`findingRefs`; `outputHash` — same key must yield same hash, mismatch surfaces analyzer nondeterminism loudly).
- `SnapshotFact` + `ChangeObservation` (the durable observations — what is / what changed between exact states).
- `KnowledgeSemantics` — four orthogonal axes (`authority`, `support`, `stateRole`, `attemptDisposition?`); never a single collapsed enum.
- `AssessmentFinding` with `semantics`, per-finding `CoverageDescriptor`, and `derivedFromObservations` (required unless authority is "inferred").
- `AnalysisEnvironmentFingerprint` (analyzer name/version, language, typescriptVersion, tsconfigHash, lockfileHash, `mode: "syntax-only" | ...`, configurationHash) and multidimensional `ExtractionCoverage` (`syntax | resolution | type` — one scalar percentage is forbidden).
- `RepositoryManifest` + `ContinuityRecord` shapes (implemented by concern 11; typed here so the contract is frozen together).
- Type guards + validate-on-read per `baseline-tracker.ts`'s idiom (corrupt-but-present throws; absent returns empty). Doc comments carry the two integrity assumptions (single-daemon checkout ownership; the assessed tree is C, never R) and the C≠R promotion rule.

`id.ts`:
- `attemptId = hash(resolvedRepo, branch, candidateCommit, durableCounter)` — counter file `<stateDir>/land-assessment/attempt-counter.json`, atomic temp+rename; minted ONCE per `land()`; `autoLandWorkflow` threads it, never mints.
- `eventId = hash(attemptId, seq)` with a per-attempt monotonic `seq`.
- `assessmentKey = hash(base/target/candidate stateRefs + environment fingerprint)`; `outputHash = hash(canonicalized observations + findings)`; duplicate `(assessmentKey, outputHash)` appends dedup-drop; same-key/different-hash is a loud nondeterminism diagnostic, never absorbed.
- `EXTRACTOR_VERSION` and fingerprint helpers exported here.

## Cross-Repo Side Effects
None — new files only.

## Verify
`bun test src/land-assessment/schema.test.ts`: round-trip validate/reject fixtures; attemptId uniqueness across counter restarts; assessmentKey stability; outputHash invariance under output-order permutation AND loud-mismatch path on injected nondeterminism. Guardrail checks: deterministic/derived finding without `derivedFromObservations` rejected; observation without exact-state ref rejected; `KnowledgeSemantics` axes independent (a deterministic fact about a rejected candidate round-trips as `authority: deterministic` + `stateRole: candidate` + `attemptDisposition: rejected`); no validity-interval fields exist on any stored record (grep-proof: `validFromCommit` absent from schema.ts).
