# Attention-items pipeline is unrendered — built surfaces with no render site
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: moderate
TOUCHES: webapp/src/lib/insights.ts (attentionItems), webapp/src/lib/fleetRoster.ts, webapp/src/components/ui/AttentionRow.tsx, GET /api/action-items consumers
MODE: afk

## Goal
Discovered during deepen 14 item 1 (2026-08-04): the attention-items pipeline —
insights.attentionItems → fleetRoster → AttentionRow — has NO live render site; the room-pivot
UI (HubShell/MondaySurface) superseded the panels that consumed it. This repeats the historic
"built but unrendered" incident class (TaskClassMatrixPanel, openIntervene). Decide: wire the
pipeline into the live UI (needs-you ladder / room), or retire it deliberately (deletion test:
its logic partially duplicates what the roster/ladder already renders). Either way the server's
actionItemsPayload consumers should match what actually renders.

## Provenance
Self-caught during deepen 14 (iteration 21); recorded in the reviewer ledger (native lineage).
Process note: the first attempt to file this concern silently failed — a persisted `cd webapp`
made relative paths land nowhere (cat > plans/... with no plans dir) while chained commands ran
on. Same accident stalled the apply-mode test flips. Rule: goal-turn scripts state absolute
paths or re-assert cwd first.
