# attention-autonomy — the self-managing Needs-You lane

STATUS: open
PRIORITY: p0
REPOS: omp-squad (primary); glance-desktop Daily-panel rendering tracks separately per the staged-additive rule

## Why (Lars, 2026-07-18, verbatim intent)

"I don't want to have to manage any of this… the only point where a human should be needed is to plan,
review the plan, and comprehension (through before/after HTML digest/infographics)."

Trigger incident: 5 units sat in Needs-You for ~50 hours with no legible reason. Root cause is
structural, verified in code: `maybeAutoSupervise` (squad-manager.ts:7113) fires ONCE at
request-add time; nothing in the system ever ages, re-triages, aggregates, or expires an attention
item afterward. `PendingRequest.createdAt` (types.ts:93) has zero consumers. Escalation is a
terminal state meaning "wait for Lars, unbounded."

## Outcome

The Needs-You lane is near-empty BY DESIGN. Every attention item is born with a lifecycle: it gets
auto-triaged at T1, and by T2 it has been resolved, converted to one plan-shaped decision, or
consolidated into a digest with provenance. A 50-hour zombie becomes structurally impossible.
What reaches Lars is only: plan review, one aggregated decision, comprehension artifacts, or a
structural escalation that survived its caps. Residue-count-over-time is the program's grade.

## TTL table (defaults, env-tunable OMP_SQUAD_ATTENTION_TTL_*)

| Tier | Auto-triage at (T1) | Expiry action (T2) |
|---|---|---|
| error | 15 min | 24 h → park + close-with-note → digest |
| awaiting-input (non-gate) | 30 min | 24 h → close-with-note → digest |
| pending-approval (gate-class) | never auto-answered; aggregate immediately (04) | 24 h → converts to ONE plan-shaped decision item; never silently expires |
| notify events (land-blocked, cost-ask, membrane) | already post-cap escalations | 72 h → repeat folds into digest, leaves the lane |
| completed-unseen | — | 24 h → system-visited stamp with digest provenance |

## Work

| Concern | Why | Complexity | Trust-sensitive |
|---|---|---|---|
| [P0 ompsq-450-hygiene](p0-ompsq-450-hygiene.md) | substrate races/growth under everything below | S | no |
| [01 attention-lifecycle](01-attention-lifecycle.md) | items get birth/TTL/resolution state; kills the zombie class | M | no |
| [02 answer-policy](02-answer-policy.md) | THE trust core: fail-closed gate taxonomy + precedent evidence bar | M | YES — full gauntlet |
| [03 auto-triage](03-auto-triage.md) | resolve instead of expire: classify → answer/restart/reroute/absorb/close | L | `answer` action only |
| [04 gate-aggregation](04-gate-aggregation.md) | N same-class gates → ONE decision; fan-out fail-closed | M | fan-out matcher only |
| [05 decay-into-digest](05-decay-into-digest.md) | the comprehension delivery: before/after funnel + episode section | M | no |
| [06 residue-contract](06-residue-contract.md) | violations are SYSTEM findings, never human chores | S | no |

## Order

- Serialized spine: P0 → 01 → (03 wiring, 05 consumer, 06 counters).
- 02 starts immediately in parallel (longest review tail: grok+codex gauntlet + blind review).
- 04, 05, 06 mutually independent once 01 lands. 03 lands last (consumes 01+02); may ship early
  with `answer` disabled (restart/absorb/close only) if 02 is still in gauntlet.
- Leverage: 01 > 02 > 03 > 05 > 04 > 06 > P0 (small but first).

## Residue contract (enforced, not prose)

Only these may reach the human lane: (1) plan review/approval; (2) an 04-aggregated decision item;
(3) comprehension artifacts; (4) structural escalations that survived their caps. Invariant:
needs-you count > K (default 3) OR oldest item age > A (default 24h) ⇒ self-audit finding naming
which lifecycle stage failed — a bug report against this system, never a chore for Lars.

## Decisions needed at plan review (Lars)

1. TTL defaults table above — sign off or adjust.
2. Residue invariant K=3 / A=24h.
3. The 02 evidence bar: precedent-based auto-answer (system repeats a decision you made on an
   identical (kind, title-class, option-set) tuple, citing the precedent) — in or out?
4. Confirm the structurally-human ceiling list (gate-class, tool-source, risky, cost/spend,
   plan-approval, outward/irreversible) — anything to add?

## Provenance

Designed 2026-07-18 by a fable-5 Plan pass over the live code (attention.ts, attention-ladder.ts,
squad-manager.ts escalation writers + maybeAutoSupervise, supervisor.ts, resolver.ts, answers.ts,
opportunity.ts, weekly-episode.ts, watchdog.ts, validator.ts:812). Reuses existing organs
(answer-units, jaccard clustering, deterministic episode projection, janitor-loop idiom,
gateClassOf tighten-only, decision capture, failure memory, per-hour budgets) rather than
rebuilding. R7 #157 (approve-bias hole) and the blind-review absence-invariant are named design
constraints on 02.
