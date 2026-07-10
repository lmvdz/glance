# Fail-closed wave 1 — classifyProbeFailure + the five no-land-refusal findings
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/classify-probe-failure.ts (new), src/land-risk.ts, src/observer.ts, src/proof.ts, src/convergence-run.ts, src/convergence-oracle.ts, src/squad-manager.ts (attention attach only), tests/

## Goal
The five fail-open checkers that CANNOT refuse a land fail closed, under one shared taxonomy,
in one atomic PR — so the land path's safety regime stays reviewable as a whole. (Findings that
CAN refuse a land are concern 07, gated on G3; adjudicated sweep: plans/eap-borrows/failopen-sweep.md.)

## Approach
- `classifyProbeFailure(input) -> { retryable, escalate, reason }`: structural conditions
  (corrupt state file, unclassifiable gate output, missing command where one existed) escalate
  immediately and are never bare-retryable; transient conditions may be retryable ONLY where the
  caller has a bounded attempt budget. Escalation emits into the attention lane.
- FIRST: verify a land/loop probe escalation can attach to a live AgentDTO's attentionEvents;
  if a probe site has no live rec, add a small daemon-scoped attention record (surfaced in the
  same cockpit lane) rather than a log line — an escalation nobody sees is the interlock
  pathology again.
- Finding #7 (land-risk.ts probe): when the gate is enabled, probe failure blocks auto-land
  (riskOverride stays the human hatch). Gate remains default-off.
- Finding #12 (observer.ts:562 `.catch(() => ({ok:true}))`): a thrown gate becomes a distinct
  gate-unrunnable attention finding — NOT ok:true (fail-open) and NOT a `regression:` finding
  (would dispatch units to "fix" docker being down).
- Finding #14 (proof.ts isFresh string-overload): enforce TTL on the string path too (its only
  production caller is boost-only digestReward — safe to tighten).
- Finding #15 (convergence-run.ts suiteFailures): spawn death / nonzero without parseable output
  → escalate and DO NOT write the failures sidecar (a synthetic "suite-unrunnable" entry would
  poison the next turn's set-diff into false regressions).
- Finding #16 (convergence-oracle.ts readFailures): corrupt sidecar → escalate, keep the previous
  baseline; never silently re-baseline.
- Every fix ships a reproduce-first test asserting the OLD fail-open behavior fails under the
  new code.

## Cross-Repo Side Effects
None.

## Verify
`bun test` green including 5 new reproduce-first tests; a scratch-daemon run with a deliberately
corrupt failures sidecar produces a visible attention item and keeps the old baseline.
