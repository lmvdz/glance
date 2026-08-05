# Agent-exposure firewall + first-cohort self-proof
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
BLOCKED_BY: 05
TOUCHES: src/impact/firewall.ts (new), tests/impact-firewall.test.ts (new), plans/agent-impact-metrics/first-cohort-report.md (artifact, produced at run time)

## Goal
Impact numbers stay out of agent feedback loops until proven ungameable, and the lane proves itself on real data before the UI ships.

## Approach
- Tested invariant: no impact-lane figure is written to any agent-readable surface (learning ledger/metrics spool consumed by units, prompts, primer, steering context) while (a) name-existence ceiling is the only reference source, or (b) a unit's reference data is below the coverage gates, or (c) cross-feature classification is absent. Enforce as a unit test over the exposure seam plus a defect-ratchet-style pattern guard (scripts/defect-ratchet.ts precedent) so a future wiring change trips CI, not production. Rationale: agents read their own ledger; the cheap gaming vectors (identifier reuse, two-unit split farming) are invisible in review.
- First-cohort self-proof: after 4 weeks flag-on, generate the W+4 report for the first cohort and write it to this plan dir — validating the format against real gaps (codegraph absence, backfill lossiness, uninstrumentable units) before ImpactSurface exposure. Include one red-team unit: deliberately land a generically-named dead export in a scratch scenario and confirm it does NOT score as referenced through the gated path.

## Cross-Repo Side Effects
None.

## Verify
The invariant test fails when a fixture writes an impact figure to the learning-metrics spool; passes after removal. First-cohort report exists and names its gap fractions.
