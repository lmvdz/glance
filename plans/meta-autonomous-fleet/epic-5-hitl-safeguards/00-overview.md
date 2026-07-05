# Epic 5 — HITL safeguards (sub-plan)

## Outcome

The loop grows a brake. A run scores its own confidence at run-end; below a floor it is forced into
propose-only (`assist`) so landing needs a human click, and it auto-emits a **non-blocking** report
("I'm unsure, here's a proposal") that appears as a "Needs you" row. Separately, a drifting (gone-quiet)
unit surfaces a steer row that redirects it mid-flight. Together: a low-confidence unit escalates to a
human instead of silently landing — with zero new blocking gates on the happy path.

## Design decisions (see DESIGN.md)

- **D1** Confidence is a *pure deterministic* run-end score from signals that exist today
  (`verificationState` + `filesTouched`); validator agreement is an optional param that stays `undefined`
  until Epic 3, folded in with no caller change. Absent validator never penalizes.
- **D2** A report is a **separate append-only channel** (`AgentReport[]`), NOT a `pending` entry —
  because `pending.length` is load-bearing for blocked status + the observe cap. Report = non-blocking.
- **D3** The steer trigger is **activity-staleness** (`working` + no activity > 15 min), the only
  always-present drift signal on the DTO.

## Work table

| # | Concern | Complexity | Leaf | Touches (verified) |
|---|---|---|---|---|
| 01 | Confidence field on RunReceipt/AgentDTO + DTO mirror | mechanical | yes | src/types.ts, webapp/src/lib/dto.ts |
| 02 | Deterministic scorer `src/confidence.ts` + run-end wiring | architectural | yes | src/confidence.ts, src/squad-manager.ts, tests/ |
| 03 | Confidence cap → force `assist` below floor | architectural | yes | src/autonomy.ts, src/squad-manager.ts, tests/ |
| 04 | Steering lane: stalled row → steer command | architectural | yes | webapp insights.ts, agent-control.ts, AttentionPanel.tsx, tests/ |
| 05 | `squad_report` non-blocking host tool → report row | architectural | yes | src/types.ts, src/squad-manager.ts, webapp dto.ts + insights.ts + AttentionPanel.tsx |
| 06 | Low-confidence auto-escalation (join of 02+03+05) | mechanical | yes | src/squad-manager.ts, tests/ |
| 07 | Distilled-lesson → future-agent behavior | research | **no** | — (Epic 6 territory; stub) |

## Batch order

- **Batch A (parallel):** `01`. (unblocks the confidence chain)
- **Batch B (parallel):** `02`, `03`, `04`, `05`. — `02`+`03` both depend on `01`; `04` and `05` are
  independent of everything (04 is webapp-only; 05 adds its own type). All four can run at once.
- **Batch C:** `06` — the join; needs `02`, `03`, `05` merged.
- **Not scheduled:** `07` — hand to Epic 6.

## Dependency graph (30s check per edge)

```
01 ──▶ 02 ──▶ 06
  └──▶ 03 ──▶ 06
        05 ──▶ 06
        04  (independent)
        07  (deferred → Epic 6)
```

- `01 → 02`: the scorer stamps `receipt.confidence`/`dto.confidence` — those fields must exist first.
  30s: `grep confidence src/types.ts` returns the field before `02` references it.
- `01 → 03`: the cap reads `dto.confidence`. 30s: same grep; `03`'s `syncAuthority` change compiles only
  if the field exists.
- `02 → 06`: escalation branches on the numeric `conf` computed in `02`'s finalizeRun block. 30s: `06`'s
  diff sits immediately after `02`'s `rec.dto.confidence = conf` line.
- `03 → 06`: escalation asserts `effectiveMode === "assist"`, which is `03`'s cap firing. 30s: `03`'s
  autonomy test is green before `06`'s escalation test runs.
- `05 → 06`: escalation pushes an `AgentReport` onto the channel `05` defined. 30s: `grep AgentReport
  src/types.ts` returns the type before `06` constructs one.
- `04 ⟂ all`: steer touches only webapp files + adds `steerCommand`; no dependency on confidence/report.
  30s: `04`'s files don't overlap `01/02/03/06` server changes.

## Verify (epic-level acceptance)

Force a low-confidence run (fail proof, wide blast radius): the agent (a) shows `effectiveMode: assist`
with `land` absent from `availableActions`, and (b) surfaces an `auto-*` report as a warn "Needs you"
row with the proposed touched-files summary — while its status never flips to `input` (non-blocking).
Separately, let a working agent idle past `OMP_SQUAD_STALL_MS`, click Steer, and confirm the redirect
text lands as a live user turn in that agent's transcript.
</content>
