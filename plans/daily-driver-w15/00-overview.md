# Daily driver wave 1.5 — make the loop self-run and legible

Stacked follow-up to `plans/daily-driver/` (wave 1 = PR #194). Branch feat/daily-driver-w15 off feat/daily-driver-w1. Everything here **serves the adoption experiment** — nothing presumes adoption (webapp start-here + notification-prefs UI deliberately deferred until dogfooding says they're wanted; see 00-meta.md's charter discipline).

## Outcome

A human can discover and use the daily-driver features from docs; the dogfood loop captures friction and reports its own numbers without Lars's discipline; and the loop's two invisible signals (friction, adoption counters) become visible in the existing UI.

## Work

| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 operator-docs | you can't dogfood what you can't remember how to invoke | mechanical | README.md, docs/daily-driver.md (new) |
| 02 auto-friction-capture | the ledger only sees typed gripes; the daemon hits real friction constantly (held syncs, ACP timeouts, session-loss) that should populate it automatically | architectural | src/squad-manager.ts, src/friction-log.ts, src/types.ts, .claude/skills/dogfood-drain |
| 03 scheduled-loop | the drain + counter snapshot exist but nothing fires them; a loop that needs Lars to remember won't run | mechanical | .claude/skills/dogfood-drain, plans/daily-driver/00-meta.md, a scheduled routine |
| 04 visibility-panels | the meta calls the adoption counters "the real success metric" — they render nowhere; the friction ledger can't be browsed in-UI | architectural | webapp/src/omp-graph/, webapp/src/components/, a friction view |

## Order

| Batch | Concerns | Why |
|---|---|---|
| 1 | 01, 02, 03, 04 | disjoint TOUCHES (docs / daemon / skill+config / webapp); 03 reads 02's discriminator convention but doesn't block on it |

## Not yet specified

- (none)

## Out of scope (deferred, presume adoption)

- webapp "start a here-session" affordance — dogfooding decides if web-initiated casual threads are wanted
- notification-preferences UI — red team killed the per-viewer version once; revisit on friction evidence

## Notes

- Proportionate gauntlet: this is NOT a data-loss git-write path (wave 1's boundary-sync was). Functional review + a UX gate on 04 + a live-verify that auto-capture fires and the panels render is the right apparatus — not the five-layer boundary-sync cascade.
- Adoption discriminator: FrictionEntry has no source field; auto-captured friction must be distinguishable from human gripes for the drain to bucket them (a `source: "human" | "auto"` field with a migration default, or an `auto:*` context convention — implementer's call, but the drain must bucket them separately and auto-capture must be low-noise: only real friction, never normal operation).
