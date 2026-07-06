# Compliance evaluator — evaluateCompliance over the ledgers + governancePayload
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/compliance.ts, tests/compliance.test.ts, src/server.ts, src/audit.ts, src/land-ledger.ts

## Goal (what is built)

A new `src/compliance.ts` exporting `evaluateCompliance(deps)` — a pure policy evaluator over the three
append-only ledgers (audit, land-forced, land-ledger) that returns real policy findings. Surface those
findings in `governancePayload` so `/api/governance` reports actual policy state, not only RBAC +
capacity.

## Approach (how — cite real file:symbol attach points)

- `src/compliance.ts`: `evaluateCompliance(deps: ComplianceDeps): Promise<ComplianceFinding[]>` with all
  ledger reads injected (headless-testable, mirrors `ObserverDeps` in `src/observer.ts:54`):
  ```ts
  interface ComplianceDeps {
    readAudit: (q?: AuditQuery) => Promise<AuditEntry[]>;      // src/audit.ts:71
    forcedLands: () => ForcedLand[];                            // src/land-ledger.ts:100
    validatorOverrides?: () => ValidatorOverride[];             // leaf 03 (optional; absent pre-03)
    landLedger: () => LandLedger;                               // src/land-ledger.ts:34
    now?: () => number;
  }
  interface ComplianceFinding { code: string; severity: "low"|"high"|"structural"; subject: string; detail: string; at: number; }
  ```
- Policies v1 (each a small pure check, seeded from real gaps):
  1. **forced-land-without-proof** — any `ForcedLand` in the last window ⇒ a `high` finding naming the
     branch + actor (a land that bypassed the deterministic gate).
  2. **validator-override** — any `ValidatorOverride` ⇒ a `structural` finding (a semantic veto was
     overridden); include the `reasonClass`. Skipped when `validatorOverrides` dep is absent.
  3. **land-repeatedly-failing** — a `LandLedger` entry with `fails >= cap` ⇒ `high` (reuse the
     `OMP_SQUAD_AUTOLAND_FAIL_CAP` default 3, as `landFailCap()` does in `src/observer.ts:117`).
  Keep each policy a named exported function so leaf 06 and tests can call them in isolation.
- Wire into `governancePayload` (`src/server.ts:2004`): add a `compliance: { findings: ComplianceFinding[]; evaluatedAt: number }`
  key to the return object + its type. Build a `ComplianceDeps` from the manager's state dir —
  `readAudit`/`readForcedLands`/`readLandLedger` are already importable (`src/audit.ts`, `src/land-ledger.ts`);
  pass `manager`'s `stateDir`. The `/api/governance` route (`src/server.ts:1169`) needs no change — it
  already serializes whatever `governancePayload` returns.

## Scope boundary

Do NOT read transcripts or dispatch internals here — v1 is over audit + the two land ledgers only
(`src/dispatch-ledger.ts` is a candidate v2 source, out of scope). Do NOT file Plane issues from this
module (that is the Observer's job, leaf 06). Do NOT add UI. Keep every check pure over injected deps —
no direct `fs` reads inside `evaluateCompliance`.

## Verify (concrete command + expected observable outcome)

`bun test tests/compliance.test.ts` — with injected fake deps: (a) one `ForcedLand` ⇒ a
`forced-land-without-proof` `high` finding; (b) a `LandLedger` entry with `fails:4` ⇒ a
`land-repeatedly-failing` finding; (c) empty ledgers ⇒ `[]`. Then a server test (or manual
`curl localhost:PORT/api/governance`) shows a `compliance.findings` array in the payload rather than
only `audit:{available:true}`.
