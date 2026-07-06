# Validation signal on the run record — the Epic 5 confidence input
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/types.ts, src/squad-manager.ts

## Goal (what is built)

Make the validator's per-run agreement/confidence a first-class, serialized field on `AgentDTO` and
`RunReceipt` so it survives to the UI and to the durable run record — the exact signal Epic 5's
confidence scorer reads at the `buildDigest` seam. This freezes the cross-epic contract (DESIGN §5).

## Approach (how — cite real file:symbol attach points)

- The `ValidationRecord` interface was added by leaf 01 (DESIGN §5). If leaf 01 landed it in
  `src/types.ts`, reuse it; otherwise add it here.
- Add `validation?: ValidationRecord` to `AgentDTO` — place it next to the existing land/proof fields,
  immediately after `proof?: {...}` (`src/types.ts:587`). Add the same `validation?: ValidationRecord`
  to `RunReceipt` (`src/types.ts:609`) next to `traceId`/`featureId` so the durable per-run JSONL line
  carries it.
- Leaf 02 already assigns `rec.dto.validation = record` at the land gate. Ensure that assignment uses
  the real typed field now (drop any cast leaf 02 used). Also copy it onto the run receipt where
  receipts are written: find the receipt-build site (the same area that reads receipts at the
  `buildDigest` call, `src/squad-manager.ts:4375`, and `readReceipts`/`writeReceipt` in the store) and
  set `receipt.validation = rec.dto.validation` when present.
- Coordination note for Epic 5 (do not implement here): Epic 5 computes the aggregate `confidence` at
  `buildDigest` from `validation.agreement`. This leaf only exposes the input; it does NOT compute
  `confidence`.

## Scope boundary

Do NOT compute or add an aggregate `confidence` field (Epic 5 owns it). Do NOT change the validator
scoring or the land gate logic (leaves 01/02). Do NOT add a websocket event type — `validation` rides
the existing `agent`/`roster` DTO broadcast (leaf 02 already calls `emitAgent`).

## Verify (concrete command + expected observable outcome)

Extend an existing DTO round-trip / receipts test (grep `RunReceipt` in `tests/`): assert an agent whose
land gate produced a `veto` record serializes `agent.validation.verdict === "veto"` in the roster DTO
and that a written `RunReceipt` JSONL line contains the `validation` object. Run the specific test file,
e.g. `bun test tests/receipts.test.ts` (or whichever test covers `RunReceipt`), and it stays green.
