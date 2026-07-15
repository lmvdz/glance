# Land gate-output call sites + truncate consolidation
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/land.ts, src/validator.ts, src/squad-manager.ts, src/flue-service-driver.ts, tests/land-base-gate.test.ts (audit), tests (audit)
BLOCKED_BY: 01

## Goal
Five land.ts gate-output head-cuts become signal-ranked excerpts; four duplicated truncate helpers collapse onto text-util.

## Approach
1. land.ts sites 424, 441, 455 (applyRegressionGate), 652 (landAgentImpl green path), 932 (attemptAutoResolve): `truncate(output, N)` → `(await reduceOutput(output, N, {command: <the actual gate/fullSuite command in scope>, agentId, source: "land-detail"})).text`. All five enclosing functions verified async. Delete land.ts's local truncate (line 213). Site 652 is the green path — offload volume accepted per DESIGN; add a test that the pointer line survives recordProof's 4000-char detail cap.
2. validator.ts:42 local truncate → import `truncate` from text-util (callers 346/475/713 are prose-only — verified). squad-manager.ts:8481 + flue-service-driver.ts:238 locals → import `truncateLabel` (byte-identical). safeJson keeps calling the shared truncate.
3. DO NOT touch: land-ledger's own 600-cap truncate (different subsystem), budgetedExcerpt call sites (land.ts:229, validator.ts:200/334, land-pr.ts:87/755).
4. Audit tests asserting exact `…`-suffixed detail strings around the five sites; update only those assertions.

## Cross-Repo Side Effects
None.

## Verify
`bun test tests/land-base-gate.test.ts` + full `bun test` green. A synthetic regression-gate output with the failure line past the 300-char cutoff now surfaces it in the land detail.
