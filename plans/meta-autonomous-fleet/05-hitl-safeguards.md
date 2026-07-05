# Epic 5 — HITL safeguards
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/autonomy.ts, src/digest.ts, src/squad-manager.ts, src/types.ts, webapp/src/lib/insights.ts
SUBPLAN: plans/meta-autonomous-fleet/epic-5-hitl-safeguards/

## Goal

First-class confidence scoring; an automatic flip into propose-only mode below threshold; an exception-triggered steering lane; and a non-blocking report primitive ("I'm unsure, here's a proposal"). Together these are the loop's brake — the reason a low-confidence unit escalates to a human instead of silently landing.

## Approach

**Confidence scoring — net-new, clean home.** No unit emits a self-confidence signal today (the only `confidence` is `scoreValidation` in `src/feedback.ts` scoring external user votes). Compute it at run-end where `buildDigest()` runs (`src/squad-manager.ts`), from validator agreement (Epic 3), test coverage, and `codegraph_impact` blast radius; add a field to `AgentDTO`/receipt in `src/types.ts`.

**Propose-only — a trigger, not a build.** `src/autonomy.ts` already models `observe|assist|autodrive`, and `assist` IS propose-only (agent works + verifies, human clicks Land; `availableActions` gates `land` behind `mode !== "observe" && verificationState === "fresh"`). Add a confidence cap in `maxEffectiveMode()`/`effectiveAutonomyMode()` that forces `assist` below threshold — exactly parallel to how `blockedReason` already forces `observe`.

**Steering lane — exception-triggered wrapper.** Per-agent steering exists (`prompt`/`interrupt` `ClientCommand`s → RPC `steer`). Missing: a lane that redirects a unit *because* it's drifting. Add an `AttentionActionKind: "steer"` in `insights.ts:435` next to `answer`/`restart`, wired to `applyCommand({type:"prompt"})`, hung off an `attentionItems` row.

**Report primitive — new host tool.** The only upward channel is the blocking `PendingRequest` (`source: "ui"|"tool"`). Add a `squad_report` host tool alongside `SQUAD_HOST_TOOLS` (`src/squad-manager.ts:184`), handled in `onHostTool` before the tool-grant gate, creating a **non-blocking** `PendingRequest` variant (`source: "report"`, carrying a proposed diff/summary) that `attentionItems()` already knows how to render. Natural pair to confidence: low confidence → auto-emit a report + drop to propose-only.

## Decomposition seed (candidate leaves for the sub-plan)

- `confidence` field on `AgentDTO`/receipt + `src/types.ts`; DTO mirror; round-trip test.
- Run-end confidence computation at the `buildDigest` seam (validator agreement + coverage + impact).
- Confidence cap in `maxEffectiveMode`/`effectiveAutonomyMode` → forces `assist` below threshold.
- `AttentionActionKind: "steer"` + wiring to `applyCommand({type:"prompt"})`.
- `squad_report` host tool → non-blocking `PendingRequest(source:"report")` → `attentionItems` row.
- Learning-to-agents: distilled-lesson path (pairs with Epic 6) so a recurring failure changes future agent behavior, not just retrieval.

## Verify

Force a low-confidence run; confirm it (a) drops to `assist`/propose-only so land requires a human click, and (b) auto-emits a non-blocking report that appears as a "Needs you" row with the proposed diff. From an `attentionItems` steer row, redirect a running unit mid-flight and confirm the steer reaches the live agent.
