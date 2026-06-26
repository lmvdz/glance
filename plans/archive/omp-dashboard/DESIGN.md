# Design: omp-dashboard

## Approach
Evolve the `omp-graph-ui` webapp into a HumanLayer-shaped operator console: a persistent left
**sidebar** (Inbox · Agents · Features · Graph · Audit), a **list/detail** center, and a **context**
panel — piyaz-skinned, built from reskinned ompsq-55 primitives, driven by the existing `useSquad`
WS hook extended with transcript + commands. Reach operational parity with `src/web/index.html`
(every `ClientCommand` + `/api` action), then it can replace it behind the existing
`OMP_SQUAD_WEBAPP=1` seam.

## Information architecture (from HumanLayer CodeLayer)
```
┌ sidebar ┬─────────── center ───────────┬─ context ─┐
│ Inbox N │ list (agents / features /     │ transcript│
│ Agents  │   inbox / audit)  ── or ──    │ artifacts │
│ Features│ detail = header + actions +   │ deps /    │
│ Graph   │   live transcript + approvals │ plane     │
│ Audit   │                               │           │
└─────────┴───────────────────────────────┴───────────┘
            Cmd-K command palette over everything
```

## Key decisions
| Decision | Choice | Why |
|---|---|---|
| IA | HumanLayer 3-pane + inbox + palette | validated (omp-squad already CodeLayer-shaped); list/inbox-first beats graph-first for *operating* |
| Skin | piyaz tokens (`omp-graph-ui`) | user pick; dark/mono already matches HumanLayer's own aesthetic |
| Primitives | reskin ompsq-55 (`components/ui/*`) | exist + showcased; don't rebuild |
| Transport | extend `useSquad`: WS `subscribe`+`transcript`+`commands`; `ClientCommand` send or `POST /api/command`; `/api` fetches | daemon already exposes all of it; zero new endpoints |
| Approvals | first-class **Inbox** folding `agent.pending[]`; `AnswerControls` keyed by `PendingRequest.kind` | HumanLayer's core; `index.html`'s queue already has the data |
| Graph | one view in the shell | keep the lens, drop graph-as-app |
| Parity gate | matrix vs `index.html` in `00-overview.md` | "done" = operator can do everything `index.html` does |
| Cutover | stays behind `OMP_SQUAD_WEBAPP=1` until parity | reversible; `index.html` untouched |

## Tiers (scope control)
- **P1 Operate:** inbox + transcript + agent actions + spawn (the daily loop).
- **P2 Navigate:** command palette + board + audit + graph view.
- **P3 Defer (note, don't build):** federation / presence / leases / deep Plane / push — wire only if asked.

## Risks
| Risk | Sev | Mitigation |
|---|---|---|
| Transcript volume/perf | sig | append-only reducer keyed by agent id; virtualize or cap the window; `messageCount` for cheap change detection |
| Approval kind coverage (confirm/input/select/editor + host tools) | sig | `AnswerControls` switches on `PendingRequest.kind`; default to text; mirror `index.html`'s `preq()` |
| Parity scope creep | sig | the P1/P2/P3 tiers above; P3 explicitly deferred |
| Two design systems (piyaz vs ompsq-55 green) | minor | one token set = piyaz; reskin primitives' vars on import |
| Reconnect drops the transcript subscription | minor | re-send `subscribe` for the open agent on WS reopen |

## Red-team notes
- Don't rebuild primitives or transport — both exist; the work is **IA + wiring + parity**.
- `POST /api/command` exists as a non-WS path for `ClientCommand`s — use it for fire-and-forget actions if WS `send` proves racy.
- HumanLayer "artifacts" ≈ omp's plan-dir docs + the diff (Changes) + receipts; **map, don't invent**.

## Open questions
- Agent-initiated escalation (F7) + the stakes ladder are **daemon-side** gaps, separate from this UI
  plan — note, don't block. The UI should render an urgency field if/when `PendingRequest` grows one.
