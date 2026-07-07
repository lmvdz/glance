# Drift probe core — action-free lens + durable judge-confirmed audit record
STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/drift-lens.ts, src/drift-audit.ts, test/drift-lens.test.ts, test/drift-audit.test.ts

## Goal
Two new, self-contained modules that together form the MONITOR and the JUDGE-confirmation-to-record path of Sentinel v0 — with **no edits to any existing file**, fully headless-testable via injected deps. This concern deliberately builds nothing that touches Scout or the manager (that is concern 02), so the core lands and is unit-tested in isolation.

The interpretability contract is enforced structurally: `src/drift-lens.ts` (the MONITOR) imports nothing that can act — no `validator.ts`, no `rpc-agent.ts`/`steer`, no `squad-manager.ts`. Its only output is a returned `Hypothesis | null`. The JUDGE and the durable record live in `src/drift-audit.ts` and are only ever invoked by the manager-side sink (wired in concern 02), never by the lens.

## Approach

### `src/drift-lens.ts` — the MONITOR (pure + injected LLM)
Model it on `src/scout.ts`'s pure surface (`buildPrompt`/`parseTickets`/`titleTokens`), NOT on its class. Export:

- `type DriftKind = "wrong-direction"` (a union of one for now — leave room, ship one).
- `type DriftSeverity = "low" | "medium" | "high"`.
- `interface Hypothesis { kind: DriftKind; severity: DriftSeverity; agent: string; runId?: string; evidence: string; rationale: string; at: number }` — a HYPOTHESIS, never a verdict. `evidence` is a short verbatim excerpt from the reasoning; `rationale` is the model's one-line reason.
- `buildDriftPrompt(task: string | undefined, criteria: FeatureCriterion[], reasoning: string): string` — pure. Prompt frames the job as: "Here is an engineer's DECLARED acceptance criteria and a slice of their working reasoning. Is the reasoning trending AWAY from satisfying these criteria — pursuing a different goal, abandoning the task, or redefining success? Return `{drift:null}` if the work looks on-track (be conservative — default to null)." Return `{drift:{severity,evidence,rationale}}` else. Mirror Scout's "be conservative, return empty if nothing qualifies" discipline and its `MAX_TEXT` tail-slice (conclusions live at the end of reasoning). Include the criteria text so "away from WHAT" is grounded.
- `parseDriftHypothesis(raw, ctx): Hypothesis | null` — pure, tolerant of fences/prose (reuse `extractJsonObject` from `omp-call.ts` like Scout does). Coerce severity to the union (default "low"); reject if no evidence/rationale.
- `sentinelEnabled(): boolean` = `process.env.OMP_SQUAD_SENTINEL === "1"` — **default OFF** (note: inverse of Scout's default-on `!== "0"`; v0 is opt-in).
- `sentinelMaxCallsPerHour(): number` from `OMP_SQUAD_SENTINEL_MAX_CALLS_PER_HOUR` (default 30), and construct a **separate** `ScoutCallBudget` instance (import the class from `scout.ts` — it is already exported and self-contained) so drift classification never consumes Scout's backlog budget.

Do NOT put an LLM call inside the lens file's pure functions; the caller (concern 02) owns `extract`. The lens is prompt + parse + config only, exactly like Scout's pure exports.

### `src/drift-audit.ts` — the JUDGE-confirmation + durable record
- `interface DriftAuditEntry { runId?: string; agent: string; kind: DriftKind; severity: DriftSeverity; evidence: string; rationale: string; judgeVerdict: ValidationRecord["verdict"]; agreement: number; ts: number }`.
- `driftAuditPath(stateDir): string` → `path.join(stateDir, "sentinel-audit.jsonl")` (mirror `receipts.ts`'s `path.join(baseDir, "receipts", ...)` and `automation-log.ts`'s `automation.jsonl`). Append-only via `appendFileSync` (one JSON line per entry). Off the run record so it survives `finalizeRun`'s `rec.run=undefined` teardown.
- `appendDriftAudit(stateDir, entry): void` — best-effort, never throws (log-and-swallow like Scout's `saveSeen`).
- `confirmDrift(deps): Promise<DriftAuditEntry | null>` — the JUDGE path, injected for headless test:
  ```
  interface ConfirmDeps {
    hypothesis: Hypothesis;
    criteria: FeatureCriterion[];
    diff: () => Promise<string>;        // working-tree diff, injected (concern 02 supplies gitDiffAgainstHead(worktree))
    judge?: Judge;                       // defaults to validator.ts scoreAgainstCriteria's default judge
    stillLive: () => boolean;            // runId turnover guard — false ⇒ the run turned over, abort
    stateDir: string;
    now?: () => number;
    log?: (m: string) => void;
  }
  ```
  Body: if `!stillLive()` → return null (RACE GUARD before the judge call, per red-team A3). Compute `diff()`; call `scoreAgainstCriteria(criteria, diff)` (import from `validator.ts`). Re-check `stillLive()` before writing (guard again). Build the entry with the verdict/agreement, `appendDriftAudit`, return it. `abstain` (thin/empty diff) and `skipped` (no criteria) are recorded verdicts, not errors — they are the honest "could not confirm yet" labels the precision measurement needs.

`confirmDrift` may import `validator.ts` (`scoreAgainstCriteria`, `Judge`) — the JUDGE is allowed to. Only the MONITOR (`drift-lens.ts`) must stay import-clean.

## Cross-Repo Side Effects
None. Two new files + their tests. No existing file changes.

## Verify
- `bun test test/drift-lens.test.ts test/drift-audit.test.ts` green (ensure `node_modules/.bin` on PATH per the known bun-test gotcha).
- Tests must cover: on-track reasoning → `parseDriftHypothesis` returns null; drifting reasoning → a `wrong-direction` hypothesis with evidence; `sentinelEnabled()` false unless env=1; the sentinel budget is a distinct instance from Scout's; `confirmDrift` aborts (returns null, writes nothing) when `stillLive()` is false BEFORE the judge runs; `confirmDrift` records `abstain` on empty diff and `veto`/`pass` on a fake judge; `sentinel-audit.jsonl` gets one appended line per confirmed hypothesis and the file survives independent of any run object.
- Static check (the contract): `grep -nE "from \"\./(validator|rpc-agent|squad-manager)" src/drift-lens.ts` returns **nothing** — the monitor is structurally action-free.

## Resolution
Shipped. `src/drift-lens.ts` (action-free monitor: `Hypothesis`, `buildDriftPrompt`, `parseDriftHypothesis`, `sentinelEnabled` default-off, separate `newSentinelCallBudget`) + `src/drift-audit.ts` (append-only `sentinel-audit.jsonl`, `confirmDrift` with the two-point runId guard reusing `scoreAgainstCriteria`). 21 unit tests green; contract grep clean; `tsc` clean. Commits on branch `worktree-research-global-workspace` (a868559 plan → implementation + audit-fix commit below).
