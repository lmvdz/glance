# Lane taxonomy, classifier, and clamped policy constants
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/lane.ts (new), src/intake.ts, tests/lane.test.ts (new)

## Goal
A closed `WorkLane = "hotfix" | "feature" | "chore"` union with a classifier and hard-constant per-lane policy, shipped shadow-first, so downstream systems (model route, cost gate, race) share one legible key.

## Approach
- `src/lane.ts` (new):
  - `export type WorkLane = "hotfix" | "feature" | "chore"` — mirrors the string-literal union convention in `src/types.ts` (`ApprovalMode`, `ThinkingLevel`).
  - `LANE_POLICY: Record<WorkLane, LanePolicy>` as **hard constants** — no env-JSON schema (red-team S3: the repo already has `policy.json` + agent profiles + 179 `OMP_SQUAD_*` vars). Fields v1: `{ modelRouteApply: boolean; modelRouteMinEdge?: number; costCeilingUsd?: number; costAction: "shadow" | "ask" | "deny"; race: 0 | 1 }`. Defaults: hotfix `{modelRouteApply:false→flip later, lower minEdge, race:1, costAction:"shadow"}`, feature all-shadow, chore `{costCeilingUsd: low, costAction:"shadow"→"deny" in concern 09, race:0}`.
  - `classifyLane(task: string, repo: string, classify?: Classify): Promise<{lane: WorkLane; source: "heuristic" | "llm" | "default"; reason: string}>` — heuristic regexes first (hotfix: `revert|hotfix|outage|prod(uction)? (bug|break)|regression|broken main|urgent`; chore: `bump|rename|typo|reformat|comment|dep(endency)? update|chore`), LLM fallback shares the shape of `src/intake.ts`'s `llmRoute`.
  - Operator override seam: if a `dispatch`-seam rule in the existing policy store (`src/policy.ts`, `PolicySubject { seam: "dispatch" }`) names a lane parameter, it wins over constants — extend the subject with an optional `lane` field rather than inventing new storage.
- `src/intake.ts`: extend `ROUTER_PROMPT`'s JSON contract with `"lane"` so the existing single `llmRoute` call classifies lane at zero extra LLM cost; `IntakeDecision` gains `lane?: WorkLane`. Note (red-team M2): the smol call has a 1s timeout and silently falls back — most lanes will be heuristic under load; nothing security-relevant may hang off classification (see clamp in concern 02).
- Shadow logging: every classification logs `lane [shadow]: <lane> source=<s> reason=<r>` mirroring the `model-route [shadow]` precedent, and increments a counter surfaced via the attribution scoreboard (shadow exit: concern 09's checkpoint reads this).

## Cross-Repo Side Effects
None.

## Verify
- `bun test tests/lane.test.ts` — classifier fixtures for each lane + default; clamp table exhaustiveness (TypeScript exhaustive switch compiles).
- Spawn a unit with task "revert the broken prod migration" on a scratch daemon → log shows `lane [shadow]: hotfix`.
- Grep proof no new env-JSON config: `grep -rn "LANE_POLICY" src/ | grep -v lane.ts` only shows imports.
