# Compliance findings in the Observer loop
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/observer.ts, src/squad-manager.ts, src/compliance.ts

## Goal (what is built)

Feed the compliance evaluator (leaf 05) into the Observer's per-tick audit as an additional finding
source, so a policy violation (e.g. a forced land without proof, an overridden veto) is filed/deduped
through the same observe → file → confirm loop as the existing structural findings — not just visible
in an on-demand API call.

## Approach (how — cite real file:symbol attach points)

- Add one optional injected dep to `ObserverDeps` (`src/observer.ts:54`):
  `complianceFindings?: () => Promise<ComplianceFinding[]>` — optional so existing tests/embedders that
  don't pass it keep the check disabled (same pattern as `landLedger?`/`uncommittedInWorktree?`).
- Add a pure mapper `export function auditCompliance(findings: ComplianceFinding[]): Finding[]` in
  `src/observer.ts` (sibling to `auditTestsGreen` at `:162`, `landFailureFindings` at `:278`) that maps
  each `ComplianceFinding` to an Observer `Finding` (`src/observer.ts:40`): stable
  `fingerprint = \`compliance:${f.code}:${f.subject}\``, `title`, `detail`, and `severity` passed
  through (compliance severities `low|high|structural` already match Observer's `Severity`,
  `src/observer.ts:37`). Structural ⇒ `needsTriage` already returns true (`:556`), so these are never
  auto-dispatched.
- Call it in `Observer.collect` (`src/observer.ts:524`), guarded:
  `if (this.deps.complianceFindings) findings.push(...auditCompliance(await this.deps.complianceFindings()));`
  — place it after the existing `landFailureFindings` push (`:545`).
- Wire the dep where the daemon constructs its `Observer` in `SquadManager` (grep `new Observer(` in
  `src/squad-manager.ts`): pass `complianceFindings: () => evaluateCompliance({ readAudit: ..., forcedLands: () => readForcedLands(this.stateDir), validatorOverrides: () => readValidatorOverrides(this.stateDir), landLedger: () => readLandLedger(this.stateDir) })` (reuse the same builders leaf 05 uses for `governancePayload`).

## Scope boundary

Do NOT change the Observer's dedup/cap/resolve machinery (`tick`, `seen`, `needsTriage`) — only add one
finding source. Do NOT re-implement any policy logic here; import from `src/compliance.ts` (leaf 05).
Do NOT make the dep required (keep it optional so headless Observer tests without compliance still pass).

## Verify (concrete command + expected observable outcome)

`bun test tests/observer.test.ts` — a new case injects `complianceFindings` returning one
`forced-land-without-proof` finding and asserts a `tick()` files exactly one issue whose title carries
that finding, and that a second `tick()` with the same finding files nothing (deduped by the
`compliance:` fingerprint). An Observer constructed WITHOUT `complianceFindings` behaves exactly as
before (existing cases stay green).
