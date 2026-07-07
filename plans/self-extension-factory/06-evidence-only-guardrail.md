# Evidence-only guardrail
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/capabilities/index.ts

## Goal
Enforce the evidence-only discipline at the single chokepoint both CLI and HTTP funnel through, so a factory-origin capability cannot enter or advance without resolvable provenance — and so the factory's default-OFF flag can't be sidestepped via the generic admin PATCH route (red team B#2).

## Approach
- In `installCapability`/`updateCapabilityInstall` (`src/capabilities/index.ts` — the chokepoint; do NOT add the check at the `src/server.ts` HTTP layer, which is factory-unaware):
  - When `origin === "factory"`, **require** a `provenance.demandId` that resolves to a real demand in the queue; reject otherwise.
  - Reject a state transition to `enabled`/`approved` on a factory-origin install whose `provenance` is missing. (v1 stops here — the human authoring the proposal supplies provenance via Concern 05. v2-P5 adds fresh-proof re-assertion here; leave a clearly-marked seam/TODO referencing DESIGN §v2-P5, do not implement the proof re-check now.)
- `origin` absent or `"manual"` → unchanged behavior (no new friction on human installs).
- Add unit tests for: factory install without provenance → rejected; with valid provenance → accepted; manual install → unaffected.

## Cross-Repo Side Effects
None — the chokepoint is internal. Both the HTTP PATCH route and any CLI path inherit the guard for free because they both call `updateCapabilityInstall`.

## Verify
- `installCapability({origin:"factory"})` with no `provenance.demandId` throws/rejects; with a resolvable one succeeds.
- Manual install/enable path unchanged (regression).
- Attempt to `PATCH state:"enabled"` on a factory install lacking provenance is rejected at the chokepoint even though the HTTP route is unaware.
- `bun test` green.
