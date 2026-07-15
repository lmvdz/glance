# Verify-loop steer path: signal-preserving reduce + identity safety
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/workflow/executor.ts, src/workflow/engine.ts, tests/executor-reflection.test.ts, tests/verify-escalate.test.ts (audit), tests/output-reduce-steer.test.ts (new or folded into existing)

## Goal
Steer messages keep failure tails; identical failures still register as identical to the no-progress and reflexion-refutation detectors; steer injection is fenced.

## Approach
1. executor.ts runCommand (line ~319-325): replace the `slice(0, MAX_CONTEXT_OUTPUT)` head-cut with `await reduceOutput(combined, STEER_BODY_BUDGET, {command: script, agentId: this.opts.reflection?.agentId, source: "executor-steer"})`. `STEER_BODY_BUDGET = 3800` — headroom so body+pointer(≤160)+unprovisioned prefix(~70) ≤ checkpoint's MAX_FIELD_BYTES 4096 (no re-reduction). `looksUnprovisioned` still checks the UNREDUCED combined. Prefix prepended after reduction, as today.
2. executor.ts runAgent (line ~197-199): wrap the steer injection in `fenceUntrusted("command output", ctx.vars.lastOutput)` — matching the adjacent reflection-note fencing (line 202). fenceUntrusted is already imported.
3. Identity safety (red-team critical RT2-1): engine.ts noProgressRoute (~355-369) and executor.ts reflectionNote (`hashOutput(ctx.vars.lastOutput)`, ~268) both compare via `identityNormalize()` from output-reduce.ts — strips pointer lines (unique ts+nonce per write), timing suffixes, ANSI. Without this, any >3800-char identical failure defeats both detectors on every visit.

## Cross-Repo Side Effects
None. Steer prompt shape changes (fence + omission markers) — flagged for blind review.

## Verify
New test: run the same >3800-char failing output through runCommand twice (fake execCommand) → the two lastOutput values normalize to equal strings; noProgressRoute short-circuits; reflexion refutation fires (outputHash equal). Existing executor-reflection + verify-escalate suites green. Assert steer text contains the failure line from the TAIL of a 10k-char synthetic bun-test output and is ≤ 4096 total.
