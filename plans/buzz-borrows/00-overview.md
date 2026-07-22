# Buzz borrows — hive-mind patterns, natively

> **Disposition 2026-07-22**: concerns 01/02/04/05 are superseded-into [plans/the-room](../the-room/00-overview.md) (as its concerns 04/06/03/10 respectively — reshaped by the-room's adversarial round). Concerns 03 (friction distillation), 06 (agent grants), 07 (orch health report) remain live here.


Source: `plans/research-buzz/BRIEF.md`; design rationale in `DESIGN.md` (adversarial round reshaped 2 of 7 concepts).

## Outcome
- A unit's transcript tells the whole story of the unit (lands, gates, merge decisions) — comprehension is one room.
- Dispatched units know what their dependencies produced, at the moment they start.
- The harness learns from repeated friction via human-gated prompt rules.
- No steer is ever silently dropped; @mention-steer is specced for the t3-face lane.
- Agent trust has provenance and a safe revocation path; orchestration quality is measurable from real usage.

## Work
| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| [01 unit-room emits](01-unit-room-emits.md) | Verdicts live in side stores; transcript is blind to lands/gates | architectural | types, squad-manager, land-assessment call sites |
| [02 landed-context at dispatch](02-landed-context-at-dispatch.md) | Dependents re-derive producer results; outbox design was disproven | architectural | squad-manager prompt assembly, land-assessment reads |
| [03 friction distillation](03-friction-distillation.md) | Friction ledger is triage-only; harness repeats known mistakes | mechanical | dogfood-drain skill, DO_NOT conventions |
| [04 steer ack/nack](04-steer-ack-nack.md) | Missing-target/denied steers vanish silently | mechanical | applyCommand, WS path, event union |
| [05 mention composer spec](05-mention-composer-spec.md) | Chat-as-control-plane ergonomic; needs reply-routing spec first | research | webapp composer (t3-face lane) |
| [06 agent grants](06-agent-grants.md) | Agent lifecycle lacks provenance; revocation must be positive-evidence | architectural | db schema, manager-registry (front door only) |
| [07 orch health report](07-orchestration-health-report.md) | Orchestration quality is anecdotal; stores already hold the data | mechanical | read-only report module |

## Order
| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01, 02, 03, 04 | Independent, daemon-side, all p1; no shared TOUCHES except squad-manager (01 land path vs 02 prompt assembly vs 04 applyCommand — distinct regions, sequential merge) |
| 2 | 06, 07 | p2, independent of batch 1 and each other |
| t3-face lane | 05 | Owned by t3-face sequencing (2026-07-18 LOVED-state directive); blocked on 04's nack |

## Dependency graph
| Concern | Blocked by | 30s check |
|---|---|---|
| 01 | — | — |
| 02 | — | — |
| 03 | — | — |
| 04 | — | — |
| 05 | 04 | `grep -n "command-ack" src/types.ts` returns a hit (04 landed) |
| 06 | — | — |
| 07 | — | — |

## Not yet specified
- (none)

## Out of scope
- Durable agent-to-agent outbox with watermarks — recipient set structurally empty per the requiresConflict spawn gate; revisit only if a measured coexistence pattern appears — see DESIGN.md
- Per-org events.jsonl event substrate / EVENT_KINDS registry — single consumer after the outbox cut; earns existence at a second consumer — see DESIGN.md
- Reaper-coupled revocation (protectedIds subtraction, expires_at) — re-arms the PR #217 friendly-fire class; permanently rejected, not deferred — see DESIGN.md
- Synthetic benchmark fixtures on scratch-daemon — rot precedent + contamination scar; only if real-usage signal proves insufficient — see 07
- Dispatch-loop nudge of units with unread context — full LLM turn for an FYI with no action path — cut in review
- Cross-host FederationBus routing of unit results — real design work of its own; the seam is documented, nothing built

## Decisions so far
- [DESIGN.md](DESIGN.md) — adversarial round (2 fable red teams, 26 findings) killed the outbox and reaper-coupled grants; replacements are dispatch-time context and remove()-driven revocation

## Notes
- auto-approved: headless (background job; /research → /plan pipeline). EXPLORE, DESIGN, and DECOMPOSE gates recorded as checkpoints per skill policy; EXECUTE not started — terminal state is this decomposed plan.
- Phase 0 WIP snapshot: proceeded over 26 plans with open work (108 open concerns) — pipeline invocation, debt logged for the next interactive /plan.
- Assumption made headless: concern 05 filed here as spec-first but execution ownership assigned to the t3-face lane per the 2026-07-18 sequencing directive; move it into that plan's docs if preferred.
- Not filed to Plane yet — offer /plan-to-plane at review.
