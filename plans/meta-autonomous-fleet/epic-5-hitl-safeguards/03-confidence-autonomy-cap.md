# Confidence cap → force propose-only (assist) below threshold

STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/autonomy.ts, src/squad-manager.ts, tests/autonomy.test.ts

## Goal (what is built)

Below a confidence floor, an agent's effective autonomy is capped to `assist` (propose-only: it works
and verifies, but `land` requires a human click) — exactly parallel to the existing
`blockedReason → observe` rule, but softer (it never blocks the agent, only removes autodrive/auto-land).

## Approach (how — cite real file:symbol attach points you verified)

- `src/autonomy.ts:7` `AutonomyPolicyInput` — add optional `confidence?: number;` and `confidenceFloor?: number;`.
- `src/autonomy.ts:30` `effectiveAutonomyMode` — after the `blockedReason → "observe"` line (`:31`), before the final rank-min return (`:32`), add: if `input.confidence !== undefined && input.confidenceFloor !== undefined && input.confidence < input.confidenceFloor`, cap the result to at most `assist` (i.e. `Math.min(rank[...], rank["assist"])`). `maxEffectiveMode` (`:24`) stays untouched — the cap is a per-run signal, not an approval/automation policy.
- `src/squad-manager.ts:557` `syncAuthority` — the `effectiveAutonomyMode({...})` call at `:563` gains `confidence: dto.confidence` and `confidenceFloor: confidenceFloor()`. Add a module-level `function confidenceFloor(): number { return Number(process.env.OMP_SQUAD_CONFIDENCE_FLOOR) || 0.4; }` near the other env-knob helpers (e.g. beside `autoLandFailCap` at `squad-manager.ts:222`).
- The `create()`-time call at `squad-manager.ts:2755` needs no change (a fresh agent has no `confidence` yet → `undefined` → cap inert).

## Verify (concrete command + expected observable outcome)

`cd /home/lars/sui/omp-squad/.claude/worktrees/meta-plan-autonomous-fleet && bun test tests/autonomy.test.ts` — new cases assert: `effectiveAutonomyMode({requested:"autodrive",approvalMode:"yolo",autoLand:true,landConfirm:false,confidence:0.2,confidenceFloor:0.4})` → `"assist"` (capped); same with `confidence:0.9` → `"autodrive"` (uncapped); `confidence:undefined` → `"autodrive"` (inert). Then in a running daemon set `OMP_SQUAD_CONFIDENCE_FLOOR=0.99`, finish a run, and confirm via `GET /api/agents` (or the webapp roster) that the agent's `effectiveMode` is `assist` and `availableActions` excludes `land` until a human acts.

## Scope boundary (what NOT to touch)

Do not touch `maxEffectiveMode` or `modeFromApproval`. Do not make the cap block the agent (never
`observe` — that path stays owned by `blockedReason`). Do not compute confidence here (leaf `02`) — this
leaf only *consumes* `dto.confidence`.
</content>
