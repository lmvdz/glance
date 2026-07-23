# Incident taxonomy and labeled replay manifest
STATUS: done — merged via PRs #201/#212 (concern 08: 0bf3389, src/land-assessment/hook.ts); verified on main, 2026-07-21 reality audit
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: research
BLOCKED_BY: 01
TOUCHES: src/land-assessment/replay/incident-taxonomy.ts, src/land-assessment/replay/incident-manifest.json, src/land-assessment/replay/manifest.test.ts

## Goal
The written incident→claim mapping the scope red-team demanded: a taxonomy module, a hand-curated labeled manifest with pinned commits, and an honest per-class positive count — produced BEFORE analyzers are built, so nobody discovers after the fact that the built analyzer has zero real positives.

## Approach
- `incident-taxonomy.ts`: the nine classes from BRIEF §10.4 (`git-topology | textual-conflict | structural-api | dependency | behavioral | acceptance-criterion | proof-freshness | workflow-state | operational`) + validation helpers + a `claimedBy` map declaring which analyzer claims which classes (topology → git-topology/workflow-state; typescript-structural-delta → structural-api/dependency; everything else → unclaimed in v0).
- `incident-manifest.json`: entries `{id, taxonomyClasses[], repo, refs {baseCommit?, mainCommit?, candidateCommit?, prNumber?, branch?}, expectedOutcome: "should-detect"|"should-not-flag"|"should-block-eventually", detectionAtMainCommit?, narrative, source: "manual"}`. Rule: a `should-block-eventually` entry is INVALID without `detectionAtMainCommit` (the specific later-main commit at which detection is expected) — unmeasurable labels are rejected at load.
- Archaeology to seed it: the 2026-07-13 composition-drift double-hit (PRs #170/#171 era — sibling squashes outran ratchet baselines), the stacked-PR wrong-base class, orphaned merged PRs (detectable via `git cherry origin/main origin/<head>`), plus at least one stale-proof case. Pin exact SHAs via git/GitHub archaeology; an incident whose commits cannot be pinned is listed in a `unpinnable` section with the reason, not silently dropped.
- Write the per-class positive count into the manifest header AND echo it in the concern's Resolution. Expected honest outcome: structural-api n≈0 — that is the finding, not a failure.
- Benchmark parameters pinned here as data: negative-sample size (target ≥40 manually-reviewed benign lands) and review-budget K for precision@budget (initial K=5 alerts per 100 lands; recorded with rationale, tunable later).

## Cross-Repo Side Effects
None.

## Verify
`bun test .../manifest.test.ts`: schema validation (including the detectionAtMainCommit rule), taxonomy-class validity, claimedBy completeness. Manual: every pinned SHA resolves (`git cat-file -e`) in the repo or via fetched PR refs.
