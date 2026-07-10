# Delivery-confirmed efficiencyFlags on receipts
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/types.ts, src/receipts.ts, src/squad-manager.ts, tests/

## Goal
`RunReceipt.efficiencyFlags?: string[]` exists and is stamped ONLY when the flagged behavior was
confirmed delivered to the unit — never at intent time — so concern 01's flagSet-vs-baseline
comparison measures signal, not placebo.

## Approach
- Add `efficiencyFlags?: string[]` to RunReceipt (types.ts) + wire-schema mirror if receipts
  cross a validated boundary.
- Stamp in the spawn/finalize path only when delivery is confirmed: for `--append-system-prompt`
  content that means the harness path actually carried it (native contextInjection; the
  `hasPrimer` hoisting in squad-manager (~3645) is the in-repo precedent). ACP units with
  contextInjection "none" get NO flag even if the profile requested one; optionally record
  `membraneDelivered: false` for visibility.
- Flag identity per unit = union across its runs; if runs disagree, add a `mixed` marker so
  concern 01 can exclude mixed populations.
- COORDINATION: squad-manager.ts is under active edit on fix/one-green-loop — keep this diff
  minimal (one stamping seam), rebase before landing.

## Cross-Repo Side Effects
None.

## Verify
Tests: ACP-none profile with a membrane token produces a receipt with no flag; native profile
produces the flag; mixed-run unit gets the mixed marker.
