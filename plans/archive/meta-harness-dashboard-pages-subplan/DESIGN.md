# Design: Meta-Harness Dashboard Pages

STATUS: cancelled
PRIORITY: p0
REPOS: omp-squad

## Approach

Build a reusable **Operator Workbench shell** first, then fill pages. The shell is the product: a project/agent tree on the left, an integrated command/content surface in the middle, and a collapsible detail rail on the right. Existing views (`AgentsView`, `ProjectView`, `ConsoleView`, `HeatmapView`, `AuditView`, `NetworkView`, `GraphPane`) should be migrated into this shell instead of continuing as independent full-page islands.

## Key decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Navigation model | Project-first tree with nested agents | Current flat nav only; route-only page list | User explicitly wants project list left with collapsible agent list inside it. This also matches Cursor/Piyaz workspace mental model. |
| Console placement | Console is persistent/default middle section | Separate console route only | The operator should always be able to talk to the harness without losing project context. |
| Detail model | One shared right rail | Per-page sidebars | Avoids duplicated detail patterns and lets any clicked entity show diff/preview/provenance/details in the same place. |
| Page rollout | Create taxonomy + stubs after shell, then implement pages by domain | Build every page at once | Keeps the first slice useful and avoids 20 disconnected mock pages. |
| Data strategy | Use existing daemon event/API contracts first; static placeholders only for page scaffolds and clearly marked | Invent new mock APIs | Current app already has live `SquadState`, audit, comments, federation, tasks; new API contracts should be planned per page. |
| Visual system | Dense dark workstation, low chrome, tokenized components | Re-theme again | The problem is layout precision and density, not color. |

## Existing seams to reuse

- `useSquad()` and `SquadEvent` for fleet, agents, transcripts, approvals, commands.
- `apiGet` / `apiPost` for daemon routes.
- `applyCommand` / audit chokepoint for all mutations.
- Existing views and primitives in `webapp/src/components`.
- `plans/meta-harness/images/` as visual references.
- `plans/meta-harness/analyze-codebase-heat-graph/` + `webapp/src/components/views/HeatmapView.tsx` for the heatmap.
- NORTH-STAR seams: named profiles, context fabric, observer/scout, resolve-conflict, resource governance, federation, audit/provenance.

## Risks

| Risk | Mitigation |
|---|---|
| Building pretty stubs that feel fake | First slice must wire existing live surfaces; page stubs must say what data contract is missing. |
| Shared shell breaks current routes | Keep hash routes, route state, and existing page components behind compatibility wrappers until migrated. |
| Left tree becomes too dense | Collapsible groups, project search, status badges, and active-only filters. |
| Right rail becomes a dumping ground | Type detail payloads: `agent`, `project`, `feature`, `task`, `run`, `diff`, `profile`, `audit`, `settings`, `empty`. |
| Too many pages in one PR | Batch concerns by shared files and domain; shell first, pages after. |

## Target shell contract

```ts
type WorkbenchView =
  | "command"
  | "projects"
  | "fleet"
  | "profiles"
  | "tournaments"
  | "observability"
  | "governance"
  | "settings";

type DetailSubject =
  | { kind: "agent"; id: string }
  | { kind: "project"; repo: string }
  | { kind: "feature"; id: string }
  | { kind: "task"; id: string; repo?: string }
  | { kind: "diff"; agentId?: string; featureId?: string }
  | { kind: "profile"; id: string }
  | { kind: "audit"; id: string }
  | { kind: "run"; id: string }
  | { kind: "settings"; section: string }
  | null;
```

This is a planning contract, not required exact code. Use the smallest shape that supports current implementation.

## Page rollout batches

1. **Shell foundation** — three-pane layout, route state, project tree, detail rail.
2. **Live existing surfaces migration** — console, agents, project, heatmap, audit, federation.
3. **Orchestration pages** — plan mode, tournaments, landing gate, conflict resolver, trace diagnostics.
4. **Governance/profile pages** — profiles, memory, capabilities, team/operators, settings/config/triggers.
5. **Observability/self-improvement pages** — observer findings, fleet health map, resource governance, self-extension factory.
6. **Polish + accessibility** — keyboard tree nav, rail collapse, responsive behavior, empty/loading/error states.

## Non-goals for this subplan

- No new backend framework.
- No new chart/map dependency unless native SVG/CSS is insufficient after first implementation.
- No fake data in finished views. Stubs are allowed only as page placeholders with explicit missing-contract copy.
- No replacing the daemon event spine.
