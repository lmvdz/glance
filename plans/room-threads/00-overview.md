# Room threads — another axis of depth

Visual review: https://claude.ai/code/artifact/0cc5bc55-b43e-410b-b751-e5ce7824c8a9
Design brief: [DESIGN.md](DESIGN.md)
**Reference: [`reference/`](reference/)** — seven rounds, ~72 designed states, runnable, with
screenshots. `reference/README.md` indexes them. Build against these, not against prose.
**Reconciliation: [RECONCILE.md](RECONCILE.md)** — what the design decided that the plan did not know.

## Outcome

The room stops rendering entity-keyed data with a conversational renderer. Work becomes nodes with
state; a node is both the unit of work and the unit of conversation; the UI is two coupled panes where
drilling into state also enters that node's channel. Lifecycle telemetry lands where it belongs
instead of burying human messages, and a conversation is found by navigating to the thing rather than
by remembering when it happened.

## Work

| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| [01 node object](01-node-object.md) | One type + parent link + lazy channel. Everything else is a view over it. **Schema is too narrow as merged — extend via associated records.** | architectural | src/nodes.ts, channels, stores, migrations |
| [02 projection to nodes](02-projection-to-nodes.md) | Event classes with unforgeable proof-card contracts, not a binary upward rule | architectural | squad-manager, server |
| [03 room shell](03-two-pane-shell.md) | Room home frame, standing rail, depth entered from the card | architectural | webapp hub |
| [04 decay ranking](04-decay-ranking.md) | Ordering only. Stall detection moved to 13. | mechanical | webapp lib/hub, nodes |
| [05 goal overlap](05-goal-overlap.md) | Lift `ownershipConflict` from paths to goals; disclose existence, not content | architectural | ownership, nodes |
| [06 node summaries](06-node-summaries.md) | Live summaries, regenerated. Archive semantics moved to 17. | architectural | nodes, after-action |
| [07 navigation model](07-navigation-model.md) | Select ≠ enter; multi-homing. The centre-pane fork is closed. | research | webapp hub, router, nodes |
| [08 composer quality](08-composer-quality.md) | Image previews and the rest of the obvious chat affordances | mechanical | webapp composer, timeline |
| [09 rail earns its place](09-rail-earns-its-place.md) | Doors answer a repeated question or leave the rail; empty states teach | mechanical | webapp rail, capability panel |
| [10 the voice](10-voice.md) | Every string explains rather than labels — and the facts must be emitted to be spoken | architectural | emit sites, webapp hub |
| [11 autonomy rules](11-autonomy-rules.md) | The human's sentence, quoted where it acts. Proposed from evidence, never configured. | architectural | rules, nodes, stores |
| [12 delegation boundary](12-delegation-boundary.md) | Credentials, spend, deletion, publishing — no rule may ever widen it | architectural | authz, server |
| [13 plan motion](13-plan-motion.md) | Stillness measured against a plan's own normal; parked carries no number | architectural | nodes, squad-manager, hub |
| [14 instruction readback](14-instruction-readback.md) | A recorded reading before action; one falsifiable objection, outcome retained | architectural | instructions, nodes |
| [15 external notification](15-external-notification.md) | Three conditions at once, a mandatory delay, and a worth-it review | architectural | notify, rules |
| [16 cold start](16-cold-start.md) | Six borrowed defaults, one undefaultable question, a ledger of unknowns | architectural | rules, unknowns, hub |
| [17 retention and handover](17-retention-and-handover.md) | Decisions survive whole; the cut is declared; stale evidence is marked at transfer | architectural | archive, after-action, migrations |
| [18 agent records](18-agent-records.md) | Sample size and date on every claim; openable to source; no leaderboard | architectural | agents, nodes, hub |
| [19 human authority](19-human-authority.md) | One named accountable human; authorship survives; disagreement stays visible | architectural | rules, authz |
| [20 plan proposals](20-plan-proposals.md) | Change the shape before it starts; an ambiguous goal spawns nothing | architectural | nodes, squad-manager, hub |
| [21 decision impact](21-decision-impact.md) | Dependency-aware reversal cost, nearest repair, spend versus waste | architectural | cost, nodes, hub |


## Order

| Batch | Concerns | Why together |
|---|---|---|
| 1 | **01 (extended)** | The object model AND its associated evidence records. Nothing else can start, and the merged shape cannot represent the design's contracts. |
| 2 | 11, 12, 14, 17, 20 | The durable evidence model. All depend only on 01. Landing these before 02 spreads node-addressed cards is the whole point of the sequencing — they cannot be retrofitted. |
| 3 | 02, 06, 07, 13 | Projection with proof-card contracts, live summaries, navigation research, stall detection. |
| 4 | 03, 04, 10 | The shell, ordering, and the voice — each needs the facts batches 2 and 3 emit. |
| 5 | 05, 15, 16, 18, 19, 21 | Wants real nodes with real goals and real history to test against. |
| parallel | 08, 09 | Independent of the object model. Can land any time. |

The rule that governs all of it: **10 ships with each proof emitter, never as a final copy pass.** Meaning
is thrown away at the emit site, and no lint recovers it afterwards.

## Dependency graph

| Concern | Blocked by | 30s check |
|---|---|---|
| 02 | 01 | an event class declares its projection policy and a unit cannot forge a room card |
| 03 | 01, 02, 20 | the room narrative survives selecting a plan in the rail |
| 04 | 01, 13 | nodes carry state and last activity; stall data comes from 13, not from here |
| 05 | 01 | nodes carry a goal string |
| 06 | 01 | nodes persist and can be re-read after restart |
| 07 | 01 | a node can be given two parents without the store rejecting it |
| 08 | — | none |
| 09 | — | none |
| 10 | 11, 16, 17, 20, 21 | every string it governs has a typed payload carrying the fact it states |
| 11 | 01 | a rule persists the human's sentence, author, date, and invocation history |
| 12 | 01 | the class is enforced server-side and a forged request is refused |
| 13 | 01 | a plan's own motion history is queryable |
| 14 | 01 | a reading persists per instruction clause with a reversibility class |
| 15 | 11, 12 | all three conditions are individually recorded |
| 16 | 11 | a default renders as borrowed and reverses in one action |
| 17 | 01 | a decision survives a compaction pass byte-identical |
| 18 | 17 | a claim carries sample size and date and opens to its units |
| 19 | 11 | a rule keeps its author through every render path |
| 20 | 01 | a proposed node is not counted as in-flight work |
| 21 | 17 | reversal cost includes downstream dependents |

## Not yet specified

Four things the design deliberately did not settle, each to be decided against real data rather than
in the abstract (full statements in [RECONCILE.md](RECONCILE.md) §STILL GENUINELY OPEN):

- **Rule evaluation semantics** — parsing, conflict precedence across scopes, retention of rule text.
  Settle with a prototype over real historical instructions plus an explicit authority matrix.
- **Statistical thresholds** — "more likely than not", sufficient sample, plan-normal calculation.
  Settle from retained unit histories and a false-positive review, never as a global configured number.
- **External action adapters** — per-provider enforcement and authority handoff for each integration.
  Settle before connecting any real side effect.
- **Multi-parent work graph** — primary-home references versus true multi-homing. Decide with real
  `BLOCKED_BY` and landing examples (concern 07).

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
- **`plans/the-room` concern 23 (love gate) was re-targeted at THIS plan on 2026-07-25.** It no longer
  gates the current room — judging the surface we spent seven design rounds replacing measures the wrong
  thing. It is now this plan's finish line, run against a fleet at real volume, and it blocks nothing here.
- The premise this whole plan rests on — that a linear feed buries human messages at 80–160 events/hour —
  has never been tested at that volume. Concern 23's run is where it is confirmed or falsified.
- Everything from RECONCILE.md is now absorbed: concerns 11–21 are new, and 02, 03, 04, 06, 07, 10 each
  carry a dated amendment block. RECONCILE.md remains as the reasoning behind the changes.
