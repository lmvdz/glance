# Acceptance audit — falsifiable "feels like t3code"

STATUS: cancelled
PRIORITY: p1
REPOS: glance-desktop
COMPLEXITY: research
BLOCKED_BY: 07, 08, 09, 10, 11, 12
TOUCHES: none (verification + report)

## Goal

Prove — falsifiably, not by vibes — that the cockpit feels like t3code and shares one design system. Replaces the draft's vacuous "side-by-side screenshot" bar (screenshots can't see hover choreography, pulse duty-cycles, switch latency, or fold flicker; and roster/intervene have no t3 analog to sit beside).

## Approach

Per-surface protocol, run against a `scratch-daemon`-isolated glance instance driven via `agent-browser`, in BOTH the main and settings webviews, and explicitly including the **Linux WebKitGTK** target (glass/grain/skeleton-sweep are historically janky there — this is where the concern-01 kill switch decision gets made).

**Analog surfaces** (composer, timeline, markdown) — compare to a LIVE t3code reference: `npx t3@latest` in a throwaway repo (free, BYOK). Capture **video**, not stills:
- hover-reveal choreography and crossfades present and timed like t3 (~150ms)
- `status-pulse`/`status-ping` duty-cycles match (stepped, not sine)
- turn-fold does not flicker across the turn-settle window
- prewarmed unit switch < 100 ms to painted transcript (measured)

**No-analog surfaces** (roster/spine, intervene, gate chips, lease card):
1. **Grep gate**: `grep -rInE '(bg|text|border|ring|from|to)-(gray|zinc|slate|neutral|emerald|red|amber|sky|green)-[0-9]' src/modules/fleet` returns zero — every color resolves to a t3face token.
2. **State coverage**: empty / loading / hover / error states specified and present on each surface.
3. **Blind provenance test**: a strongest-model reviewer (taste ≥ 7 — opus/fable, plus grok as an independent second pass per model policy) shown cropped components from both apps cannot reliably say which app each came from. That is the falsifiable "same design system" criterion.

**The real gate is Lars's reaction on the three spine surfaces** (spine, timeline, composer) — everything above is instrumentation for that judgment, not a substitute. Report captures + the checklist results; Lars makes the call.

## Cross-Repo Side Effects

None.

## Verify

- Report exists with: video captures of analog surfaces vs live t3code; grep-gate output (zero); per-surface state coverage table; blind-provenance results; switch-latency measurement; WebKitGTK render notes + kill-switch decision.
- Any failure loops back to the owning concern as a new finding (Phase 5c).

## Resolution
Parked 2026-07-22 — glance-desktop is superseded (unused, non-working; Lars directive,
the-room design gate). 13's acceptance protocol lives on re-targeted at the webapp room as
plans/the-room/23-love-gate.md; the reskin's visual work is harvested into
plans/the-room/CRAFT-HARVEST.md (concern 21). See plans/the-room/24-supersessions-amendment.md.
