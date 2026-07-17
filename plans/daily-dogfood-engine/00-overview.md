# Dogfood engine (Epic B)

Parent: plans/daily-driver/00-meta.md · Design: plans/daily-driver/DESIGN.md · Evidence: plans/research-t3code/BRIEF.md

## Outcome

The adoption gate in 00-meta.md is a bet, not a hope: this epic makes it measurable. A five-second `glance grr "<gripe>"` capture (CLI verb + one keystroke from the webapp composer + one TUI keybind) means every annoyance Lars hits while dogfooding lands in a durable ledger instead of evaporating; a small set of counters computed from data the daemon already writes (casual sessions/day, prompts/day, push taps/day) turn "is anyone actually using this" into a number instead of a vibe; a weekly drain reads both and appends to the meta-plan's ledger. Two weeks after A-D ship, Lars reads that ledger and signs off SUCCESS or KILL — 03 is that sign-off, MODE: hitl. Nothing here is on a critical path for A/C/D; it exists so the gate has evidence to rule on.

## Work

| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 friction-ledger | `glance grr` CLI verb + composer/TUI affordances + durable append-only ledger; capture must cost <5s or it dies unused | mechanical | src/index.ts, src/friction-log.ts (new), src/types.ts, src/server.ts, webapp/src/components/chat/Composer.tsx, src/tui.ts, tests/ (new) |
| 02 adoption-counters | casual sessions/day, prompts/day, push-taps/day computed from existing receipts/transitions/push data; surfaced via `glance doctor` + a GET endpoint | mechanical | src/doctor.ts, src/doctor-probe.ts, src/server.ts, src/push.ts, webapp/src/ (push-tap beacon, new route handling), tests/ (new) |
| 03 drain-cadence-and-criteria | weekly drain that turns ledger entries into fixes/concerns and appends counter snapshots to the meta ledger; carries the verbatim SUCCESS/KILL criteria and requires Lars's sign-off at gate review | research | plans/daily-driver/00-meta.md (ledger appends only), .claude/skills/ (cadence doc/skill pointer, no new automation required) |

## Order

| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01, 02 | disjoint files (ledger write-path vs. counter read-path) — no cross-dependency, one loop iteration each |
| 2 | 03 | reads BOTH 01's ledger and 02's counters; cannot be written meaningfully until both exist |

## Dependency graph

| Concern | Blocked by | 30s check |
|---|---|---|
| 01 friction-ledger | none | — |
| 02 adoption-counters | none | — |
| 03 drain-cadence-and-criteria | 01, 02 | `grep -n "cmdGrr\|case \"grr\"" src/index.ts` returns a match AND `grep -n "adoption" src/doctor.ts` returns a match — both data sources the drain reads must exist |

## Not yet specified

(none)

## Notes

- This epic is on the adoption path (00-meta.md epic table) but is NOT itself a feature Lars needs to like using — it is instrumentation. Judge it by whether 03's sign-off can actually be made from real numbers, not by its own polish.
- 01 and 02 deliberately ride existing infra rather than inventing a metrics stack: `src/jsonl-log.ts`'s generic `JsonlLog<T>` (already the transitions.jsonl precedent) for the ledger, and `src/receipts.ts` RunReceipt / transitions.jsonl / push.ts payloads for counters — see each concern's Approach for why `automation-log.ts` was considered and passed over.
- Counters are best-effort and self-admittedly approximate (push-taps/day in particular needs a beacon that doesn't exist yet anywhere in the webapp — 02 builds the smallest honest version, not a full analytics pipeline).
- 03 carries the SUCCESS/KILL criteria verbatim from 00-meta.md so gate review never has to reconcile two copies; it does not restate or reinterpret them.
