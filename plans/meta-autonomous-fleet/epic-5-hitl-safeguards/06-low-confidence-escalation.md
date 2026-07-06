# Low-confidence auto-escalation (the join: confidence → propose-only + auto-report)

STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/squad-manager.ts, tests/confidence-escalation.test.ts

## Goal (what is built)

The behavior that makes Epic 5 a *brake*: when a run finishes below the confidence floor, the manager
(a) has already dropped it to `assist`/propose-only via the leaf-`03` cap, and (b) **auto-emits a
non-blocking report** so a low-confidence unit surfaces as a "Needs you" row instead of silently
sitting land-ready. Pure composition of `02` (score) + `03` (cap) + `05` (report channel).

## Approach (how — cite real file:symbol attach points you verified)

- In `src/squad-manager.ts` `finalizeRun` (`:4363`), right after `rec.dto.confidence = conf;` (added by leaf `02` near `:4393`): if `conf < confidenceFloor()` (the helper added by leaf `03` near `:222`), synthesize an `AgentReport` and push it onto `rec.dto.reports` (the channel from leaf `05`) — `{ id: `auto-${receipt.runId}`, summary: `Low confidence (${conf.toFixed(2)}) — verify before landing`, proposal: <touched-files summary from receipt.filesTouched>, confidence: conf, createdAt: Date.now() }`. De-dupe by `runId` so a re-finalize (agent_end + exit both fire — see the `run.finalized` idempotency note at `:4365`) never doubles the report.
- Call `this.syncAuthority(rec.dto)` after stamping confidence so the leaf-`03` cap is recomputed with the fresh `dto.confidence` (finalizeRun otherwise sets `effectiveMode` before confidence exists). Confirm `syncAuthority` (`:557`) is safe to call here (it is pure over `dto`).
- No new fields, no new tool — this is wiring three shipped pieces at one seam.

## Verify (concrete command + expected observable outcome)

`cd /home/lars/sui/omp-squad/.claude/worktrees/meta-plan-autonomous-fleet && bun test tests/confidence-escalation.test.ts` (with `node_modules/.bin` on PATH) — drive a run to `finalizeRun` with a `failed` proof + large `filesTouched` (forcing `conf < 0.4`); assert the resulting `dto.reports` has exactly one `auto-*` report AND `dto.effectiveMode === "assist"` AND `land` is absent from `dto.availableActions`. A high-confidence run (fresh proof, few files) produces zero auto-reports and keeps its requested mode. Re-running finalize is idempotent (still one report).

## Scope boundary (what NOT to touch)

Do not change the scorer weights (`02`), the cap logic (`03`), or the report type/tool (`05`) — only
compose them. Do not block the agent. Do not auto-emit above the floor.
</content>
