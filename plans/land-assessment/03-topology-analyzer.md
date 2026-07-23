# Topology analyzer
STATUS: done — merged via PRs #201/#212 (concern 08: 0bf3389, src/land-assessment/hook.ts); verified on main, 2026-07-21 reality audit
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 01
TOUCHES: src/land-assessment/analyzers/plugin.ts, src/land-assessment/analyzers/topology.ts, src/land-assessment/analyzers/topology.test.ts

## Goal
The analyzer that owns the incident classes with real labeled positives (git-topology, workflow-state): pure-git, fully offline-replayable, deterministic. This is the wedge's go/no-go evidence producer.

## Approach
- `plugin.ts`: the `AssessmentAnalyzer` contract — `{name, version, claimedClasses, applicable(ctx), run(ctx): Promise<AnalysisResult>}` where `ctx` carries `{repo, baseCommit, mainCommit, candidateCommit}` plus a git-exec helper (hardened env, per the codebase's GIT_HARDEN_ARGS idiom). `runAnalyzers()` registry executes applicable analyzers, collects findings, and converts thrown analyzer errors into extractionCoverage gaps (an analyzer crash is a gap, never a silent absence).
- `topology.ts` detections (each a deterministic finding with per-finding coverage):
  - **stacked-base**: candidate's merge-base against the default branch differs from its merge-base against its actual base ref; or the candidate contains commits reachable from another non-main branch head but not main (the wrong-base class from memory).
  - **orphaned-merge**: a branch recorded merged whose commits are not reachable from current main (`git cherry`-equivalent via `rev-list`), the orphaned-merged-PR class.
  - **transplanted lineage**: candidate commits whose patch-ids appear in main under different SHAs (cherry-pick/squash duplication) — same computation class as `land-pr.ts`'s `transplantedCommitsReason`, reimplemented pure (no daemon deps) for offline use.
  - **fork-point-behind + overlap**: fork point behind main AND both sides touched same paths since divergence (the `staleBranchReason` class, offline).
- All joins by exact SHA/ref equality on `path.resolve`d repo paths. Output deterministically sorted. No LLM, no network.
- Observations-first (BRIEF §11.2): the analyzer emits deterministic lineage `StructuralObservation`s (e.g. `branch FORKED_FROM <sha>`, `commit PATCH_ID_DUPLICATE_OF <sha>`, `merge UNREACHABLE_FROM main@<sha>`) and derives its findings from them with `derivedFromObservations` lineage.

## Cross-Repo Side Effects
None — pure library, zero land-path integration in this phase.

## Verify
`bun test .../topology.test.ts` against fixture repos built in-test (git init + scripted histories reproducing each class: a stacked-base, an orphan, a transplant, a stale-fork overlap) — each detection fires on its positive fixture and stays silent on the benign fixture.
