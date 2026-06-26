# Real observability + heat data surfaces
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/types.ts, src/receipts.ts, src/squad-manager.ts, src/server.ts, src/audit.ts, src/observer.ts, webapp/src/lib/dto.ts, webapp/src/lib/heat-data.ts, webapp/src/components/views/HeatmapView.tsx, webapp/src/components/views/DashboardPagesView.tsx, webapp/src/components/views/AgentsView.tsx, webapp/src/components/views/GraphPane.tsx, webapp/src/lib/graph-model.ts, webapp/src/hooks/useSquad.ts, tests/*, webapp/src/**/*.test.ts

## Goal

Delete fake/static observability and replace it with real daemon data: health, receipts-backed usage/heat, audit/observer records, receipt rollups, and trace/dependency views that say what is real.

## Approach

- DTO parity first:
  - Add backend `ReceiptRollup` to `webapp/src/lib/dto.ts`; the Vite UI currently drops `AgentDTO.receipt` even though backend/TUI already use it.
  - Remove fake context labels/fallbacks. If `contextPct` is missing, render “unknown,” not inferred.
- Fleet usage:
  - Add a read helper/API over existing receipt JSONL, e.g. `/api/usage?repo=&agentId=&limit=`, returning recent runs and aggregates: tokens, cost, duration, tool calls/tally, files touched.
  - Use file receipts as source for now because full receipts exist in both file and DB modes.
- Fleet Health:
  - Consume existing `/api/health` (`rssMb`, `load1`, `freeRatio`, `agents`, `hosts`, `projects`, `uptimeSec`, `warnings`, `ok`) from the web observability page.
  - Remove copy saying host metrics need an API.
  - Optionally extend with non-secret WIP/resource/rate-limit/autodrive/observe/scout flags.
- Heatmap:
  - Stop importing hardcoded production `DAYS/TREE/HOT_AREAS/INSIGHTS` from `webapp/src/lib/heat-data.ts`.
  - Add minimal `/api/heat?repo=&days=8` over existing receipts: aggregate `RunReceipt.filesTouched` by day/repo/agent with recency weighting.
  - Label this “write heat” until tool-read/tool-arg capture exists.
  - Return empty state if there are no receipts; never show sample Go paths/May dates as live data.
  - Keep `magma()` or color helpers if useful; data must come from API/fixture only.
- Agent/Fleet board:
  - Replace `AgentsView.heatFor()` hash-derived mini heat with real receipt recency or remove it until real data exists.
  - Surface receipt rollup: tool calls, cost, tokens, duration, last run status.
- Audit/Observer:
  - `useSquad` should ingest `audit` WS events in addition to `/api/audit` backfill.
  - Link audit rows to agent/feature/task targets where ids match.
  - Observer/scout tagged Plane findings can feed action items, but must degrade when Plane is unconfigured.
- Trace graph:
  - Keep feature dependency graph, but label it honestly as feature dependency unless `fleet-observability` trace endpoint is present.
  - When trace endpoint lands, add run/stage/tool layers consuming it; do not implement spans/export in this plan.

## Cross-Repo Side Effects

None.

## Verify

- With no receipts, Heatmap shows an honest empty state.
- With synthetic receipts containing `filesTouched`, `/api/usage` and `/api/heat` show current dates and TS repo paths, not May/Go fixtures.
- `/api/health` warning state appears in `#/observability` and updates on refetch/reconnect.
- Audit event emitted over WS appears immediately and remains after `/api/audit` backfill.
- Agents board no longer calls `hashString(agent.id + status + activity)` for telemetry.
- Search production webapp for `MAY 11`, `cmd/root.go`, `internal/engine/context.go`, and `hashString(agent.id` returns no live-data matches.
