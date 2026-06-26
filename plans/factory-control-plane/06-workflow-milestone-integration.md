# Workflow milestone integration
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/workflow/*, src/workflow-driver.ts, src/features.ts, src/server.ts, webapp/src/lib/dto.ts

## Goal

Let milestone-heavy workflows inherit the same autonomy, proof, and journal semantics without making every simple agent a workflow.

## Approach

- Add autonomy/proof/session fields to workflow branch/run specs.
- Emit journal events for workflow node start/end, human gates, parallel branch start/end, verification, and merge/land attempts.
- Ensure workflow auto-land uses the same `land()` proof invariant as normal agents.
- Surface workflow milestone proof state in feature/dashboard DTOs.
- Keep normal one-agent tasks as simple runs.

## Cross-Repo Side Effects

The web dashboard receives additional workflow/proof fields but no separate runtime.

## Verify

- Add a workflow-driver test where a workflow branch cannot auto-land without fresh proof.
- Add a journal event test for a small workflow with a human gate and verification node.
