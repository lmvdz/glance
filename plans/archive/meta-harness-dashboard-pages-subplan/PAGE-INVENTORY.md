# Meta-Harness Dashboard Page Inventory

STATUS: open
PRIORITY: p0
REPOS: omp-squad
SOURCE: `plans/meta-harness/images/` (26 references) + live `webapp/src` surfaces

## Core product frame

The target is not isolated pages. It is a **three-pane operator workbench**:

1. **Left rail / project tree** — projects/repos/goals first; each project expands to show active agents, profiles, tasks, conflicts, and recent runs.
2. **Middle work surface** — dedicated integrated console as the default command center; page content swaps here without losing the left context.
3. **Right detail rail** — collapsible detail panel for the selected thing: agent, task, feature, profile, run, diff, live preview, audit chain, conflict resolution, settings section.

This is the “Cursor + Piyaz” interpretation: dense, precise, low chrome, workbench-like, and action-first.

## Image-derived page map

| Page / surface | Inspired by images | Primary purpose | Current webapp status | Target treatment |
|---|---|---|---|---|
| Workbench shell | Conversational config, fleet board, agent detail, trace view | Persistent left project tree + middle console/content + right detail rail | Partial: sidebar/topbar + per-page panels | Replace route-isolated feel with shared shell state |
| Integrated console / Control Tower | Conversational Config, Spawn New Agent | Talk to daemon, spawn, apply proposed changes, review live preview | Partial: `ConsoleView`, `NewWork` | Make console the middle-section default and keep right preview/detail attached |
| Project list + nested agents | Fleet Board left list, Plan Mode, Cross-repo orchestration | Project/repo tree with collapsible agents under each project | Partial: projects in `Sidebar`, agents separate | Merge project and agent navigation into one tree |
| Squad overview / Glance | Glance Live Fleet Board, Squad Overview | Dense grid/list of agents, runtime, profile, task counts, heat, status | Partial: `AgentsView` | Add profile/task association metrics and list/grid toggle |
| Agent detail / context fabric | Agent Frontier-07 | Conversation, trace, events, metrics, artifacts, safety, evaluations, context facts, touched files, learned patterns | Partial: `DetailPanel`, `AgentDetail`, `Transcript` | Move into reusable right rail and dedicated agent detail route |
| Agent profiles | Named Profiles | Versioned profiles, prompt, caps, memory, usage, versions | Missing | New profiles page + profile detail rail |
| Profile memory | Named Profile Memory | Append-only profile memory, distilled facts, raw reasoning harvest, provenance export | Missing | New memory page shared with profiles |
| Capabilities / permissions | Capabilities Platform Engineer | Capability grants, effective permissions, scopes, audit history | Missing | New governance page; data can start static until daemon contracts exist |
| Team / operators | Team & Operators | Operators, roles, federation access, effective permissions | Missing | New access page; align with multi-tenant/RBAC roadmap |
| Spawn / smart recommendations | Spawn New Agent | Intent textarea, profile select, recommendation cards, advanced options | Partial: `NewWork` | Upgrade spawn flow; keep as modal/console command surface |
| Plan mode / architect | Plan Mode Architect View | Break goal into steps, recommended roster, runtime mix, simulate/approve spawn | Partial: project/planner surfaces | New plan mode page; later wire to auto-feature/review gate |
| Best-of-N tournament | Tournament bracket, Squad Overview tournament cards | Candidate ranking, scorer breakdown, verification gates, winning land action | Partial: Features board mentions tournaments | Dedicated tournament page tied to feature/run data |
| Trace view / diagnostics | Trace View root cause | Workflow DAG, cost/duration/quality score, root cause and recommended action | Partial: `GraphPane` | Replace generic graph with trace tree + diagnostics rail |
| Heatmap / context heat | Context Heat Graph | Code heat across runs with hot areas and scout insights | Added: `HeatmapView` | Keep; integrate selected file into right detail rail |
| Observer findings | Self-Observation Findings | Findings, patterns, observers, auto-fix/opportunity workflow | Partial: `AuditView` only | New observer page distinct from immutable audit log |
| Fleet health overview | Fleet Health Overview | Metrics, geolocation activity map, friction areas, high-impact landings | Missing | New health page; map can be CSS/SVG, no map dependency initially |
| Resource governance | Resource Governance / host metrics | CPU/RSS/disk/admission backoff constraints and throttles | Missing | New resource page tied to daemon host metrics when available |
| Audit + provenance explorer | Audit Log & Provenance Explorer, Landing Gate provenance | Immutable logs, filters, chain detail, export | Partial: `AuditView` | Expand into audit explorer with right chain rail |
| Landing gate / diff review | Landing Gate feature/auth-oidc | Diff, commits, checks, artifacts, provenance chain, landing score | Partial: `ProjectView`, task details | New landing review surface; right rail for gates/provenance |
| Conflict auto resolver | Autoresolve conflict screen | 3-way conflict, AI resolution, reasoning, verification, accept/retry/human review | Missing | New conflict resolver page; reuse existing resolve-conflict workflow contracts |
| Federation map | Federation | Operator map, delegation policy, remote steering, trust/latency | Partial: `NetworkView` | Upgrade to map topology with selected-agent detail rail |
| Configuration / settings | Settings, Triggers | Routing, governance, federation, audit, UI prefs, triggers/rate limits | Missing/partial | New settings hub; forms use real controls and save states |
| Onboarding | Welcome to omp-squad | First repo/worktree, profile, example agent | Missing | New first-run route or empty-state overlay |
| Self-extension factory | Self-Extension Factory | Commission new workers via architect/template/validate loop | Missing | Later-phase page; ties to Flue factory seam |

## Page grouping

### Primary nav
- Command Center
- Projects
- Fleet
- Profiles
- Tournaments
- Observability
- Governance
- Settings

### Secondary pages under groups
- Projects: Project detail, plan mode, landing gate, conflict resolver, heatmap.
- Fleet: Squad overview, agent detail, fleet health, federation map.
- Profiles: named profiles, memory, capabilities, profile versions.
- Tournaments: bracket, candidate compare, scorer breakdown.
- Observability: trace view, observer findings, audit/provenance explorer.
- Governance: resources, team/operators, access, policies, settings.

## First implementation slice

Do not build all pages at once. First slice should make the app feel structurally right:

1. shared three-pane workbench shell,
2. left project tree with nested agents,
3. middle integrated console/content area,
4. collapsible right detail rail,
5. route taxonomy for all page stubs,
6. migrate existing Agents/Projects/Console/Heatmap/Audit/Network into the shell.

After that, page surfaces can be added in batches without reworking the frame.
