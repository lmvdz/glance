# Overview — HumanLayer + BAML uplift

STATUS: open
PRIORITY: p1
REPOS: omp-squad

Decompose of three operator-selected goals from `plans/research-humanlayer-baml/BRIEF.md`, refined by an adversarial design pass (see `DESIGN.md` → "Red Team Concerns Addressed"). Borrow patterns, never adopt dependencies (ponytail).

## Execution model (operator decision — READ THIS)

This plan is to be **built by omp-squad on itself** (self-drive / dogfood), **after** the in-flight `web-framework` and `context-thermodynamics` plans land. Path: these concern docs → `/plan-to-plane` → Plane issues → omp-squad auto-dispatch spawns routed agents on this repo (issue → verify → land → close).

Consequences for the concern docs:
- Each concern is **self-contained** — a cold agent implements it from the doc alone, no follow-up questions. A wrong seam in a self-drive doc is a *silent wrong build*, so the corrected seams from the red team are baked in.
- Concerns carry `/plan-to-plane` frontmatter (STATUS/PRIORITY/COMPLEXITY/TOUCHES).
- Subagents do NOT run project-wide gates; each concern's own `Verify` is the local gate. The fleet's verify loop runs `bun run check && bun test` on land.

## Scope

| # | Concern | Goal | COMPLEXITY | TOUCHES (primary) |
|---|---|---|---|---|
| 01 | Coercion characterization tests | 1 | mechanical (careful) | `tests/llm-coerce.test.ts` (new), `tests/supervisor.test.ts`, `tests/smart-spawn.test.ts`, `tests/intake.test.ts` |
| 02 | `decideTyped` transport+fallback wrapper | 1 | architectural | `src/omp-call.ts`, `src/supervisor.ts`, `src/smart-spawn.ts`, `src/intake.ts` |
| 03 | Off-dashboard escalation (sink + urgency) | 2 | architectural | `src/webhook-sink.ts` (new), `src/server.ts`, `src/push.ts`, `src/types.ts`, `src/squad-manager.ts`, `README.md` |
| 04 | Artifact comment store (event-log) | 3 | architectural | `src/comments.ts` (new), `src/squad-manager.ts`, `tests/comments.test.ts` (new) |
| 05 | Comment API + SPA panel | 3 | architectural | `src/server.ts`, `webapp/**`, `README.md` |
| 06 | RPI comment feed-forward | 3 | architectural | `src/workflow/executor.ts`, `src/workflow/types.ts`, `src/workflow-driver.ts`, `src/squad-manager.ts` |

## Dependency graph

```
Goal 1 (track A):  01 ──▶ 02
Goal 2 (track B):  03                 (A ∥ B — file-disjoint)
Goal 3 (track C):  04 ──▶ 05
                     └──▶ 06          (C after B; whole track BLOCKED_BY web-framework)
```

| Concern | BLOCKED_BY | VERIFY_BLOCKER (30s check the blocker is real at execution time) |
|---|---|---|
| 01 | — | — |
| 02 | 01 | `bun test tests/llm-coerce.test.ts tests/supervisor.test.ts` is green (the parity fixtures exist and pass against current code) |
| 03 | — | — |
| 04 | `web-framework` landed; 03 | (a) web-framework: `grep -rl "STATUS: open" plans/web-framework/*.md` returns nothing AND `OMP_SQUAD_WEBAPP=1` serves the SPA; (b) 03: `grep -q "NotificationSink" src/server.ts` |
| 05 | 04; `web-framework` | `grep -q "artifacts/comments" src/server.ts` (04's API merged) AND `webapp/` builds (`cd webapp && bun run build`) |
| 06 | 04 | `grep -q "addComment\|listComments" src/squad-manager.ts` (04's store merged) |

**Every BLOCKED_BY is a file/region overlap or a value-dependency, not a guess** — Goal 1's files are untouched by 2/3 (verified RedTeam 4A); Goal 2 and Goal 3 both edit `server.ts`+`squad-manager.ts` so 3 waits on 2 (RedTeam 4B); Goal 3 is dead code without its SPA UI so the whole track waits on `web-framework` (RedTeam F14).

## Batch order

- **Batch 1 (now-ready):** `01` ∥ `03` — disjoint files, parallel-safe.
- **Batch 2:** `02` (after `01` green).
- **Batch 3 (deferred until `web-framework` + `context-thermodynamics` land):** `04`.
- **Batch 4:** `05` ∥ `06` (both after `04`; `05` also after `web-framework`). `05` touches `server.ts`+`webapp/`; `06` touches `workflow/*`+`squad-manager.ts` — minor `squad-manager.ts` overlap, sequence or rebase.

Estimated 4 batches; Batches 1–2 are unblocked today, Batches 3–4 wait on the operator's two in-flight plans.

## Shared-file notes (for context propagation between agents)

- `src/squad-manager.ts`: Goal 2 (`03`) edits `onUi`/`onHostTool`/`maybeAutoSupervise`; Goal 3 (`04` store methods near `recordAudit`, `06` planDir threading). Later agents get the prior diff.
- `src/server.ts`: Goal 2 (`03`) edits `escalationPayload`/`maybePushAlert`/constructor sink-wiring; Goal 3 (`05`) adds endpoints in the features routing cluster (~494). Different regions.
- `src/omp-call.ts`: only Goal 1 (`02`) adds `decideTyped`; leaf module, no import cycle.

## Status

This plan is **planned, not executed** (operator deferred execution to the self-drive fleet). Closing happens per-concern as the fleet lands each.
