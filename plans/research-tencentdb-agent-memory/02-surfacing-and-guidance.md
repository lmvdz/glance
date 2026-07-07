# Surfacing: agent-source badge + guidance
STATUS: closed
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/components/KnowledgePanel.tsx, webapp/src/components/TaskDetail.tsx, webapp/src/lib/dto.ts

## Goal
Make agent-captured decisions legible in the UI so operators can see the fleet building institutional memory. Both surfaces already render `decisionSource`; this adds a small `source:"agent"` badge (distinct from human/plan) and, where the provenance flows through, an agent/run backlink label.

## Approach
- `webapp/src/lib/dto.ts:81` (`FeatureDecisionDTO`): ensure `source`/`decisionSource` (and optional `sourceRef`) are carried on the DTO if not already; add `sourceRef?` only if concern 01 threaded it through the fabric/feature DTO.
- `webapp/src/components/KnowledgePanel.tsx` (~:197-200, the "Decisions on record" list): render a small badge keyed off `decisionSource` — e.g. `agent` → an "agent" pill (reuse existing badge styling in the panel), `human`/`plan` unchanged. If `sourceRef.agentId` is present, show it as a muted "· a1b2" suffix.
- `webapp/src/components/TaskDetail.tsx` (decisions log, ~:1648-1660): same badge in the per-feature decisions list, alongside the existing human-added entries (`addDecision` at :954).
- Keep it additive and style-consistent with existing pills; no layout restructure.

## Cross-Repo Side Effects
None.

## Verify
- With a captured `source:"agent"` decision present (from concern 01), the KnowledgePanel "Decisions on record" row shows the agent badge; a human-added decision shows no agent badge; a plan decision shows its existing treatment.
- `cd webapp && bunx tsc --noEmit` clean; the panel renders without console errors when driven against a feature that has mixed-source decisions.

## Resolution
CLOSED (c997a1d). Emerald 'agent' badge on agent-captured decisions in KnowledgePanel + TaskDetail. Webapp 574 pass, tsc clean. (Tool-description usage nudge shipped in concern 01's def.)
