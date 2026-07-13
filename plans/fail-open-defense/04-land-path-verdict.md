# A narrow verdict union over the land-path gates
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 01, 03
TOUCHES: src/gate-verdict.ts (new), src/land-risk.ts, src/land-pr.ts, src/land.ts, src/proof.ts, scripts/defect-ratchet.ts, tests/

## Goal
On the land path — and nowhere else, for now — make "nothing was computed" a state that does not
compile. Kill the `undefined`-means-allow mechanism where a wrong answer merges code.

## Approach
- `src/gate-verdict.ts`: `type GateVerdict = {kind:"allow"} | {kind:"block"; reason; reasonClass?;
  retryable; escalate} | {kind:"inconclusive"; reason; retryable; escalate}`. No `advisory` variant —
  advisory gates keep their own, structurally different types and are not assignable here.
- **No `fromProbeFailure` constructor.** Retry polarity is caller-supplied, because the budget is
  caller-local (`classify-probe-failure.ts:29-32`). The classification supplies `.reason` and its
  structural/spawn `kind`; the caller states `retryable`/`escalate`. A constructor that derives
  polarity from the classification would flip the 15 deliberate `retryable: true` land-loop sites into
  `retryable:false`, letting `autoLandFailCap` park a branch after 3 transient dirty-main windows —
  the 1,381-death interlock, restored. This is the single most important line in this concern.
- **No `acceptInconclusiveAsAllow`, no `Allow{basis:"vacuous"}`.** An `Inconclusive` is never
  downgraded. `runMainGate`'s `skipped:true` stays a distinct, non-allow result (sweep finding #13).
- Convert exactly these, atomically per function, no hybrid signatures: `landRiskReason`,
  `transplantedCommitsReason`, `staleBranchReason`, `greenGateUnproven`, `proofGate`,
  `packageManifestError`. Every caller of each converts in the same commit, so two call sites of one
  decision never disagree about what inconclusive means.
- Exhaustiveness via a `switch` + `assertNever` (red team A: equivalent to a fold, and honest — the
  fold's advantage was overstated). Add a type-level compile test asserting `Inconclusive` is not
  assignable where `Allow` is expected.
- Add ratchet `gate-typed-undefined-return`, baseline **0, permanently**: no signature may return
  `GateVerdict | undefined`. This, not the fold, is the standing guarantee.
- Register `src/gate-verdict.ts` in PR #160's `hand-written-retryable` allowlist in the same PR, or it
  trips that ratchet on day one.

## Cross-Repo Side Effects
None. The three wire enums (`ValidationRecordDTO.verdict`, `AgentDTO.prState`, `DoneProof.verified`)
are untouched; a one-way adapter maps where a boundary is crossed.

## Verify
Concern 01's fault-injection harness is green before AND after (it is the regression lock — if a
signature change re-opens a fail-open, the harness fails, not a reviewer). Characterization tests
assert `retryable: true` **survives** migration at all 15 land-loop sites. Full suite green; tsc clean;
`bun run check` clean.
