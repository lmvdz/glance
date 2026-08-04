# Attention-items pipeline — built, tested, never rendered
STATUS: done
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: moderate
TOUCHES: webapp/src/lib/insights.ts (attentionItems), webapp/src/lib/fleetRoster.ts, webapp/src/components/ui/AttentionRow.tsx, webapp/src/lib/pageContextDerive.ts (deriveFleetPageContext)
MODE: afk

## Origin
Filed during concern 14 (iteration 21): while hunting a render surface for the starvation
verdict, the insights.attentionItems → buildFleetRoster → AttentionRow chain turned out to have
NO live render site — the room pivot (plans/the-room) superseded the panels that consumed it.
The built-but-unrendered incident class (see omp-squad-surfaced-invisible-observability,
omp-squad-ui-trust-legibility): tested code that claims observability nobody receives.

NOTE: this file was originally created on the deepen/14 branch (PR #313) and is recreated here
on the 17 branch with the resolution — the branch-topology split means concern files travel
with their PR branches until the train merges.

## Resolution (2026-08-04, iteration 36): DELETE — the room pivot already replaced it
Evidence, verified off current main:
- `attentionItems` / `buildFleetRoster` / `deriveFleetPageContext` / `AttentionRow`: zero
  non-test consumers (grep across webapp/src components, App wiring, context providers).
- The LIVE attention surfaces are the needs-you ladder (attention-ladder.ts →
  GET /api/attention/ladder → per-unit rungs) and MondaySurface (starved-work section).
- `activeWork`/`activeWorkDigest` in insights.ts ARE live (sendCore's fleet snapshot) — kept.
- `harnessScorecardFindings`: KEPT but corrected (codex M): it is test-only too — retained
  because it is a DELIBERATELY-shadow deliverable per its own design doc
  (plans/research-learn-harness-engineering/03), not because it renders.

## Correction (codex HIGH on the deletion round): "superseded" was overclaimed
The ladder + room cover STATUS-driven attention (pending, error, land-ready). They do NOT
cover the non-blocking signal channels the deleted rows also carried: `AgentDTO.reports`
(squad_report proposals), `attentionEvents` (squad_attention / harness notify / boundary-sync
"held" with its one-click Apply, "divergence" with its Acknowledge). Post-deletion those
signals render NOWHERE — which was equally true before (the pipeline was dead), but the gap is
now NAMED instead of hidden behind dead code. Queued as a candidate for the next
architecture-review round: room-aligned rendering for reports/attentionEvents (cards per
DIRECTION.md — layer-2 events project into the room), with boundary-sync's Apply/Acknowledge
actions as the load-bearing case. The squad-manager honest-label comment now says this too.
Deleted: the ~300-line attentionItems block (+ types + SEVERITY_RANK), fleetRoster.ts (+156
lines + test), AttentionRow.tsx (+ barrel export), deriveFleetPageContext (+ test block).
Squad-manager's honest-label comment updated to name the deletion. Dead-exports ratchet
expected to IMPROVE. Per DIRECTION.md: unrendered observability is a defect, and code that
duplicates the live ladder under a dead panel is fatigue, not safety.

## Process note (from the original filing)
The concern's first filing was lost to the iteration-21 cwd accident (a persisted `cd webapp`
made the file-creation script silently no-op) — the rule since: absolute paths or re-asserted
cwd in every goal-turn script, and background suite invocations always cd absolutely.
