# omp-graph data model + WS data layer
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: research
TOUCHES: webapp/src/lib/graph-model.ts, webapp/src/lib/ws.ts, webapp/src/hooks/useSquad.ts

## Goal
Turn the live omp-squad fleet into the engine's input: a pure selector mapping `FeatureDTO[]` +
`AgentDTO[]` → `{ nodes: GraphNodeInput[], edges: GraphEdgeInput[], agentsByFeature: Map<string, AgentDTO[]> }`,
fed by a WebSocket client that mirrors how `src/web/index.html` already consumes the SquadServer.

## Approach
1. **WS client (`lib/ws.ts`).** Connect to the SquadServer WS (same origin the SPA is served from).
   Send `{ type: "snapshot" }` (`ClientCommand`, `src/types.ts:478`) on open; consume `SquadEvent`
   (`:440`): `roster` → replace agent list; `agent` → upsert one; `removed` → drop; `features-changed`
   → refetch `/api/features` (HTTP). Expose `send(cmd: ClientCommand)` for later interaction concerns.
   Mirror the existing `src/web/index.html` socket/route usage — do not invent new endpoints.
2. **`useSquad()` hook.** React state holding `{ agents: AgentDTO[], features: FeatureDTO[], connected }`,
   wired to `lib/ws.ts`. Re-export the WS `send`. (Replaces piyaz's TanStack Query + SSE entirely.)
3. **`graph-model.ts` — pure selector** (the testable seam):
   - **Nodes:** one per `FeatureDTO` → `{ id: f.id, title: f.title, ref: f.issueIdentifiers?.[0] ?? shortId(f.id), status: f.stage, tags: [f.repo, …(f.planDir?[basename]:[])] }`.
   - **Edges (`depends_on`):** build an issue-identifier → featureId index from `f.issueIdentifiers`;
     for each agent/issue with `IssueRef.blockedBy` (`src/types.ts:67`), emit `depends_on` from the
     blocked feature to the blocker feature when both resolve. `ponytail:` blockedBy is only present
     on issues attached to live agents (`AgentDTO.issue`); ceiling = misses dormant deps. Upgrade
     path = fetch the Plane issue graph for the active project and index all blockedBy relations.
   - **Edges (`relates_to`):** features sharing the same `planDir` (or repo when no planDir) → a
     light `relates_to` clique cap (e.g. connect each to the dir's first member, star not mesh, to
     avoid O(n²) edges). `ponytail:` star topology; upgrade to richer relations if needed.
   - **Agent overlay:** bucket `agents` by `featureId` (`src/types.ts:207`); agents with no
     `featureId` fall under a synthetic "unassigned" bucket (rendered as floating nodes by concern 06,
     or omitted — decide in 06).
4. **Stable ids.** Node id === `FeatureDTO.id` (stable: `plan:<repo>:<dir>` / `agent:<id>`) so the
   engine's position cache (concern 03) survives WS-driven remounts.

## Cross-Repo Side Effects
Read-only consumer of the existing SquadServer WS + `/api/features`. No `src/server.ts` change
(routes already serve the live dashboard). If a needed field isn't on the wire, prefer deriving it
client-side over a server change; flag any genuine gap rather than adding an endpoint here.

## Verify
- Unit (concern 07 formalizes): `buildGraphModel(features, agents)` on a 3-feature / 2-agent fixture
  yields 3 nodes, the expected `depends_on` edge from a `blockedBy`, and correct `agentsByFeature`
  bucketing; empty inputs return empty arrays (no throw).
- Manual: with `useSquad()` logging, `omp-squad up` + 1 agent shows `connected:true`, one feature,
  and the agent bucketed under its `featureId`.

## Resolution
Added lib/dto.ts (DTO mirror), lib/ws.ts (/ws client, ompsq-token subprotocol, backoff), lib/graph-model.ts (FeatureDTO->nodes, blockedBy->depends_on, planDir->relates_to, agent buckets), hooks/useSquad.ts. Branch `omp-graph-ui`; gate green (root `bun run check` + `bun test` 492/0, webapp `bun run test` 8/0 + `bun run build`).
