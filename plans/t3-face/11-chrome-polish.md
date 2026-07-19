# Chrome polish — the feel carriers a screenshot can't see

STATUS: open
PRIORITY: p2
REPOS: glance-desktop
COMPLEXITY: mechanical
BLOCKED_BY: 03, 05
TOUCHES: src/modules/fleet/* surfaces (empty/loading states, subheaders, hover choreography), copy strings across the fleet module

## Goal

The cockpit's small moments read like t3code: layered-card empty states, unison skeleton loading, `surface-subheader` panel headers, hover-reveal action choreography with pointer-events swaps, and a copy voice pass ("Working for 2m 14s", "You stopped this response", honest state labels). These are individually minor and collectively the difference between "themed" and "belongs."

## Approach

Reference: `/tmp/t3/components_ui_empty.tsx` (icon card + two rotated ghost cards behind = card-stack look), `ui_skeleton.tsx` (fixed-attachment unison sweep — CSS already in concern 01), the Sidebar hover/crossfade idioms.

1. **Empty states**: replace centered gray "No units"/"No sessions" lines with the `Empty`/`EmptyMedia variant=icon`/`EmptyTitle`/`EmptyDescription` pattern (port `ui/empty.tsx` if not already present, HugeIcons for the media). Cover: empty roster, empty transcript, no diff, no leases, unauthorized/unreachable connection states.
2. **Skeletons**: unit rows, transcript, and diff use the `ui/skeleton.tsx` unison sweep while loading/prewarming, instead of spinners or blank panes.
3. **Subheaders**: fleet panel headers adopt `.surface-subheader` (`h-10 border-b border-border/60 bg-background`).
4. **Hover choreography**: row action buttons use the named-group `opacity-0 → group-hover/*:opacity-100` + pointer-events-swap idiom; project/group headers do the chevron↔status-dot crossfade; two-step destructive confirm pill for hand-back/stop where destructive.
5. **Copy pass** (taste lane — copy is in-scope per daily-driver standing requirement 2): audit every user-visible fleet string for t3 voice — durations as "Working for Xs", interrupts as "You stopped…", honest state labels, no dev-jargon. fable/opus authors this pass.

## Cross-Repo Side Effects

None.

## Verify

- Live: trigger each empty/loading state (fresh daemon, no units; selected unit with no diff; disconnected) → layered-card empty + unison skeletons render.
- Hover a unit row → actions reveal with the crossfade; group header chevron↔dot swaps.
- Copy review by the taste lane against t3's voice.
- `pnpm lint && check-types && vitest run && build` green.
