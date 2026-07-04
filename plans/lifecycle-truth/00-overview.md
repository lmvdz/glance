# Lifecycle truth — overview

STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural

## Goal

Agent lifecycle state becomes trustworthy and explainable:

1. A guarded single write-path for `AgentStatus` with a declared transition table and persisted `{from,to,reason,at}` history, replacing ~19 scattered `rec.dto.status=` / `rec.dto.pending=` writes across `src/squad-manager.ts`.
2. A state-transition timeline surfaced in the webapp agent detail (`webapp/src/components/TaskDetail.tsx`) and available to `webapp/src/lib/insights.ts`.
3. Pause-as-durable-state: `pending[]` requests persisted and restored across daemon restart/adoption so "input" is a real recorded state with the question attached, without resurrecting already-answered ghosts.

## Why (source)

`plans/research-burr/BRIEF.md` (Apache Burr research) plus a two-round adversarial red-team on the initial draft design. Full code-verified landscape, the two-class reason model, the settle-gate replay fix, and every resolved red-team concern are recorded there and in the arbiter decision log — this overview does not repeat them; each concern below carries only what its implementer needs.

## Concern order (sequential, each builds on the previous)

1. **01-lifecycle-write-path.md** — `src/agent-lifecycle.ts` (new pure module) + guarded `transition()`/`setPending()` on `SquadManager` + per-site swap of all 19 status / 5 pending writes + settle gate + enforcement test. This is the foundation; nothing else can land first.
2. **02-transition-history.md** — `JsonlLog<T>` (new module) + `transitions.jsonl` + `{type:"transition"}` SquadEvent + `GET /api/agents/:id/transitions` + redaction wiring. Depends on 01's `transition()`/`setPending()` existing as the single call site to hook.
3. **03-webapp-timeline.md** — Timeline strip in `TaskDetail.tsx`, `webapp/src/lib/dto.ts` mirror fields, `insights.ts` rollup consumption. Depends on 02's DTO fields + endpoint.
4. **04-durable-pending.md** — `PersistedAgent.pending`, debounced persist, cold-adopt orphan-close, replay ghost expiry. Depends on 01 (setPending exists, settle gate exists) but is otherwise independent of 02/03 — could land in parallel with those if desired, noted per-concern.

## Dependency graph

| Concern | Blocked by | 30s check |
|---|---|---|
| 01-lifecycle-write-path.md | — | — |
| 02-transition-history.md | 01-lifecycle-write-path.md | `grep -n "private recordTransition\|private recordDenied" src/squad-manager.ts` returns two hits |
| 03-webapp-timeline.md | 02-transition-history.md | `grep -n "transitionHistory\|interface TransitionEntry" src/squad-manager.ts src/types.ts` returns hits |
| 04-durable-pending.md | 01-lifecycle-write-path.md | `grep -n "private readonly settling\|private setPending" src/squad-manager.ts` returns hits |

## Explicit scope cuts (do not build in this slice)

- `workflow_journal` interleaving (BRIEF pattern 7) — follow-up, carries the dropped-frame finding.
- `server.ts` `maybePushAlert`'s private `lastStatus` diff replacement with a subscription to the new transition event — follow-up, `pushSeeded` semantics must be preserved whenever it lands.
- Any refactor of `src/automation-log.ts` — it stays untouched; concern 02 hand-rolls a small parallel `JsonlLog<T>`, not an extraction.
- CI grep-based enforcement — replaced by a `bun test` that parses `squad-manager.ts`'s source (rtk mangles local grep output; a unit test survives line drift).

## Outcome

- Every `AgentStatus` and `pending[]` mutation in `squad-manager.ts` goes through exactly two guarded methods with a declared, code-verified transition model — bugs in status handling become detectable (denied transitions are logged and spooled, never silently dropped).
- Operators can see, per agent, the last 5 significant state changes inline and the full history via API, with cause strings attached and secrets redacted.
- A daemon restart or crash no longer silently loses "this agent was waiting on you" — the question survives, but never as an unanswerable ghost.

## Notes

- /plan Phase 0 snapshot (headless chained run): proceeded over 3 plans with open concerns (agentic-learning-loop 5, factory-control-plane 3, change-driven-loops 2; all last-touched 2026-07-03).

## Completion
4/4 concerns closed 2026-07-04 on feat/lifecycle-truth (suite 1073→1122 root + 321 webapp, tsc clean). Post-batch audit: /code-review high (10 confirmed findings) + fable cross-batch audit (2 significant) — all 12 fixed in 3a6ccd8/8828721/cd5eee4/e44e9f2/4ead110. Follow-ups deliberately deferred: live acceptance test to un-gate OMP_SQUAD_PENDING_GHOST_EXPIRY; server.ts lastStatus push-diff replacement via transition events (scope cut in this plan).
