# Deterministic confidence scorer + run-end wiring

STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/confidence.ts, src/squad-manager.ts, tests/confidence.test.ts

## Goal (what is built)

A pure `scoreConfidence()` in a new `src/confidence.ts`, plus one call site in `finalizeRun` that
stamps the score onto both the durable receipt and the live DTO. Formula is fixed by DESIGN.md D1 —
implementer does not re-tune weights.

## Approach (how — cite real file:symbol attach points you verified)

- New `src/confidence.ts`, export `scoreConfidence(input: { verificationState: VerificationState; filesTouched: number; validator?: "pass" | "fail" }): number`. Implement DESIGN.md D1 exactly: base 0.5; proof fresh +0.30 / stale 0 / failed|none|unknown −0.30; filesTouched ≤3 +0.10 / >12 −0.20; validator pass +0.10 / fail −0.40 / undefined 0; clamp `[0,1]`. Import `VerificationState` from `./autonomy.ts` (declared there at `autonomy.ts:4`).
- Wire in `src/squad-manager.ts` `finalizeRun` (`:4363`). The receipt is built by `run.snapshot(...)` at `:4368`. Immediately after, compute `const conf = scoreConfidence({ verificationState: rec.dto.verificationState ?? "unknown", filesTouched: receipt.filesTouched.length });` then `receipt.confidence = conf;` **before** `appendReceipt(this.stateDir, receipt)` at `:4369`, and set `rec.dto.confidence = conf;` alongside `rec.dto.receipt = run.rollup();` at `:4393`. Pass no `validator` arg today (Epic 3 not built — DESIGN.md D1).
- Add the import next to the existing digest import at `squad-manager.ts:130`.

## Verify (concrete command + expected observable outcome)

`cd /home/lars/sui/omp-squad/.claude/worktrees/meta-plan-autonomous-fleet && bun test tests/confidence.test.ts` — new unit test asserts: `scoreConfidence({verificationState:"fresh",filesTouched:1})` → `0.9`; `{verificationState:"failed",filesTouched:20}` → `0.0` (clamped); `{verificationState:"stale",filesTouched:5}` → `0.5`; `{...,validator:"fail"}` drops below the no-validator score. Then run the daemon test that exercises a full run to end (e.g. `bun test tests/squad-manager` matching a finalizeRun path, with `node_modules/.bin` on PATH per the repo test gotcha) and confirm the persisted receipt JSONL line carries a numeric `confidence`.

## Scope boundary (what NOT to touch)

Do not change autonomy caps (leaf `03`), do not emit reports (leaf `05/06`), do not call codegraph or
any MCP tool at run-end (DESIGN.md D1 — blast radius is approximated by `filesTouched.length` only).
Do not add a `validator` producer — the param exists for Epic 3 but stays `undefined` here.
</content>
