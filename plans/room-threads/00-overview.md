# Room threads — another axis of depth

Visual review: https://claude.ai/code/artifact/0cc5bc55-b43e-410b-b751-e5ce7824c8a9
Design brief: [DESIGN.md](DESIGN.md)

## Outcome

The room stops rendering entity-keyed data with a conversational renderer. Work becomes nodes with
state; a node is both the unit of work and the unit of conversation; the UI is two coupled panes where
drilling into state also enters that node's channel. Lifecycle telemetry lands where it belongs
instead of burying human messages, and a conversation is found by navigating to the thing rather than
by remembering when it happened.

## Work

| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| [01 node object](01-node-object.md) | One type + parent link + lazy channel. Everything else is a view over it. | architectural | src/nodes.ts, channels, stores, migrations |
| [02 projection to nodes](02-projection-to-nodes.md) | `projectedChannelId` → `projectedNodeId`; escalation-only upward flow | architectural | squad-manager, server |
| [03 two-pane shell](03-two-pane-shell.md) | State + conversation, coupled by depth, recursive at every level | architectural | webapp hub |
| [04 decay ranking](04-decay-ranking.md) | Prominence fades unless reinforced; ordering only, stable layout | mechanical | webapp lib/hub, nodes |
| [05 goal overlap](05-goal-overlap.md) | Lift `ownershipConflict` from paths to goals; disclose existence, not content | architectural | ownership, nodes |
| [06 node summaries](06-node-summaries.md) | Summaries are the interface between nodes; regenerate, never append | architectural | nodes, after-action |
| [07 navigation model](07-navigation-model.md) | Select ≠ enter; DAG not tree | research | webapp hub, router, nodes |
| [08 composer quality](08-composer-quality.md) | Image previews and the rest of the obvious chat affordances | mechanical | webapp composer, timeline |

## Order

| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01 | The object model. Nothing else can start. |
| 2 | 02, 06, 07 | All depend only on 01 and touch different files. 07 is design work that should run while 02/06 build. |
| 3 | 03, 04 | The shell needs 01+02; ranking needs the node scores 04 defines against a real tree. |
| 4 | 05 | Wants real nodes with real goals to test against. |
| parallel | 08 | Independent of all of it. Can land any time. |

## Dependency graph

| Concern | Blocked by | 30s check |
|---|---|---|
| 02 | 01 | `src/nodes.ts` exists and exports a Node with `parentId` |
| 03 | 01, 02 | a card resolves to a node id, not a channel id |
| 04 | 01 | nodes carry a state and a last-activity timestamp |
| 05 | 01 | nodes carry a goal string |
| 06 | 01 | nodes persist and can be re-read after restart |
| 07 | 01 | a node can be given two parents without the store rejecting it |
| 08 | — | none |

## Not yet specified

- (none)

## Out of scope

- **The bubble field** — survives as a secondary ambient view (fleet weather, second monitor), never
  the working surface. A physics layout destroys the spatial memory that makes a board beat a feed,
  and area is close to the worst available encoder for magnitude.
- **GraphRAG** — we declare the graph; its value is inferring one from unstructured text. See 05.
- **Reactions, rich text, link unfurling** — real, but not what the room is missing. See 08.
- **The app-wide restyle** — running in parallel on its own branch, using the migrated
  `ChannelRail.tsx` as reference. Not sequenced against this plan.

## Decisions so far

- [DESIGN.md](DESIGN.md) — a node is the unit of work AND of conversation; up carries events, down
  carries context; state picks the region and velocity only orders within it.

## Notes

- **Supersedes part of `plans/the-room`'s DESIGN.md.** A-M1 assumes a linear stream is the primary
  surface. The card grammar and doors (concerns 12–16) survive untouched — they are exactly what a
  node timeline renders.
- Waves 4 and 5 are what make this safe: membership enforcement (18), atomic seq allocation (25), and
  lifecycle worthiness rules (27) all have to hold underneath it.
- Phase 0 WIP snapshot: 76 open concerns across 23 plans in the primary checkout. The scanner reports
  ~4,939 across 1,427 — it walks `.claude/worktrees/` and job dirs, counting every plan once per
  worktree. That inflation is worth fixing separately; a gate reporting 65× reality is a gate people
  learn to ignore.
- `plans/the-room` concern 23 (love gate) is still pending Lars's cold-boot verdict. This plan should
  not start batch 3 before that verdict — the shell it rebuilds is the thing being judged.
