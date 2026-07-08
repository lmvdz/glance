# GRAPH-FOLD.md — the great consolidation

Authored by the opus design pass 2026-07-08 (user decisions: 8 pages die — Automation, Fleet
health, Heat map, Activity rhythm, Model scoreboard, Topology, Federation, Knowledge base — fold
into Graph; nav shrinks to Needs you · Active work · Cockpit · Tasks · Capabilities · Graph).

**Thesis (decisions-first):** the fold is *not* "eight pages become eight lanes." Only **three**
signals are genuinely time-shaped and belong inside the Graph; **five** are structural/lookup/scalar
and belong in the **header**, **Needs you**, a real **⌘K palette**, or the **bin**. The Graph's
default draw does **not change** — every folded-in signal is opt-in (an inspector tab, a rare event
glyph, a relabel). The user's calm graph stays their calm graph.

## 1. Per dying page

Grammar targets: **lane** (new default track), **marker** (glyph on an existing lane, renders only
when present), **inspector tab** (new/extended `InspectSel`), **header** (FactoryStatusStrip),
**palette** (⌘K), **attention** (Needs you), **drop**.

| Page (endpoint · density) | Load-bearing signal → human decision | Verdict & representation |
|---|---|---|
| **Automation** (`/api/automation`, `/api/usage`) | Is the autonomous fleet *alive and acting*, or silently dead? | **Already folded** — pulse-model reads `automation.loops` → metronome ticks + LOOP notes; Inspector has `loop`. **Enrich** the `loop` tab with per-loop last-run/cadence/Scout-budget. Add one **header** autonomy dot. No new lane. |
| **Fleet health** (`/api/governance`) | Can I throw more work at the fleet, or is it about to choke? (spawn gate) | **Header, not graph** — a *now-scalar*. Capacity/spawn-gate chip → FactoryStatusStrip ("6/8 · spawns flowing" / amber "at cap" / red "throttled — <reason>"). landBlocked banner already there. Mem/load trends → strip hover disclosure. |
| **Heat map** (`/api/heat`, `/api/usage`) | (a) 2+ live agents on one file → intervene pre-conflict. (b) flapping agents. (c) churn tree. | **Split.** (a)+(b) → **Needs you** callouts + a rare **collision marker** on AGENT RUNS. (c) magma tree → **DROP** (data-dump; churn-over-time already the pulse ridge). |
| **Activity rhythm** (`/api/activity/heatmap`) | When is the fleet active? | **DROP standalone — redundant.** DEPTH massif already *is* rhythm (8w × 168h). Relabel the DEPTH toggle. |
| **Model scoreboard** (`/api/graph/scoreboard`) | Which model/harness is worth routing to? | **Inspector tab** — extend the existing `cost` inspector with land-rate / land-rate-per-tier / $-per-landed. Same (graph) endpoint. |
| **Topology** (roster, no endpoint) | What spawned what, right now? | **Not a lane — now-structure.** Fold lineage forest into the **`run` inspector** (click a run → its subtree) and keep it in **Cockpit**. Zero backend. |
| **Federation** (`/api/federation`, `/api/leases`) | User: "just a list of files in flight, useless." Single-operator's only real signal = **lease collision** (= Heat's file collision). | **DROP page; dormant capability.** Lease-collision **unifies with Heat collision** → one attention badge + graph marker. Peer presence + remote steer appear *only when peers exist* → park in **Org settings**. |
| **Knowledge base** (`/api/fabric`, `/api/fabric/search`) | Find the doc/decision/prior-art I need. | **⌘K palette, not graph** — lookups have no time axis. Upgrade ⌘K from focus-task-search to a REAL command palette: Fabric search + nav jump. |

**Convergence win:** Heat file-collision and Federation lease-collision are the *same fact*
(≥2 live agents on one path). Model once: a `collision` signal feeding one Needs-you row + one
Graph marker.

## 2. Resulting Graph anatomy

**Default draw — unchanged (calm preserved).** Lanes stay exactly: MILESTONES · FLEET PULSE
(+attribution bands +plan chip) · SPINE (state band) · AGENT RUNS (+metronome) · SHIPPED·LOOPS·NEEDS.
**No new always-on track.**

**New markers (render only when present):** a **COLLISION** glyph (⚠, `#E5484D`) on AGENT RUNS at
the contested run(s); nothing when the fleet is clean.

**Toggles:** unchanged — FLAT/DEPTH + 7/14/30d + refresh. DEPTH gets a one-word relabel
("RHYTHM"/"DEPTH"). No new persistent toggle.

**Inspector (`InspectSel`) after fold:** existing kinds plus: `cost` +scoreboard section · `run`
+lineage subtree · `loop` +cadence/budget · `needs` +collision/flapping · new `collision` kind.
Click-to-open — invisible until asked.

**Header (FactoryStatusStrip):** capacity/spawn-gate chip + existing landBlocked + autonomy dot.

**⌘K palette:** nav jump (6 views) + Fabric search.

## 3. Migration notes

**Nav/route removal** (WorkbenchPane `NAV_SECTIONS` + collapsed rail; App.tsx `MainContent`;
`AppView` in TaskContext.tsx): delete `automation, fleet-health, heat, activity-heatmap, scoreboard,
topology, federation, knowledge`. Final nav: `attention · active · cockpit · tasks · capabilities ·
omp-graph`. Drop the Observe/Network sections; Graph joins the top group.

**Endpoints that STAY:** `/api/graph*` (incl. scoreboard — now the cost tab), `/api/automation`
(loop tab + CLI twin), `/api/usage` & `/api/governance` (AttentionPanel + header), `/api/fabric/search`
(palette), `/api/leases` (collision + daemon-internal).

**Endpoints newly orphaned → flag, don't rush-delete:** `/api/heat`, `/api/activity/heatmap`,
`/api/graph/task-class`. Dormant one wave; delete in a follow-up.

**Client code safe to delete:** the 8 panel `.tsx` + tests + HeatPanel-only viz helpers (KEEP
`detectCollisions`/`flappingAgents` — reused by Needs-you). Keep `lib/insights.ts`.

**Redirects** (no react-router; view = `setView` state, possibly persisted): alias map in
`MainContent` coercing dead keys: `automation|activity-heatmap|scoreboard|heat|topology → omp-graph`;
`fleet-health → cockpit`; `federation → org`; `knowledge → omp-graph` (+auto-open ⌘K). Same map
guards localStorage-persisted `view`.

**Backend bug to fix IN THIS WAVE:** leases for removed agents (ompsq-421..428) showed 22h–4d old —
leases not released on rm/reap and/or TTL not enforced on read. Fix in `leases.ts` TTL enforcement +
squad-manager reap path, with a regression test. Without it the unified collision signal
false-positives on dead holders.

## 4. Unit decomposition (parallel-safe)

- **U1 — Graph inner fold** (`omp-graph/*`): scoreboard→cost tab; lineage→run tab; cadence→loop tab;
  `collision` kind + marker; DEPTH relabel. Accept: live screenshots of each tab + collision glyph
  with a seeded 2-agent clash.
- **U2 — Header + Needs-you fold** (`FactoryStatusStrip`, `factoryStatus.ts`, `AttentionPanel`,
  reuse `insights.ts`/`heatmap.ts`): capacity chip (3 states) + collision/flapping attention rows.
  Accept: chip in all 3 states + an attention collision row.
- **U3 — Shell: nav shrink + ⌘K palette + redirects** (`App.tsx`, `WorkbenchPane`, `GlobalShortcuts`,
  `TaskContext`, new `CommandPalette.tsx`). Accept: 6-item nav (full+collapsed), palette with live
  fabric results, dead-route coercion. LANDS LAST (owns AppView removal); wait for
  fix/sidebar-task-scope + fix/single-artifact-selector to merge first (file overlap).
- **U4 — lease-TTL fix** (backend, independent): reaped/removed agents' leases drop on read;
  regression test.

## 5. Red-team — 3 degradation risks + guards

1. **Inspector-tab sprawl** → each folded signal is a *section inside an existing routed body*,
   never new top-level chrome.
2. **Collision-marker noise** (esp. with the un-reaped-lease bug) → lease-TTL fix ships same wave;
   marker only for ≥2 *live* agents; min-dwell gate.
3. **DEPTH overload** → relabel only, no new marks on the massif; anything more is a `depthMetric`.
   Massif screenshot pixel-unchanged except the toggle word.

## 6. THE UNIFIED FLEET VIEW (addendum — Needs you + Active work + Cockpit → one surface)

**Decision:** WorkspaceCockpit is the chassis; the other two dissolve into it. Roster rail = spine,
center transcript + land rail = detail, urgency = ordering + inline actions. Nav key: `fleet`.

**(a) Roster ordering:** state-GROUPED per reference C: NEEDS YOU (input-blocked + errored,
attentionItems ranking) · LAND READY · WORKING · IDLE/DONE (collapsed). Active-work's plan join =
row line 2 (plan chip + progress); trailing UNSTAFFED PLANS group carries dropped-plan rows.

**(b) Inline answers, two tiers:** roster row renders option buttons inline (AttentionRow grammar,
answer without selection change); detail pane pins the pending question as a banner above the
transcript + Composer prefilled for free text. Same requestId — answering either clears both. Land
stays in the right rail. Row's trailing action chip = activeWorkAction's one-move.

**(c) Active-work salvage:** plan↔agent join → row line 2 + UNSTAFFED; one-action spine → row chip;
fleetActivityRollup → Fleet header (with U2's capacity chip — governance fold lands HERE);
per-plan progress → detail header. AttentionPanel extras (server action items, collision/flapping,
raise-cap) → NEEDS-YOU group rows.

**(d) Empty:** one calm line ("Nothing needs you · fleet idle · room for N") + push toggle. Dense:
IDLE collapses, WORKING virtualizes, NEEDS YOU never collapses; rail filter box + ⌘K jump; default-
select the top NEEDS-YOU row.

**(e) Final nav CONFIRMED: Fleet · Tasks · Graph · Capabilities** + gear (AccountMenu carries
org/settings). `intervene`/`review`/`org` stay routed-into views.

**(f) Units revised:** U1 unchanged. **U2 = Fleet unification** (extend WorkspaceCockpit: groups,
row actions, question banner, header rollup + capacity chip; DELETE AttentionPanel + ActiveWorkPane;
reuse insights/fleetActivity/AttentionRow). U3 shrinks: nav 8→4 + gear + palette + alias map incl.
`attention|active|cockpit → fleet`; lands LAST.

**(g) Red-team:** busy roster buries the blocked agent → NEEDS YOU pinned first, non-collapsible,
glow-badged; count persists in nav badge + FactoryStatusStrip on every view; rail scrolls UNDER the
pinned group header.
