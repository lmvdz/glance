# Signal-ranked reducer module (output-reduce.ts + text-util.ts)
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/output-reduce.ts (new), src/text-util.ts (new), src/gate-logs.ts, src/gate-runner.ts, src/observer.ts, tests/output-reduce.test.ts (new), tests/text-util.test.ts (new)

## Goal
A pure sync reducer core + async offload wrapper that keeps failure signal under a hard budget, fails open to bounded head/tail, and logs every non-fit decision.

## Approach
`src/text-util.ts` (new): `truncate(s,n)` (head+…, byte-identical to land.ts:213/validator.ts:42 locals), `truncateLabel(s,n)` (flatten+head, byte-identical to squad-manager.ts:8481/flue-service-driver.ts:238 locals), `stripAnsi(s)` (move the robust variant from observer.ts:154; observer.ts imports it back).

`src/gate-logs.ts`: export `headTail` (no behavior change).
`src/gate-runner.ts`: export `TESTS_RAN_RE`, `ZERO_TESTS_RE` (no behavior change).

`src/output-reduce.ts` (new):
- `type ReduceClass = "test" | "diagnostics" | "install" | "generic"`; `type ReduceReason = "fit" | "reduced" | "headtail-fallback" | "error"`.
- `classifyCommand(command, text): ReduceClass[]` — command regexes collect ALL matches (`\b(bun\s+test|vitest|jest)\b`→test; `\b(tsc|eslint)\b`→diagnostics; `\b(bun|npm|pnpm|yarn)\s+(install|add|ci)\b`→install), then shape fallback on ANSI-stripped text (`(fail)`/`✗`/`TESTS_RAN_RE`/`ZERO_TESTS_RE`→test; `error TS\d+:`/eslint rows→diagnostics; `npm ERR!`/`ERESOLVE`/`added \d+ packages`→install). Empty → `["generic"]`. Preserve table = union of all matched classes + the global CRITICAL tier.
- CRITICAL tier (tier 0, every class): marker/pointer grammar (`^\[\d+ (lines|bytes) omitted`), `error TS\d+:`, `^error(:| )`, `\bAssertionError\b`, `ERESOLVE|EACCES|EPERM`, `panic:`, `command not found`, `[1-9]\d* fail` summary.
- Class tiers written from CAPTURED real output (fixtures include raw ANSI): test = `(fail)`/`✗` lines, `^error: expect` assertion lines, `Expected:|Received:`, stack frames `^\s*at .*:\d+`, `\d+ pass\b.*\d+ fail\b` summaries; diagnostics = `error TS\d+:`, `^\s*\d+:\d+\s+(error|warning)`, `Found \d+ errors?`; install = `npm ERR!`, peer-dep conflicts, `EACCES|EPERM`, `^error `.
- `classifyAndReduce(text, budget, {command?}): {text, decision}` — sync, no I/O, never throws. Step 0: stripAnsi (match AND emit stripped lines). Neutralize input lines matching our own marker grammar (prefix `> `). Fit: post-strip length ≤ budget → unchanged, reason "fit". Fill: tag lines with tier = first matching regex (CRITICAL=0, class tiers 1..n); admit tiers ascending, document order within tier, COUNTING per-gap `[N lines omitted]` marker cost against the budget; remaining budget splits head/tail among untagged lines; reconstruct in original order. If the result isn't strictly smaller than headTail's or zero priority lines matched → `headTail(text, budget)`, reason "headtail-fallback". Any exception → headTail, reason "error". Result ALWAYS ≤ budget. Decision: `{class (first match, for legibility), classes, reason, originalChars (caller input length), charsSaved (recomputed on final text), preservedLines}`.
- `reduceOutput(text, budget, {command?, agentId?, source})` — async, never throws (offload/log failures degrade to core result, no pointer). When reason≠"fit": offload FULL original via `writeGateLog(agentId??"unknown", source, text)`, append `[N bytes omitted — full: <path>]` (pointer budgeted: body budget = budget − MAX_POINTER_LINE reserve). Logs one enriched decision; core called with logging suppressed so exactly one record per event.
- Decision log: `CompactionDecision` to lazy `JsonlLog` at `<root>/compaction.jsonl` with exported `setCompactionLogRoot(stateDir)` mirroring `setGateLogRoot` (called beside it later — concern 03 wires nothing; squad-manager.ts:921 gains the call in concern 05's pass since it's already touched there... NO: keep it here — add `setCompactionLogRoot(this.stateDir)` at squad-manager.ts:921 in THIS concern; one-line, avoids cross-concern file tangle). maxBytes 8MB. Export `recentCompactionDecisions(limit?)`.
- `identityNormalize(text)`: stripAnsi + strip pointer lines + strip `\[\d+(\.\d+)?ms\]` timing suffixes. Exported for concern 03.
- `OMISSION_POINTER_RE` exported.

## Cross-Repo Side Effects
None.

## Verify
`bun test tests/output-reduce.test.ts tests/text-util.test.ts tests/gate-logs.test.ts` green. Key cases: ≤-budget invariant on adversarial gap-heavy input; tier ordering (summary survives when frames overflow); union classification on `tsc && bun test` output keeps `error TS` lines; real-bun-ANSI fixture classifies test and preserves `(fail)`+summary; marker neutralization; fail-open equals headTail; decision ring exactly-one-entry with preservedLines; setCompactionLogRoot re-roots the file.
