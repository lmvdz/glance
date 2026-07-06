# Confidence field on RunReceipt + AgentDTO (+ DTO mirror)

STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/types.ts, webapp/src/lib/dto.ts

## Goal (what is built)

A single `confidence?: number` field (0..1, absent until a run computes it) added to the durable
`RunReceipt`, the live `AgentDTO`, and the hand-maintained webapp DTO mirror — the shared vocabulary
every later leaf reads. No behavior yet; pure plumbing so `02`/`03` can land in parallel.

## Approach (how — cite real file:symbol attach points you verified)

- `src/types.ts:611` `interface RunReceipt` — add `/** Run-end self-confidence 0..1 (src/confidence.ts); absent until computed. */ confidence?: number;` after `harness?` (`:635`).
- `src/types.ts:483` `interface AgentDTO` — add the same `confidence?: number;` near `landReady?` (`:593`), which is the analogous optional run-outcome flag.
- `webapp/src/lib/dto.ts` `interface AgentDTO` (the mirror; field block around `:331`–`:357`, `landReady?` at `:345`) — add the mirrored `confidence?: number;`. This file is hand-maintained (not codegen — see its plain `export interface` header at `:1`), so the mirror IS the work.
- Do NOT add it to `ReceiptRollup` (`src/types.ts:639`) or `RunAccumulator.snapshot()` (`src/receipts.ts:122`) — confidence is stamped by the manager in `finalizeRun` (leaf `02`), not by the accumulator.

## Verify (concrete command + expected observable outcome)

`cd /home/lars/sui/omp-squad/.claude/worktrees/meta-plan-autonomous-fleet && bunx tsc --noEmit -p tsconfig.json` (or the repo's typecheck script) exits 0 with the new field referenced nowhere yet. Then `grep -n "confidence?: number" src/types.ts webapp/src/lib/dto.ts` shows exactly 3 hits (RunReceipt, src AgentDTO, webapp AgentDTO).

## Scope boundary (what NOT to touch)

No scorer, no autonomy cap, no UI, no host tool. Type declarations + the mirror only. Do not touch
`PersistedAgent` (confidence is a run outcome, not restored config).
</content>
