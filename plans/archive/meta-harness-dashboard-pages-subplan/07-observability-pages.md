# Observability and Diagnostics Pages
STATUS: cancelled
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/views/HeatmapView.tsx, webapp/src/components/views/AuditView.tsx, webapp/src/components/views/TraceView.tsx, webapp/src/components/views/ObserverView.tsx, webapp/src/components/views/FleetHealthView.tsx, webapp/src/components/views/ResourceGovernanceView.tsx

## Goal
Implement heatmap, trace diagnostics, observer findings, fleet health overview, geolocation/activity map, resource governance, and provenance explorer.

## Approach
- Keep `HeatmapView` and wire selected file/hot area into right detail rail.
- Trace View: DAG of spawn/workflow/verify/land/resolve nodes with cost/duration/quality and root cause rail.
- Observer Findings: findings table, pattern clustering, auto-fix/open-ticket actions, opportunity rail.
- Fleet Health: KPI cards, CSS/SVG geolocation heat map, friction areas, high-impact landings.
- Resource Governance: CPU/RSS/disk/admission backoff charts and constraints.
- Audit Explorer: immutable logs with filters and provenance chain detail rail.

## Cross-Repo Side Effects
May need daemon read routes for trace/fleet-health/resource metrics; first version should reuse audit/events where possible.

## Verify
- Heatmap route remains working.
- Audit route still exports real JSON.
- No map dependency added unless native SVG proves insufficient.
