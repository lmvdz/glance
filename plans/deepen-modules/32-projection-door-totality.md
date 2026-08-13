# Projection quiet-defaults — a policy table four kinds route around
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: moderate
TOUCHES: src/projection-classes.ts (11 of 19 kinds listed; node fallback at 136–141), src/unit-card-projector.ts doorSurface (default "unit" — after PR #381; pre-merge squad-manager.ts:12798), webapp/src/lib/channelTimeline.ts 230–237 (hrefFromPayload synthesizes hrefs only for plan/intervence), bespoke emit sites for voice-call/voice-decision/voice-fleet-action/token-burn-snapshot
MODE: afk

## Goal
Two defects, one lens. (1) The projectionClasses table claims to be the routing policy while
the three voice kinds and token-burn-snapshot are emitted into the room by bespoke sites that
never consult it — the table describes a reality it doesn't govern. Make it total: every kind
in TRANSCRIPT_EVENT_KINDS gets a row (even if the row says "bespoke emitter, see X"), so a new
kind is a compile error, not a quiet node-fallback. (2) doorSurface's `default: "unit"` is a
silently doorless card (the webapp synthesizes no href for it) — replace the default arm with
an exhaustive `doorFor(kind, refs) → href | "no door, because …"`. Blast radii differ: quiet
node-fallback self-corrects, doorless cards don't fail anywhere. Pairs with concern 21's
follow-up (shared card-emit primitive) once #381 merges.

## Provenance
Round-3 review, daemon agent item 2; carried from round-2's candidate inventory.
