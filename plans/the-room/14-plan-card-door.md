# Plan-card door — plans arrive in the room, open the DAG
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/transcript-event-kinds.ts, plan emit site (plan pipeline/factory), webapp/src/components/hub/PlanCard.tsx (new), router (TaskDetail/plan-DAG route), tests
BLOCKED_BY: 05, 08
MODE: afk

## Goal
When an agent prepares or revises a plan, a plan-card appears in the room; the door opens the
existing plan flow-diagram surface (dependency DAG in TaskDetail) where Lars digs in and modifies
the design — his layer-2 verb, reached from chat.

## Approach
1. plan-card kind + reader together. Emit where plan artifacts are produced/updated in the
   pipeline (locate at implementation: the plan/factory path that writes plan docs or Plane
   tickets); face = plan name, concern count, revision gist.
2. Door routes to the plan DAG view (exists in TaskDetail) via the router; design-revised events
   emit back (concern 17 covers the return edge; this concern wires the plan surface's own save
   action as the first return-emit source alongside 12's steer).

## Cross-Repo Side Effects
None.

## Verify
- A /plan-produced or fleet-produced plan revision projects a card; click → DAG view of that
  plan; editing the plan there emits a design-revised card back into the channel (with 17).

## Resolution
Landed in train wave3: plan-card kind+reader, TaskDetail DAG door.
